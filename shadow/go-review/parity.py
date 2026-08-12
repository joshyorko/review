"""Run the shadow fixture suite against the recorded Python contract."""

from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

ROOT = Path(__file__).parents[2]
BASELINE_COMMIT = "6748294e476cc7ba836771b92565f0b09082a33e"
BASELINE_SOURCES = {
    ROOT / "image" / "tui" / "review_result.py": "fe5574a3b6a6d14bedc37febc8d68a27cbc50b86",
    ROOT
    / "image"
    / "tui"
    / "review_evidence_manifest.py": "e7c334309a4456ddca208c75d2d2289f58e66f58",
    ROOT / "image" / "tui" / "action_plan.py": "13f8884c00af62233add5e4bcf1604919f9dd065",
}
BASELINE_TEST_SOURCES = {
    ROOT / "tests" / "review_result_contract.py": "c0b7247fab31c2ff8c6010976b64befce64c224b",
    ROOT
    / "tests"
    / "review_evidence_manifest_contract.py": "e064581649cc95dbae5be947c86f00f7a5d7b51d",
    ROOT / "tests" / "action_plan_contract.py": "3b8033c96881e55cea285d311b55d873c5fa1208",
}


def verify_baseline_sources() -> None:
    for source_path, expected_blob in {
        **BASELINE_SOURCES,
        **BASELINE_TEST_SOURCES,
    }.items():
        source = source_path.read_bytes()
        blob = f"blob {len(source)}\0".encode() + source
        actual = hashlib.sha1(blob, usedforsecurity=False).hexdigest()
        if actual != expected_blob:
            raise RuntimeError(
                f"baseline source changed: {source_path} has {actual}, "
                f"want {expected_blob} from {BASELINE_COMMIT}"
            )


verify_baseline_sources()
sys.path.insert(0, str((ROOT / "image" / "tui")))
from review_result import MAX_RAW_CHARS, parse_review_result  # noqa: E402
from action_plan import (  # noqa: E402
    ActionPlan,
    CurrentState,
    GitHubOperation,
    Prerequisites,
)
from review_evidence_manifest import (  # noqa: E402
    Availability,
    EvidenceEntry,
    EvidenceHandle,
    EvidencePhase,
    ReviewEvidenceManifest,
    ReviewRequest,
    TrustClass,
)


FIXTURES = Path(__file__).parent / "testdata" / "review-result-cases.json"
EVIDENCE_FIXTURES = Path(__file__).parent / "testdata" / "evidence-manifest-cases.json"
ACTION_FIXTURES = Path(__file__).parent / "testdata" / "action-plan-cases.json"
CANONICAL_FIELDS = {
    "counts",
    "findings",
    "verification",
    "provenance",
    "overlap",
    "live",
    "raw_evidence",
    "state",
    "version",
}


def fixture_payload(payload: Any) -> str:
    if isinstance(payload, str):
        return payload
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def canonical_result(result: Any) -> dict[str, Any]:
    return json.loads(result.to_json())


def check_fixtures() -> tuple[int, int]:
    cases = json.loads(FIXTURES.read_text())
    round_trip_count = 0
    for case in cases:
        result = parse_review_result(fixture_payload(case["payload"]))
        expected = case["expected"]
        actual_shape = canonical_result(result)
        if set(actual_shape) != CANONICAL_FIELDS:
            raise AssertionError(
                f'{case["name"]}: serialized result fields differ: '
                f"{sorted(actual_shape)}"
            )
        if result.state != expected["state"]:
            raise AssertionError(
                f'{case["name"]}: state={result.state!r}, want {expected["state"]!r}'
            )
        if result.is_clean != expected["is_clean"]:
            raise AssertionError(
                f'{case["name"]}: is_clean={result.is_clean!r}, want {expected["is_clean"]!r}'
            )
        if actual_shape != expected["result"]:
            raise AssertionError(
                f'{case["name"]}: serialized result differs\n'
                f"actual={json.dumps(actual_shape, sort_keys=True)}\n"
                f'expected={json.dumps(expected["result"], sort_keys=True)}'
            )
        if result.state != "unparsable":
            round_trip = parse_review_result(result.to_json())
            if canonical_result(round_trip) != actual_shape:
                raise AssertionError(f'{case["name"]}: round-trip result differs')
            if round_trip.is_clean != result.is_clean:
                raise AssertionError(f'{case["name"]}: round-trip clean state differs')
            round_trip_count += 1
    return len(cases), round_trip_count


