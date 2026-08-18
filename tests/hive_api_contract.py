#!/usr/bin/env python3
"""Executable contract for the dashboard's Hive HTTP client."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "image" / "tui"))

import hive_api


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


class Handler(BaseHTTPRequestHandler):
    login_posts = 0

    def log_message(self, *_args) -> None:
        pass

    def _reply(self, code: int, body: bytes, content_type: str = "application/json") -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        cases = {
            "/ok": (200, b'{"hub":"online"}', "application/json"),
            "/auth": (401, b'{"error":"bad token"}', "application/json"),
            "/forbidden": (403, b'{"error":"no standing"}', "application/json"),
            "/login-edge": (302, b"", "text/html"),
            "/html": (200, b"<html>login</html>", "text/html"),
            "/broken-json": (200, b'{"hub":', "application/json"),
            "/server": (503, b'{"error":"maintenance"}', "application/json"),
        }
        code, body, content_type = cases[self.path]
        if self.path == "/login-edge":
            self.send_response(code)
            self.send_header("Location", "/login")
            self.end_headers()
            return
        self._reply(code, body, content_type)

    def do_POST(self) -> None:
        if self.path == "/queue-redirect":
            self.send_response(302)
            self.send_header("Location", "/login")
            self.end_headers()
            return
        if self.path == "/login":
            type(self).login_posts += 1
            self._reply(200, b'{"status":"queued"}')
            return
        if self.path == "/queue-false-success":
            self._reply(200, b'{"status":"error","error":"not queued"}')
            return
        self._reply(200, b'{"status":"queued"}')


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"
    try:
        expected = {
            "/auth": "authentication rejected (401)",
            "/forbidden": "authorization rejected (403)",
            "/login-edge": "API routing redirected (302)",
            "/html": "malformed API response",
            "/broken-json": "malformed API response",
            "/server": "Hive server error (503)",
        }
        ok = hive_api.request(f"{base}/ok", "secret-token")
        check(ok.ok and ok.data == {"hub": "online"}, f"valid JSON failed: {ok}")
        for path, message in expected.items():
            result = hive_api.request(f"{base}{path}", "secret-token")
            check(not result.ok, f"{path} must fail")
            check(result.message == message, f"{path}: {result.message!r}")
            check("secret-token" not in json.dumps(result.as_dict()), "token leaked")
            check(len(json.dumps(result.as_dict())) < 600, "error is not bounded")

        missing = hive_api.request(f"{base}/ok", "")
        check(missing.message == "authentication token missing", str(missing))
        network = hive_api.request("http://127.0.0.1:1/status", "secret-token", timeout=0.1)
        check(network.message == "network error", str(network))

        env = {**os.environ, "GH_TOKEN": "secret-token"}
        helper = str(ROOT / "image" / "tui" / "hive_api.py")
        redirected = subprocess.run(
            [sys.executable, helper, "queue", f"{base}/queue-redirect"],
            capture_output=True,
            text=True,
            env=env,
            timeout=5,
        )
        check(redirected.returncode != 0, "redirected mutation must fail")
        check("API routing redirected (302)" in redirected.stderr, redirected.stderr)
        check(Handler.login_posts == 0, "mutating POST was replayed against login")
        check("secret-token" not in redirected.stderr, "CLI leaked token")

        false_success = subprocess.run(
            [sys.executable, helper, "queue", f"{base}/queue-false-success"],
            capture_output=True,
            text=True,
            env=env,
            timeout=5,
        )
        check(false_success.returncode != 0, "non-queued response must fail")
        check("queued" not in false_success.stdout, "false queued output")

        queued = subprocess.run(
            [sys.executable, helper, "queue", f"{base}/queue-ok"],
            capture_output=True,
            text=True,
            env=env,
            timeout=5,
        )
        check(queued.returncode == 0, queued.stderr)
        check(json.loads(queued.stdout) == {"status": "queued"}, queued.stdout)
    finally:
        server.shutdown()
        server.server_close()

    print("hive API contract: PASS")


if __name__ == "__main__":
    main()
