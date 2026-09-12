"""Model profiles for final review and escalation work."""

from __future__ import annotations

import os
import re

# Reviewing is the expensive judgement; fixing is mechanical. Gemini is the
# automatic default, while K3 fixes every policy's findings.
GEMINI_TRIPLE = ("omp", "gemini-3.8-flash", "max")
SOL_TRIPLE = ("omp", "gpt-5.6-sol", "medium")
OPUS_TRIPLE = ("omp", "claude-opus-5", "high")
KIMI_TRIPLE = ("omp", "kimi-k3", "high")  # alias K3

HIGH_ASSURANCE_MODELS = frozenset({
    "gpt-5.6-sol",
    "claude-opus-5",
    "kimi-k3",
})

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


def is_low_risk(stop: object) -> bool:
    """True when the pull request is in the explicit, deterministic low-risk
    class (dependencies or chores by conventional commit title or GitHub
    dependencies label). Grants no merge authority on its own."""
    return classify_batch([stop]) == "dependency"


def is_high_assurance(target: object) -> bool:
    """True only when target (triple, identity, record, or model string) names
    a model on the high-assurance allowlist.

    Fail closed. An unrecognised model is NOT high assurance: the whole point
    of escalation is that a weak model's false negative reports clean, so a
    model nobody classified must never be the thing that authorises a merge.
    """
    if hasattr(target, "model"):
        model = getattr(target, "model")
    elif isinstance(target, (tuple, list)) and len(target) >= 2:
        model = target[1]
    elif isinstance(target, str):
        model = target
    else:
        return False
    return str(model) in HIGH_ASSURANCE_MODELS


def escalation_triple(policy: str = "automatic", classification: str = "mixed") -> tuple[str, str, str]:
    """The (backend, model, effort) triple for an escalated, high-assurance review.

    Explicit, per escalation, and never inherited: escalation must always use
    a high-assurance model, never a cheap first-pass model.
    """
    if policy == "opus":
        return OPUS_TRIPLE
    if policy in ("sol", "gpt-sol"):
        return SOL_TRIPLE
    if policy in ("k3", "kimi"):
        return KIMI_TRIPLE
    if policy == "automatic":
        return KIMI_TRIPLE if classification == "dependency" else SOL_TRIPLE
    return SOL_TRIPLE


def final_triple(policy: str, classification: str, phase: str) -> tuple:
    """The (backend, model, effort) a round runs with.

    Explicit, per round, and never inherited: a stale ambient model pick
    would otherwise leak into a round that never asked for it.
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

    Neither Codex nor OMP read their model from the environment — Codex
    takes it on the command line, and a final round's OMP argv passes
    --model/--thinking explicitly for the same reason (final_command in
    landing.py). This overlay carries the backend and final-round model/
    effort markers for display and provenance only.
    """
    kind, model, effort = triple
    active = backend or os.environ.get("BLUEFIN_REVIEW_BACKEND", kind)
    return {
        "BLUEFIN_REVIEW_BACKEND": active,
        "BLUEFIN_REVIEW_FINAL_MODEL": model,
        "BLUEFIN_REVIEW_FINAL_EFFORT": effort,
    }
