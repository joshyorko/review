# scripts/broker_protocol.py
"""Re-export of image/tui/broker_protocol for host scripts (#492)."""

from __future__ import annotations

import sys
from pathlib import Path

# Add image/ to sys.path so tui package is resolvable
_image_root = str(Path(__file__).resolve().parents[1] / "image")
if _image_root not in sys.path:
    sys.path.insert(0, _image_root)

from tui.broker_protocol import (  # noqa: E402
    MAX_DRAIN_BYTES,
    MAX_REQUEST_BYTES,
    MAX_RESPONSE_BYTES,
    PROTOCOL_VERSION,
    READ_TIMEOUT_SECONDS,
    RECV_CHUNK_BYTES,
    WRITE_TIMEOUT_SECONDS,
    BrokerHandler,
    BrokerServer,
    Rejected,
    bounded_response,
    decode_request,
    error_payload,
    json_line,
    ok_payload,
    prepare_socket_path,
    read_request_line,
    send_client_request,
)

__all__ = [
    "MAX_DRAIN_BYTES",
    "MAX_REQUEST_BYTES",
    "MAX_RESPONSE_BYTES",
    "PROTOCOL_VERSION",
    "READ_TIMEOUT_SECONDS",
    "RECV_CHUNK_BYTES",
    "WRITE_TIMEOUT_SECONDS",
    "BrokerHandler",
    "BrokerServer",
    "Rejected",
    "bounded_response",
    "decode_request",
    "error_payload",
    "json_line",
    "ok_payload",
    "prepare_socket_path",
    "read_request_line",
    "send_client_request",
]
