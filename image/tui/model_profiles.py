"""Model profiles for final review and escalation work."""

from __future__ import annotations

import os
import re

# Reviewing is the expensive judgement; fixing is mechanical. Gemini is the
# automatic default, while K3 fixes every policy's findings.
GEMINI_TRIPLE = ("goose", "gemini-3.8-flash", "high")
SOL_TRIPLE = ("goose", "gpt-5.6-sol", "medium")
OPUS_TRIPLE = ("goose", "claude-opus-5", "high")
KIMI_TRIPLE = ("goose", "kimi-k3", "high")  # alias K3

# A dependency batch is one whose every pull request is a dependency or
# chore change. Conventional Commit types decide it, plus GitHub's own
# `dependencies` label, and anything unrecognized makes the batch mixed —
# an unknown title must never talk the queue into the cheaper reviewer.
DEPENDENCY_TITLE = re.compile(
    r"^\s*(chore|build)\s*(\((deps|deps-dev)\))?\s*!?\s*:", re.IGNORECASE
)


def classify_batch(stops: list) -> str:
    """`dependency` when every selected pull request is a dependency or
    chore change, `mixed` otherwise. Classification picks a reviewer; it
    grants no merge authority and changes no scope."""
    if not stops:
        return "mixed"
    for stop in stops:
        labels = [
            str(label).lower()
            for label in (getattr(stop, "labels", None) or [])
        ]
        if "dependencies" in labels:
            continue
        if DEPENDENCY_TITLE.match(str(getattr(stop, "title", "") or "")):
            continue
        return "mixed"
    return "dependency"


def final_triple(policy: str, classification: str, phase: str) -> tuple:
    """The (backend, model, effort) a round runs with.

    Explicit, per round, and never inherited: the launcher's GOOSE_MODEL is
    whatever the maintainer picked for the dashboard, so a round that relies
    on the ambient environment silently reviews with the wrong model.
    """
    if phase in ("fixing", "cleanup"):
        return KIMI_TRIPLE
    if policy == "gemini":
        return GEMINI_TRIPLE
    if policy == "opus":
        return OPUS_TRIPLE
    if policy in ("sol", "gpt-sol"):
        return SOL_TRIPLE
    if policy in ("k3", "kimi"):
        return KIMI_TRIPLE
    if policy == "automatic":
        return KIMI_TRIPLE if classification == "dependency" else GEMINI_TRIPLE
    return GEMINI_TRIPLE


def final_environment(triple: tuple, backend: str = "") -> dict:
    """The environment overlay one round runs with.

    Goose reads its model from GOOSE_MODEL/GOOSE_THINKING_EFFORT, so those
    are set explicitly. Codex takes its model on the command line instead —
    setting Goose variables for a Codex round would silently do nothing —
    so a Codex session gets its selection through the command and the
    environment carries only the backend marker.
    """
    kind, model, effort = triple
    active = backend or os.environ.get("BLUEFIN_REVIEW_BACKEND", kind)
    overlay = {"BLUEFIN_REVIEW_BACKEND": active}
    if active == "codex":
        overlay["BLUEFIN_REVIEW_FINAL_MODEL"] = model
        overlay["BLUEFIN_REVIEW_FINAL_EFFORT"] = effort
        return overlay
    overlay["GOOSE_MODEL"] = model
    overlay["GOOSE_THINKING_EFFORT"] = effort
    return overlay
