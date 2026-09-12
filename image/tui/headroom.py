"""Bounded Headroom telemetry client and per-backend routing session model.

The dashboard optionally routes Codex traffic through a launcher-owned
Headroom proxy on loopback. Every read is bounded: a sub-second timeout, a
hard byte cap, JSON-object-only parsing, and strict counter validation. The
proxy is shared infrastructure, so its counters are cumulative; the first
valid sample is the session baseline and every number the model reports is a
`proxy delta` against that baseline, never a per-review saving.
"""

from __future__ import annotations

import http.client
import json
import math
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Mapping
from urllib.parse import urlsplit

HEADROOM_ENV = "BLUEFIN_REVIEW_HEADROOM_URL"
HEADROOM_TIMEOUT_SECONDS = 0.5
HEADROOM_MAX_RESPONSE_BYTES = 65_536
HEADROOM_STATS_PATH = "/stats?cached=1"
HEADROOM_READY_PATH = "/readyz"
HEADROOM_MAX_JSON_DEPTH = 16

VALID_STATES = frozenset({"ACTIVE", "DIRECT", "DEGRADED"})
VALID_METHODS = frozenset({"measured", "estimated", "modelled"})

CAVEMAN_INSTRUCTIONS = (
    "Minimum tokens. Fragments fine. No preamble, no postamble, no restating "
    "context, no rationale. Answer, smallest-possible edits, nothing else. "
    "Never drop anything the turn or task needs to be correct, including "
    "negations (not, never, no, only, except). Use full prose for destructive "
    "or irreversible actions, security warnings, and any multi-step sequence "
    "where brevity would create ambiguity."
)

_BACKEND_NAMES = {"omp": "OMP", "codex": "Codex"}


class HeadroomError(Exception):
    """A Headroom read, parse, or validation failure."""


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuse HTTP redirects so loopback requests never escape loopback."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

    def http_error_301(self, req, fp, code, msg, headers):
        raise urllib.error.HTTPError(req.full_url, code, f"HTTP 301", headers, fp)

    def http_error_302(self, req, fp, code, msg, headers):
        raise urllib.error.HTTPError(req.full_url, code, f"HTTP 302", headers, fp)

    http_error_303 = http_error_307 = http_error_308 = http_error_302


_LOOPBACK_OPENER = urllib.request.build_opener(
    urllib.request.ProxyHandler({}),
    _NoRedirectHandler(),
)
_ORIGINAL_URLOPEN = urllib.request.urlopen


@dataclass(frozen=True)
class HeadroomDelta:
    requests: int
    tokens_saved: int
    output_tokens_saved: int


@dataclass(frozen=True)
class HeadroomStats:
    requests: int
    tokens_saved: int
    output_tokens_saved: int
    output_reduction_percent: float | None
    output_reduction_method: str | None

    def delta_from(self, baseline: HeadroomStats) -> HeadroomDelta:
        delta = HeadroomDelta(
            self.requests - baseline.requests,
            self.tokens_saved - baseline.tokens_saved,
            self.output_tokens_saved - baseline.output_tokens_saved,
        )
        if min(delta.requests, delta.tokens_saved, delta.output_tokens_saved) < 0:
            raise HeadroomError("Headroom counters decreased")
        return delta


@dataclass(frozen=True)
class HeadroomRoute:
    state: str
    backend: str
    base_url: str | None
    reason: str

    def __post_init__(self):
        if self.state not in VALID_STATES:
            raise ValueError(f"unknown Headroom route state {self.state!r}")


def _normalize_base_url(url: str) -> str:
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError as error:
        raise HeadroomError(f"invalid Headroom URL {url!r}: {error}") from error
    if (
        parts.scheme != "http"
        or parts.hostname != "127.0.0.1"
        or parts.username is not None
        or parts.password is not None
        or parts.path not in ("", "/")
        or parts.query
        or parts.fragment
        or port is None
        or not 1 <= port <= 65_535
    ):
        raise HeadroomError(
            f"Headroom URL {url!r} is not the launcher-owned loopback form "
            "http://127.0.0.1:<port>"
        )
    return f"http://127.0.0.1:{port}"


