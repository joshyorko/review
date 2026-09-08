"""The container's half of the optional lab broker (#379).

The lab is a maintainer's own Kubernetes cluster, and this appliance owns no
lab and depends on none. What the launcher hands the container is therefore
not a credential, a cluster configuration file, or a host binary: it is one
private Unix socket whose other end runs on the host, holds all of that, and
answers exactly three typed questions — ``status``, ``health``, and
``submit``.

Everything here is failure-shaped on purpose. A missing socket, a broker that
died, a timeout, a truncated answer, a protocol error: every one of them
comes back as ``DEGRADED`` with a reason. None of them comes back looking
like a successful empty answer, because a clean-looking empty answer is how a
review silently loses its evidence and reports something it never checked.
"""

from __future__ import annotations

import json
import os
import socket

PROTOCOL_VERSION = 1

# The dashboard polls status coarsely (30s) and a health snapshot runs while
# a maintainer waits, so the timeouts differ: the poll must never wedge the
# UI thread's worker, and the snapshot may take a few seconds of real cluster
# reads. Submitting is one workflow dispatch the host performs.
STATUS_TIMEOUT = 5.0
HEALTH_TIMEOUT = 30.0
SUBMIT_TIMEOUT = 30.0

# The broker bounds its own response; this bounds what a compromised or
# confused peer can make the container allocate.
MAX_RESPONSE_BYTES = 262_144

# The launcher passes these two and nothing else. Their absence IS the
# off state: no socket, no session, no lab.
SOCKET_ENV = "BLUEFIN_REVIEW_LAB_SOCKET"
SESSION_ENV = "BLUEFIN_REVIEW_LAB_SESSION"

# The four states the UI renders. OFF is a container-side fact (the launcher
# mounted no socket, or the maintainer declined); READY and DEGRADED come
# from the broker; ACTIVE is a projection the dashboard computes from a
# status answer, never a state the broker asserts on its own.
LAB_OFF = "OFF"
LAB_READY = "READY"
LAB_DEGRADED = "DEGRADED"
LAB_ACTIVE = "ACTIVE"


def lab_socket() -> str:
    """The socket the launcher mounted, or "" when the lab is off."""
    return os.environ.get(SOCKET_ENV, "")


def lab_session() -> str:
    return os.environ.get(SESSION_ENV, "")


def lab_configured() -> bool:
    """Whether this dashboard process was given a lab at all.

    A socket path that does not exist is not configured: the launcher
    removes the socket when the broker stops, so a stale environment
    variable must not make the dashboard advertise a lab it cannot reach.
    """
    path = lab_socket()
    return bool(path) and os.path.exists(path)


def _degraded(reason: str) -> dict:
    return {"ok": False, "state": LAB_DEGRADED, "error": "unreachable", "detail": reason}


def request(payload: dict, timeout: float) -> dict:
    """One request, one response, one connection.

    Returns the broker's parsed answer, or a DEGRADED envelope. This never
    raises: the caller is a review, and a review that dies because a lab is
    missing is exactly the dependency this appliance refuses to have.
    """
    path = lab_socket()
    if not path:
        return {"ok": False, "state": LAB_OFF, "error": "off", "detail": "no lab socket"}
    body = json.dumps(
        {"version": PROTOCOL_VERSION, "session": lab_session(), **payload},
        separators=(",", ":"),
    ).encode("utf-8")
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(timeout)
            client.connect(path)
            client.sendall(body + b"\n")
            # The broker answers one line and closes; read until it does or
            # until the bound is hit, so a peer that never stops talking
            # cannot exhaust this process.
            chunks: list[bytes] = []
            size = 0
            while True:
                chunk = client.recv(65_536)
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
                if size > MAX_RESPONSE_BYTES:
                    return _degraded("broker answer exceeded the response bound")
                if b"\n" in chunk:
                    break
    except (OSError, socket.timeout) as error:
        return _degraded(f"{type(error).__name__}: {error}")
    raw = b"".join(chunks).split(b"\n", 1)[0]
    try:
        answer = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        return _degraded(f"unparseable broker answer: {error}")
    if not isinstance(answer, dict):
        return _degraded("broker answer was not an object")
    if answer.get("version") != PROTOCOL_VERSION:
        return _degraded(f"unsupported broker protocol {answer.get('version')!r}")
    if not answer.get("ok"):
        # A protocol-level refusal is the broker working correctly, but it is
        # still not evidence, so it degrades rather than passing for a result.
        answer.setdefault("state", LAB_DEGRADED)
    return answer


def status() -> dict:
    return request({"action": "status"}, STATUS_TIMEOUT)


def health(repository: str, pr: int, head: str) -> dict:
    return request(
        {"action": "health", "repository": repository, "pr": pr, "head": head},
        HEALTH_TIMEOUT,
    )


def submit(repository: str, pr: int, head: str, profile: str) -> dict:
    return request(
        {
            "action": "submit",
            "repository": repository,
            "pr": pr,
            "head": head,
            "profile": profile,
        },
        SUBMIT_TIMEOUT,
    )


def usb4_ready(usb4: dict) -> bool:
    """Both Thunderbolt links up, both observations fresh.

    The broker decides freshness (45 seconds) because it holds the clock the
    annotations were written against; this only refuses anything short of
    both nodes reporting `up`. A missing, malformed, or future-dated
    observation reaches here as a non-`up` value or `fresh: false`.
    """
    if not isinstance(usb4, dict) or not usb4.get("fresh"):
        return False
    return all(usb4.get(node) == "up" for node in ("ghost", "exo-0"))


def lab_state(answer: dict) -> str:
    """The state the status area renders.

    `ACTIVE` is the conjunction the issue spells out: a Review-bound
    workflow is actually running AND both USB4 links are up and fresh.
    Anything else falls back to the text state, which is always authoritative
    — the lightning bolt is decoration over it, never the carrier.
    """
    if not isinstance(answer, dict) or not answer.get("ok"):
        return LAB_DEGRADED if answer else LAB_OFF
    state = str(answer.get("state") or LAB_DEGRADED)
    if state != LAB_READY:
        return LAB_DEGRADED
    if answer.get("active") and usb4_ready(answer.get("usb4") or {}):
        return LAB_ACTIVE
    return LAB_READY
