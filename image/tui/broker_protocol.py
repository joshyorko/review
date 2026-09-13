# image/tui/broker_protocol.py
"""Shared unix-socket broker wire protocol for container-side clients and host brokers (#492).

Consolidated protocol framing, request decoding, error handling,
server base classes, and client communications used by both review brokers
(review-exec-broker, review-lab-broker) and both container-side clients
(review_exec_client, lab_client).
"""

from __future__ import annotations

import contextlib
import hmac
import json
import os
import socket
import socketserver
from typing import Any, Mapping, Sequence

PROTOCOL_VERSION = 1

MAX_REQUEST_BYTES = 65536
MAX_RESPONSE_BYTES = 262144

READ_TIMEOUT_SECONDS = 5.0
WRITE_TIMEOUT_SECONDS = 30.0
RECV_CHUNK_BYTES = 8192
MAX_DRAIN_BYTES = 4 * 1024 * 1024


class Rejected(Exception):
    """A request the protocol refuses. Carries the wire error code."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


def error_payload(code: str, detail: str) -> dict[str, Any]:
    return {
        "version": PROTOCOL_VERSION,
        "ok": False,
        "error": code,
        "detail": detail,
    }


def ok_payload(**fields: Any) -> dict[str, Any]:
    payload = {"version": PROTOCOL_VERSION, "ok": True}
    payload.update(fields)
    return payload


def json_line(payload: Any) -> bytes:
    return json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8") + b"\n"


def decode_request(
    raw: bytes,
    session: str,
    actions: Sequence[str] | set[str] | frozenset[str],
) -> dict[str, Any]:
    """Decode and validate an incoming request against protocol version, session, and action set."""
    if len(raw) > MAX_REQUEST_BYTES:
        raise Rejected("bad-request", f"request exceeds {MAX_REQUEST_BYTES} bytes")
    try:
        request = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise Rejected("bad-request", "request is not valid JSON")
    if not isinstance(request, dict):
        raise Rejected("bad-request", "request is not a JSON object")
    version = request.get("version")
    if not isinstance(version, int) or isinstance(version, bool):
        raise Rejected("bad-request", "version is missing or not an integer")
    if version != PROTOCOL_VERSION:
        raise Rejected("unsupported-version", f"this broker speaks version {PROTOCOL_VERSION}")
    action = request.get("action")
    if not isinstance(action, str) or not action:
        raise Rejected("bad-request", "action is missing or not a string")
    if action not in actions:
        sorted_actions = ", ".join(sorted(actions))
        raise Rejected("unknown-action", f"actions are {sorted_actions}")
    req_session = request.get("session")
    if not isinstance(req_session, str) or not req_session:
        raise Rejected("bad-request", "session is missing or not a string")
    if not hmac.compare_digest(req_session, session):
        raise Rejected("wrong-session", "request session does not match this broker")
    return request


def read_request_line(connection) -> bytes | None:
    """Read one newline-terminated request, capped and drained.

    Accumulation stops one byte past the cap so `decode_request` can answer
    `bad-request`, but the rest of the line is still read: a client that is
    told its request is too large should hear that, not a reset connection.
    """
    buffer = bytearray()
    drained = 0
    received = False
    while True:
        chunk = connection.recv(RECV_CHUNK_BYTES)
        if not chunk:
            return bytes(buffer) if received else None
        received = True
        drained += len(chunk)
        newline = chunk.find(b"\n")
        if newline >= 0:
            chunk = chunk[:newline]
        room = MAX_REQUEST_BYTES + 1 - len(buffer)
        if room > 0:
            buffer.extend(chunk[:room])
        if newline >= 0 or drained > MAX_DRAIN_BYTES:
            return bytes(buffer)


def bounded_response(payload: dict[str, Any]) -> bytes:
    """Serialize payload within wire bounds, falling back to minimal error line if exceeded."""
    line = json_line(payload)
    if len(line) <= MAX_RESPONSE_BYTES:
        return line
    minimal = error_payload("response-too-large", "response exceeded byte cap")
    return json_line(minimal)


class BrokerHandler(socketserver.BaseRequestHandler):
    """Base socket handler implementing capped read, dispatch, and bounded send."""

    def handle(self) -> None:
        connection = self.request
        try:
            connection.settimeout(READ_TIMEOUT_SECONDS)
            raw = read_request_line(connection)
        except OSError:
            return
        if raw is None:
            return
        payload = self.server.dispatch_request(raw)
        line = self.server.bound_response(payload)
        try:
            connection.settimeout(WRITE_TIMEOUT_SECONDS)
            connection.sendall(line)
        except OSError:
            return


class BrokerServer(socketserver.ThreadingUnixStreamServer):
    """Base threaded UNIX stream server for brokers."""

    daemon_threads = True
    allow_reuse_address = False

    def __init__(
        self,
        path: str,
        handler_cls: type[socketserver.BaseRequestHandler] = BrokerHandler,
    ) -> None:
        super().__init__(path, handler_cls)

    def dispatch_request(self, raw: bytes) -> dict[str, Any]:
        raise NotImplementedError

    def bound_response(self, payload: dict[str, Any]) -> bytes:
        return bounded_response(payload)

    def handle_error(self, request, client_address) -> None:
        return


def prepare_socket_path(path: str) -> None:
    directory = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(directory, mode=0o700, exist_ok=True)
    if os.path.exists(path):
        with contextlib.suppress(OSError):
            os.unlink(path)


def send_client_request(
    socket_path: str,
    session: str,
    payload: Mapping[str, Any],
    timeout: float = 30.0,
    max_response_bytes: int = MAX_RESPONSE_BYTES,
) -> dict[str, Any]:
    """Client-side request: connect, send one line, receive until newline, parse JSON dict."""
    body = json.dumps(
        {"version": PROTOCOL_VERSION, "session": session, **dict(payload)},
        separators=(",", ":"),
    ).encode("utf-8") + b"\n"
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(timeout)
        client.connect(socket_path)
        client.sendall(body)
        chunks: list[bytes] = []
        size = 0
        while True:
            chunk = client.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size > max_response_bytes:
                raise RuntimeError("broker answer exceeded the response bound")
            if b"\n" in chunk:
                break
    raw = b"".join(chunks).split(b"\n", 1)[0]
    try:
        answer = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        raise RuntimeError(f"unparseable broker answer: {error}") from error
    if not isinstance(answer, dict):
        raise RuntimeError("broker answer is not an object")
    return answer