class HeadroomClient:
    """Bounded reader for one normalized loopback Headroom base URL."""

    def __init__(self, base_url: str):
        self.base_url = _normalize_base_url(base_url)
        self.requested_paths: list[str] = []

    def ready(self) -> bool:
        try:
            self._fetch(HEADROOM_READY_PATH)
        except HeadroomError:
            return False
        return True

    def stats(self) -> HeadroomStats:
        return _parse_stats(self._fetch(HEADROOM_STATS_PATH))

    def _fetch(self, path: str) -> bytes:
        self.requested_paths.append(path)
        request = urllib.request.Request(self.base_url + path)
        try:
            if urllib.request.urlopen is not _ORIGINAL_URLOPEN:
                open_fn = urllib.request.urlopen
            else:
                open_fn = _LOOPBACK_OPENER.open
            with open_fn(request, timeout=HEADROOM_TIMEOUT_SECONDS) as response:
                status = getattr(response, "status", None) or response.getcode()
                body = response.read(HEADROOM_MAX_RESPONSE_BYTES + 1)
        except (urllib.error.URLError, OSError, http.client.HTTPException, ValueError) as error:
            raise HeadroomError(f"Headroom {path} request failed: {error}") from error
        if not 200 <= status < 300:
            raise HeadroomError(f"Headroom {path} returned HTTP {status}")
        if len(body) > HEADROOM_MAX_RESPONSE_BYTES:
            raise HeadroomError(f"Headroom {path} exceeded {HEADROOM_MAX_RESPONSE_BYTES} bytes")
        return body


def _check_depth(value: object, depth: int = 1) -> None:
    if depth > HEADROOM_MAX_JSON_DEPTH:
        raise HeadroomError("Headroom stats payload is nested too deeply")
    children: object = ()
    if isinstance(value, dict):
        children = value.values()
    elif isinstance(value, list):
        children = value
    for child in children:
        _check_depth(child, depth + 1)


def _counter(data: dict, section: str, field: str) -> int:
    section_data = data.get(section)
    if not isinstance(section_data, dict):
        raise HeadroomError(f"Headroom stats section {section!r} is missing")
    value = section_data.get(field)
    if isinstance(value, bool) or not isinstance(value, int):
        raise HeadroomError(f"Headroom stats field {section}.{field} is not an integer")
    if value < 0:
        raise HeadroomError(f"Headroom stats field {section}.{field} is negative")
    return value


def _output_reduction(tokens: dict) -> tuple[float | None, str | None]:
    reduction = tokens.get("output_reduction")
    if reduction is None:
        return None, None
    if not isinstance(reduction, dict):
        raise HeadroomError("Headroom output_reduction is not an object")
    available = reduction.get("available")
    if not isinstance(available, bool):
        raise HeadroomError("Headroom output_reduction.available is not a boolean")
    if not available:
        return None, None
    method = reduction.get("method")
    if method not in VALID_METHODS:
        raise HeadroomError(f"Headroom output reduction method {method!r} is unknown")
    percent = reduction.get("reduction_percent")
    if isinstance(percent, bool) or not isinstance(percent, (int, float)):
        raise HeadroomError("Headroom reduction_percent is not numeric")
    if not math.isfinite(percent) or percent < 0:
        raise HeadroomError("Headroom reduction_percent is not a non-negative finite number")
    return float(percent), method


def _parse_stats(body: bytes) -> HeadroomStats:
    try:
        data = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as error:
        raise HeadroomError(f"Headroom stats payload is not valid JSON: {error}") from error
    if not isinstance(data, dict):
        raise HeadroomError("Headroom stats payload is not a JSON object")
    _check_depth(data)
    requests = _counter(data, "requests", "total")
    tokens_saved = _counter(data, "tokens", "saved")
    output_saved = _counter(data, "tokens", "output_saved")
    percent, method = _output_reduction(data["tokens"])
    return HeadroomStats(requests, tokens_saved, output_saved, percent, method)


