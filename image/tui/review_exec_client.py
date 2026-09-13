from __future__ import annotations

import os
from typing import Any, Mapping

from tui.broker_protocol import send_client_request

SOCKET_ENV = "BLUEFIN_REVIEW_EXEC_SOCKET"
SESSION_ENV = "BLUEFIN_REVIEW_EXEC_SESSION"


def request(payload: Mapping[str, Any], timeout: float = 30.0) -> dict[str, Any]:
    path = os.environ.get(SOCKET_ENV, "")
    session = os.environ.get(SESSION_ENV, "")
    if not path or not session:
        raise RuntimeError("review-exec broker is not configured")
    return send_client_request(path, session, payload, timeout=timeout)

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
