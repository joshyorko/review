import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

BROKER_PATH = Path(__file__).parents[1] / "scripts" / "review-exec-broker.py"


def load_module():
    spec = importlib.util.spec_from_file_location("review_exec_broker", BROKER_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


broker = load_module()


class FakeKubectl:
    def __init__(self):
        self.calls = []

    def __call__(self, args, *, input_text="", timeout=30):
        self.calls.append((list(args), input_text))
        if args[:2] == ["create", "-f"]:
            return broker.HostResult(args, 0, "job/review-exec-abc\n")
        if args[:2] == ["get", "jobs.batch"]:
            return broker.HostResult(
                args,
                0,
                json.dumps({"items": []}),
            )
        if args[:2] == ["delete", "job"]:
            return broker.HostResult(args, 0, "")
        if args[:2] == ["logs"]:
            return broker.HostResult(args, 0, '{"version":1}\n')
        return broker.HostResult(args, 0, "{}")


class ReviewExecContractTests(unittest.TestCase):
    def test_submit_manifest_is_typed_and_has_session_labels_and_deadlines(self):
        fake = FakeKubectl()
        broker.run_kubectl = fake
        context = broker.BrokerContext(
            session="session-a",
            image="ghcr.io/projectbluefin/review-contributor:stable",
        )
        answer = broker.handle_submit(
            context,
            {
                "version": 1,
                "action": "submit",
                "session": "session-a",
                "repository": "projectbluefin/review",
                "number": 372,
                "base_sha": "a" * 40,
                "head_sha": "b" * 40,
                "backend": "goose",
                "model": "gemini-3.8-flash",
                "effort": "high",
            },
        )
        self.assertTrue(answer["ok"])
        manifest = json.loads(fake.calls[0][1])
        self.assertEqual(manifest["metadata"]["namespace"], "bluefin-system")
        labels = manifest["metadata"]["labels"]
        self.assertEqual(labels["review.session"], "session-a")
        self.assertEqual(labels["review.repository"], "projectbluefin_review")
        self.assertEqual(labels["review.pr"], "372")
        self.assertEqual(labels["review.head"], "b" * 40)
        self.assertEqual(manifest["spec"]["activeDeadlineSeconds"], broker.JOB_DEADLINE_SECONDS)
        self.assertEqual(manifest["spec"]["ttlSecondsAfterFinished"], broker.JOB_TTL_SECONDS)
        args = manifest["spec"]["template"]["spec"]["containers"][0]["args"]
        self.assertIn("--head-sha", args)
        self.assertIn("b" * 40, args)

    def test_wrong_session_and_arbitrary_verb_are_rejected(self):
        context = broker.BrokerContext("session-a", image="review")
        self.assertEqual(
            broker.dispatch(
                context,
                json.dumps({
                    "version": 1,
                    "action": "status",
                    "session": "session-b",
                }).encode(),
            )["error"],
            "wrong-session",
        )
        self.assertEqual(
            broker.dispatch(
                context,
                json.dumps({
                    "version": 1,
                    "action": "exec",
                    "session": "session-a",
                }).encode(),
            )["error"],
            "unknown-action",
        )

    def test_session_cancel_and_startup_sweep_are_scoped(self):
        fake = FakeKubectl()
        broker.run_kubectl = fake
        context = broker.BrokerContext("session-a", image="review")
        broker.cancel_session_jobs(context)
        broker.sweep_orphans(context)
        joined = "\n".join(" ".join(call[0]) for call in fake.calls)
        self.assertIn("review.session=session-a", joined)
        self.assertIn("review.owner=review-exec", joined)


if __name__ == "__main__":
    unittest.main()