class HeadroomSession:
    """Per-process routing and telemetry state for the dashboard."""

    def __init__(self, base_url: str | None):
        self._config_error: str | None = None
        self._client: HeadroomClient | None = None
        if base_url:
            try:
                self._client = HeadroomClient(base_url)
            except HeadroomError as error:
                self._config_error = str(error)
        self._routes: dict[str, HeadroomRoute] = {}
        self._baseline: HeadroomStats | None = None
        self._delta: HeadroomDelta | None = None
        self._last_stats: HeadroomStats | None = None
        self._stats_degraded = False

    @classmethod
    def from_environment(cls, environ: Mapping[str, str] | None = None) -> HeadroomSession:
        source = os.environ if environ is None else environ
        return cls(source.get(HEADROOM_ENV) or None)

    def refresh(self, backend: str) -> HeadroomRoute:
        route = self._probe(backend)
        self._routes[backend] = route
        if route.state == "ACTIVE":
            self._sample()
        return route

    def route_for_call(self, backend: str) -> HeadroomRoute:
        route = self._probe(backend)
        self._routes[backend] = route
        return route

    def status_line(self, backend: str, caveman: bool) -> str:
        name = _BACKEND_NAMES.get(backend, backend)
        route = self._routes.get(backend) or self._default_route(backend)
        state_tag = f"[{route.state}]"
        caveman_tag = f"Caveman {'ON' if caveman else 'OFF'} [C]"
        if route.state == "ACTIVE":
            line = f"{state_tag} {name}: via Headroom at {route.base_url}"
            if self._stats_degraded:
                line += " - statistics degraded"
            elif self._delta is not None:
                line += (
                    f" - proxy delta: {self._delta.requests} requests, "
                    f"{self._delta.tokens_saved} tokens saved, "
                    f"{self._delta.output_tokens_saved} output tokens saved"
                )
                if (
                    self._last_stats is not None
                    and self._last_stats.output_reduction_percent is not None
                    and self._last_stats.output_reduction_method is not None
                ):
                    line += (
                        f" (proxy-wide {self._last_stats.output_reduction_percent:g}% "
                        f"reduction {self._last_stats.output_reduction_method})"
                    )
        elif route.state == "DEGRADED":
            line = f"{state_tag} {name}: direct - Headroom degraded ({route.reason})"
        else:
            line = f"{state_tag} {name}: direct - {route.reason}"
        return f"{line}; {caveman_tag}"

    def telemetry(self, backend: str) -> dict[str, object]:
        route = self._routes.get(backend) or self._default_route(backend)
        delta = self._delta
        last = self._last_stats
        return {
            "state": route.state,
            "route": route.base_url or "",
            "status_line": self.status_line(backend, True),
            "requests": delta.requests if delta is not None else 0,
            "tokens_saved": delta.tokens_saved if delta is not None else 0,
            "output_tokens_saved": (
                delta.output_tokens_saved if delta is not None else 0
            ),
            "output_reduction_percent": (
                last.output_reduction_percent
                if last is not None and not self._stats_degraded
                else None
            ),
            "output_reduction_method": (
                last.output_reduction_method
                if last is not None and not self._stats_degraded
                else None
            ),
            "statistics_degraded": self._stats_degraded,
        }

    def _direct_route(self, backend: str) -> HeadroomRoute | None:
        if backend != "codex":
            return HeadroomRoute("DIRECT", backend, None, "Headroom proxies Codex only")
        if self._config_error is not None:
            return None
        if self._client is None:
            return HeadroomRoute("DIRECT", backend, None, f"{HEADROOM_ENV} is not set")
        return None

    def _probe(self, backend: str) -> HeadroomRoute:
        direct = self._direct_route(backend)
        if direct is not None:
            return direct
        if self._config_error is not None:
            return HeadroomRoute("DEGRADED", backend, None, f"invalid {HEADROOM_ENV}: {self._config_error}")
        if not self._client.ready():
            return HeadroomRoute("DEGRADED", backend, None, "readiness probe failed")
        return HeadroomRoute("ACTIVE", backend, self._client.base_url, "ready")

    def _default_route(self, backend: str) -> HeadroomRoute:
        direct = self._direct_route(backend)
        if direct is not None:
            return direct
        if self._config_error is not None:
            return HeadroomRoute("DEGRADED", backend, None, f"invalid {HEADROOM_ENV}: {self._config_error}")
        return HeadroomRoute("DEGRADED", backend, None, "not probed yet")

    def _sample(self) -> None:
        try:
            stats = self._client.stats()
            self._last_stats = stats
            if self._baseline is None:
                self._baseline = stats
                self._delta = HeadroomDelta(0, 0, 0)
            else:
                self._delta = stats.delta_from(self._baseline)
            self._stats_degraded = False
        except HeadroomError:
            self._stats_degraded = True


def apply_caveman(prompt: str, enabled: bool) -> str:
    if not enabled or CAVEMAN_INSTRUCTIONS in prompt:
        return prompt
    return f"{prompt}\n\n{CAVEMAN_INSTRUCTIONS}"
