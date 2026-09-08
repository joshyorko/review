from __future__ import annotations

import json
import os
import socket
from typing import Any, Mapping

SOCKET_ENV = "BLUEFIN_REVIEW_EXEC_SOCKET"
SESSION_ENV = "BLUEFIN_REVIEW_EXEC_SESSION"


def request(payload: Mapping[str, Any], timeout: float = 30.0) -> dict[str, Any]:
    path = os.environ.get(SOCKET_ENV, "")
    session = os.environ.get(SESSION_ENV, "")
    if not path or not session:
        raise RuntimeError("review-exec broker is not configured")
    message = json.dumps(
        {"version": 1, "session": session, **dict(payload)},
        separators=(",", ":"),
    ).encode() + b"\n"
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(timeout)
        client.connect(path)
        client.sendall(message)
        data = bytearray()
        while not data.endswith(b"\n"):
            block = client.recv(65536)
            if not block:
                break
            data.extend(block)
    answer = json.loads(bytes(data).decode("utf-8"))
    if not isinstance(answer, dict):
        raise RuntimeError("review-exec response is not an object")
    return answer


def submit(repository: str, number: int, base_sha: str, head_sha: str, backend: str, model: str, effort: str) -> dict[str, Any]:
    return request({
        "action": "submit",
        "repository": repository,
        "number": number,
        "base_sha": base_sha,
        "head_sha": head_sha,
        "backend": backend,
        "model": model,
        "effort": effort,
    })


def status() -> dict[str, Any]:
    return request({"action": "status"})


def logs(job: str) -> dict[str, Any]:
    return request({"action": "logs", "job": job})


def cancel(job: str) -> dict[str, Any]:
    return request({"action": "cancel", "job": job})