def check_boundary_payloads() -> tuple[int, int]:
    clean_payload = json.dumps(
        {
            "counts": {"critical": 0, "high": 0, "low": 0, "medium": 0},
            "findings": [],
            "state": "complete",
            "version": 1,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    cases = {
        "deep JSON": "[" * 2_000 + "]" * 2_000,
        "oversized JSON": "x" * (MAX_RAW_CHARS + 1),
        "trailing JSON": clean_payload + " {}",
    }
    for name, payload in cases.items():
        result = parse_review_result(payload)
        if result.state != "unparsable" or result.is_clean:
            raise AssertionError(f"{name} was accepted as clean")
    oversized = parse_review_result(cases["oversized JSON"])
    if len(oversized.raw_evidence) != 1 or len(oversized.raw_evidence[0]) != MAX_RAW_CHARS:
        raise AssertionError("oversized input did not retain bounded raw evidence")

    truncated_prefixes = 0
    for end in range(len(clean_payload)):
        if parse_review_result(clean_payload[:end]).is_clean:
            raise AssertionError(f"truncated clean payload became clean at byte {end}")
        truncated_prefixes += 1
    return len(cases), truncated_prefixes


def check_numeric_edges() -> int:
    cases = {
        "-0": "complete",
        "0.0": "unparsable",
        "1e0": "unparsable",
        "-0.0": "unparsable",
        "+1": "unparsable",
        "01": "unparsable",
    }
    for token, expected_state in cases.items():
        payload = (
            '{"counts":{"critical":'
            + token
            + ',"high":0,"low":0,"medium":0},"findings":[],"state":"complete","version":1}'
        )
        result = parse_review_result(payload)
        if result.state != expected_state or (
            expected_state == "unparsable" and result.is_clean
        ):
            raise AssertionError(
                f"numeric edge {token!r}: state={result.state!r}, "
                f"clean={result.is_clean!r}"
            )
    return len(cases)


def check_unicode_line_splitting() -> int:
    separators = (
        "\r\n",
        "\n",
        "\r",
        "\v",
        "\f",
        "\x1c",
        "\x1d",
        "\x1e",
        "\x85",
        "\u2028",
        "\u2029",
    )
    raw = "".join(
        f"line{index}{separator}" for index, separator in enumerate(separators)
    ) + "tail"
    payload = json.dumps(
        {
            "counts": {"critical": 0, "high": 0, "low": 0, "medium": 0},
            "findings": [],
            "raw_evidence": raw,
            "state": "complete",
            "version": 1,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    result = parse_review_result(payload)
    expected = [f"line{index}" for index in range(len(separators))] + ["tail"]
    if result.raw_evidence != expected:
        raise AssertionError(
            f"Unicode line splitting = {result.raw_evidence!r}, want {expected!r}"
        )
    return len(separators)


def check_malformed_optional_fields() -> int:
    cases = json.loads(FIXTURES.read_text())
    malformed = [case for case in cases if case["name"].startswith("malformed-")]
    for case in malformed:
        result = parse_review_result(fixture_payload(case["payload"]))
        if result.state != "unparsable" or result.is_clean:
            raise AssertionError(f'{case["name"]} was accepted as clean')
    return len(malformed)


def evidence_entry(value: dict[str, Any]) -> EvidenceEntry:
    return EvidenceEntry(
        kind=value["kind"],
        provenance=value["provenance"],
        trust=TrustClass(value["trust"]),
        availability=Availability(value["availability"]),
        phase=EvidencePhase(value["phase"]),
        summary=value.get("summary", ""),
        handles=tuple(
            EvidenceHandle(
                uri=handle["uri"],
                label=handle["label"],
                max_bytes=handle["max_bytes"],
            )
            for handle in value.get("handles", ())
        ),
        untrusted_text=value.get("untrusted_text"),
    )


def evidence_manifest(case: dict[str, Any]) -> ReviewEvidenceManifest:
    request_value = case["request"]
    request = ReviewRequest(
        owner=request_value["owner"],
        repository=request_value["repository"],
        pull_request_number=request_value["pull_request_number"],
        base_sha=request_value["base_sha"],
        head_sha=request_value["head_sha"],
        actor=request_value["actor"],
        tenant=request_value["tenant"],
        installation=request_value.get("installation"),
        generated_at=request_value["generated_at"],
        focus=request_value.get("focus", ""),
        steering=request_value.get("steering", ""),
        version=request_value.get("version", 1),
    )
    entries = tuple(evidence_entry(value) for value in case.get("entries", ()))
    policy_value = case.get("organization_policy")
    policy = evidence_entry(policy_value) if policy_value is not None else None
    return ReviewEvidenceManifest(request, entries, policy)


def check_evidence_fixtures() -> int:
    cases = json.loads(EVIDENCE_FIXTURES.read_text())
    for case in cases:
        actual = json.loads(evidence_manifest(case).semantic_json())
        if actual != case["expected"]:
            raise AssertionError(
                f'{case["name"]}: EvidenceManifest differs\n'
                f"actual={json.dumps(actual, sort_keys=True)}\n"
                f'expected={json.dumps(case["expected"], sort_keys=True)}'
            )
    return len(cases)


def check_evidence_malformed_cases() -> int:
    case = json.loads(EVIDENCE_FIXTURES.read_text())[0]
    request = evidence_manifest(case).request
    valid_entry = EvidenceEntry(
        kind="source",
        provenance="checkout",
        trust=TrustClass.REPOSITORY,
        availability=Availability.AVAILABLE,
        phase=EvidencePhase.SNAPSHOT,
    )
    malformed = (
        (
            "trusted review text",
            lambda: EvidenceEntry(
                kind=valid_entry.kind,
                provenance=valid_entry.provenance,
                trust=valid_entry.trust,
                availability=valid_entry.availability,
                phase=valid_entry.phase,
                untrusted_text="review text",
            ),
        ),
        (
            "oversized summary",
            lambda: EvidenceEntry(
                kind=valid_entry.kind,
                provenance=valid_entry.provenance,
                trust=valid_entry.trust,
                availability=valid_entry.availability,
                phase=valid_entry.phase,
                summary="x" * 4097,
            ),
        ),
        (
            "wrong policy kind",
            lambda: ReviewEvidenceManifest(
                request,
                organization_policy=valid_entry,
            ),
        ),
        (
            "oversized manifest",
            lambda: ReviewEvidenceManifest(request, (valid_entry,) * 129),
        ),
    )
    for name, build in malformed:
        try:
            build()
        except Exception:
            continue
        raise AssertionError(f"{name} was accepted")
    return len(malformed)


def action_plan(case: dict[str, Any]) -> ActionPlan:
    value = case["plan"]
    operations = tuple(
        GitHubOperation.from_argv(operation["argv"], body=operation.get("body"))
        for operation in value["operations"]
    )
    prerequisites = Prerequisites.from_mappings(**value["prerequisites"])
    return ActionPlan.build(
        actor=value["actor"],
        tenant=value["tenant"],
        repository=value["repository"],
        pull_request=value["pull_request"],
        head_sha=value["head_sha"],
        action_kind=value["action_kind"],
        body=value.get("body"),
        operations=operations,
        prerequisites=prerequisites,
        created_at=datetime.fromisoformat(value["created_at"]),
        expires_at=datetime.fromisoformat(value["expires_at"]),
        idempotency_key=value["idempotency_key"],
    )


def current_state(case: dict[str, Any]) -> CurrentState:
    value = case["current"]
    return CurrentState(
        actor=value["actor"],
        tenant=value["tenant"],
        repository=value["repository"],
        pull_request=value["pull_request"],
        head_sha=value["head_sha"],
        body=value.get("body"),
        prerequisites=Prerequisites.from_mappings(**value["prerequisites"]),
    )


def check_action_plan_fixtures() -> tuple[int, int]:
    cases = json.loads(ACTION_FIXTURES.read_text())
    exact_head_count = 0
    for case in cases:
        plan = action_plan(case)
        if plan.identity != case["expected"]["identity"]:
            raise AssertionError(
                f'{case["name"]}: identity={plan.identity!r}, '
                f'expected={case["expected"]["identity"]!r}'
            )
        actual_payload = {
            "action_kind": plan.action_kind,
            "actor": plan.actor,
            "body": plan.body,
            "created_at": plan.created_at.isoformat(),
            "expires_at": plan.expires_at.isoformat(),
            "head_sha": plan.head_sha,
            "idempotency_key": plan.idempotency_key,
            "operations": [
                {"argv": list(operation.argv), "body": operation.body}
                for operation in plan.operations
            ],
            "prerequisites": plan.prerequisites.payload(),
            "pull_request": plan.pull_request,
            "repository": plan.repository,
            "tenant": plan.tenant,
        }
        if actual_payload != case["expected"]["payload"]:
            raise AssertionError(
                f'{case["name"]}: canonical payload differs\n'
                f"actual={json.dumps(actual_payload, sort_keys=True)}\n"
                f'expected={json.dumps(case["expected"]["payload"], sort_keys=True)}'
            )
        if plan.preview().plan_identity != plan.identity:
            raise AssertionError(f'{case["name"]}: preview identity differs')
        plan.revalidate(
            current_state(case),
            now=plan.created_at + timedelta(minutes=1),
        )
        exact_head_count += 1
        drifted = dict(case["current"])
        drifted["head_sha"] = "0" * 40
        drifted_case = dict(case)
        drifted_case["current"] = drifted
        try:
            plan.revalidate(
                current_state(drifted_case),
                now=plan.created_at + timedelta(minutes=1),
            )
        except Exception:
            pass
        else:
            raise AssertionError(f'{case["name"]}: head drift was accepted')
    return len(cases), exact_head_count


def check_action_plan_malformed_cases() -> int:
    case = json.loads(ACTION_FIXTURES.read_text())[0]
    value = case["plan"]

    def build(**overrides: Any) -> ActionPlan:
        payload = dict(value)
        payload.update(overrides)
        operations = tuple(
            GitHubOperation.from_argv(operation["argv"], body=operation.get("body"))
            for operation in payload["operations"]
        )
        return ActionPlan.build(
            actor=payload["actor"],
            tenant=payload["tenant"],
            repository=payload["repository"],
            pull_request=payload["pull_request"],
            head_sha=payload["head_sha"],
            action_kind=payload["action_kind"],
            body=payload.get("body"),
            operations=operations,
            prerequisites=Prerequisites.from_mappings(**payload["prerequisites"]),
            created_at=datetime.fromisoformat(payload["created_at"]),
            expires_at=datetime.fromisoformat(payload["expires_at"]),
            idempotency_key=payload["idempotency_key"],
        )

    malformed = (
        (
            "non-string operation body",
            lambda: GitHubOperation.from_argv(value["operations"][0]["argv"], body=7),
        ),
        (
            "body-bearing operation without plan body",
            lambda: build(body=None),
        ),
        (
            "operation body not represented by argv",
            lambda: build(
                body=None,
                operations=(
                    {
                        "argv": [
                            "gh",
                            "pr",
                            "review",
                            "17",
                            "--repo",
                            "octo/sample",
                        ],
                        "body": "orphaned",
                    },
                ),
            ),
        ),
        (
            "non-scalar prerequisite",
            lambda: build(prerequisites={"permissions": {"push": []}, "checks": {}}),
        ),
        (
            "boolean pull request",
            lambda: build(pull_request=True),
        ),
    )
    for name, attempt in malformed:
        try:
            attempt()
        except Exception:
            continue
        raise AssertionError(f"{name} was accepted")
    return len(malformed)


def main() -> None:
    fixture_count, round_trip_count = check_fixtures()
    boundary_count, truncated_count = check_boundary_payloads()
    numeric_count = check_numeric_edges()
    unicode_count = check_unicode_line_splitting()
    malformed_count = check_malformed_optional_fields()
    evidence_fixture_count = check_evidence_fixtures()
    evidence_malformed_count = check_evidence_malformed_cases()
    action_fixture_count, exact_head_count = check_action_plan_fixtures()
    action_malformed_count = check_action_plan_malformed_cases()
    print(
        "Python ReviewResult parity: "
        f"baseline {BASELINE_COMMIT}, "
        f"{fixture_count} fixture cases, {round_trip_count} round-trip cases, "
        f"{boundary_count} boundary cases, {truncated_count} truncated prefixes, "
        f"{numeric_count} numeric edge cases, {unicode_count} Unicode line boundaries, "
        f"and {malformed_count} malformed optional cases passed"
    )
    print(
        "Python M1 contract parity: "
        f"{evidence_fixture_count} EvidenceManifest fixtures, "
        f"{evidence_malformed_count} malformed EvidenceManifest cases, "
        f"{action_fixture_count} ActionPlan fixtures, "
        f"{exact_head_count} exact-head revalidation cases, and "
        f"{action_malformed_count} malformed ActionPlan cases passed"
    )


if __name__ == "__main__":
    main()
