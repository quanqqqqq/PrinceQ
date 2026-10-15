#!/usr/bin/env python3
"""Offline tests for pwq_client.py's `/api/settings/*` subcommands.

No server, no sockets: `request()` is monkey-patched, so every test asserts on
the exact (method, path, body, Idempotency-Key) the client *would* send. That is
the thing worth pinning — the paths and body shapes are a contract with
`server/http/routes.ts` and `src/lib/settings-client.ts`, and a typo in one of
them is invisible until a real call 404s.

Run: python3 skill/scripts/test_pwq_client_settings.py
"""

from __future__ import annotations

import io
import json
import sys
import unittest
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import pwq_client  # noqa: E402

# A snapshot shaped exactly like `GET /api/settings` returns, used as the canned
# response whenever the client reads a version for itself.
SNAPSHOT = {
    "versions": {
        "explicit": "2026-10-13T01:00:00.000Z",
        "inferred": "2026-10-13T02:00:00.000Z",
        "constraints": "2026-10-13T03:00:00.000Z",
        "weights": "2026-10-13T04:00:00.000Z",
    },
    "weights": {
        "weights": {
            "deadline": 1,
            "manual_priority": 1,
            "dependency": 1,
            "effort": 1,
            "habit_alignment": 1,
            "context_switch": 1,
        },
        "preferred_task_types": ["deep_work"],
        "peak_hours": [9, 10, 11],
    },
    "conversion": {"hours_per_day": 8, "days_per_month": 20},
    "explicit": [{"id": "habit_e1", "statement": "上午只做深度工作", "kind": "preference",
                  "enabled": True, "confidence": None, "source": "user",
                  "updated_at": "2026-10-13T01:00:00.000Z"}],
    "inferred": [{"id": "habit_i1", "statement": "你通常在上午处理最难的任务",
                  "kind": "scheduling", "enabled": True, "confidence": 0.7,
                  "source": "observed", "updated_at": "2026-10-13T02:00:00.000Z"}],
    "constraints": [{"id": "hc_1", "statement": "20 点后不安排工作",
                     "kind": "forbidden_window", "enabled": True, "value": "20:00-07:00"}],
}

FULL_WEIGHTS = {
    "deadline": 2,
    "manual_priority": 1,
    "dependency": 1,
    "effort": 0,
    "habit_alignment": 1,
    "context_switch": 1,
}


class Call:
    """One recorded outbound request."""

    def __init__(self, method, path, body, query, key):
        self.method, self.path, self.body, self.query, self.key = method, path, body, query, key

    def __repr__(self):  # pragma: no cover - only used when a test fails
        return f"<Call {self.method} {self.path} body={self.body}>"


class ClientTestCase(unittest.TestCase):
    """Base: patches `request()`, records calls, swallows the client's stdout."""

    def setUp(self):
        self.calls: list[Call] = []
        self.responses: list[dict] = []
        self._real_request = pwq_client.request

        def fake_request(base, method, path, body=None, query=None, key=None):
            self.calls.append(Call(method, path, body, query, key))
            if self.responses:
                return self.responses.pop(0)
            # Unqueued GETs answer with the snapshot; writes echo it back the way
            # the real routes do (`{snapshot: …}`).
            return dict(SNAPSHOT) if method == "GET" else {"snapshot": SNAPSHOT}

        pwq_client.request = fake_request
        # These tests pin command-to-payload mapping. The preview transport is
        # covered separately by tests/python/test_windows_portability.py.
        real_submit = pwq_client.submit_or_control
        pwq_client.submit_or_control = lambda args, method, path, body, key: pwq_client.request(args.base, method, path, body=body, key=key)
        self.addCleanup(lambda: setattr(pwq_client, 'submit_or_control', real_submit))
        self.addCleanup(lambda: setattr(pwq_client, "request", self._real_request))

    def run_client(self, *argv) -> dict | list:
        """Run one command, returning its parsed stdout payload."""
        out = io.StringIO()
        with redirect_stdout(out):
            pwq_client.main(list(argv))
        return json.loads(out.getvalue())

    def expect_exit(self, *argv) -> tuple[int, str]:
        """Run a command expected to fail; returns (exit code, stderr)."""
        err = io.StringIO()
        with self.assertRaises(SystemExit) as ctx, redirect_stderr(err), redirect_stdout(io.StringIO()):
            pwq_client.main(list(argv))
        return int(ctx.exception.code), err.getvalue()

    @property
    def writes(self) -> list[Call]:
        return [call for call in self.calls if call.method != "GET"]

    def only_write(self) -> Call:
        self.assertEqual(len(self.writes), 1, f"expected exactly one write, got {self.writes}")
        return self.writes[0]


class TestSnapshot(ClientTestCase):
    def test_reads_the_snapshot_and_writes_nothing(self):
        payload = self.run_client("habits-settings")
        self.assertEqual(payload["versions"], SNAPSHOT["versions"])
        self.assertEqual([(c.method, c.path) for c in self.calls], [("GET", "/api/settings")])

    def test_list_actions_project_one_section_each(self):
        for command, section in (
            ("habits-explicit", "explicit"),
            ("habits-inferred", "inferred"),
            ("habits-constraints", "constraints"),
        ):
            with self.subTest(command=command):
                self.calls.clear()
                payload = self.run_client(command, "list")
                self.assertEqual(payload, SNAPSHOT[section])
                self.assertEqual(self.writes, [], "a list must not write")


class TestVersionHandling(ClientTestCase):
    def test_supplied_version_is_used_verbatim_without_a_read(self):
        self.run_client("habits-explicit", "add", "--statement", "少开会",
                        "--expected-version", "2026-01-01T00:00:00.000Z")
        call = self.only_write()
        self.assertEqual(call.body["expected_version"], "2026-01-01T00:00:00.000Z")
        self.assertEqual([c for c in self.calls if c.method == "GET"], [],
                         "an explicit version must not trigger a snapshot read")

    def test_omitted_version_is_read_from_the_snapshot_first(self):
        self.run_client("habits-explicit", "add", "--statement", "少开会")
        self.assertEqual([(c.method, c.path) for c in self.calls],
                         [("GET", "/api/settings"), ("POST", "/api/settings/explicit")])
        self.assertEqual(self.only_write().body["expected_version"],
                         SNAPSHOT["versions"]["explicit"])

    def test_each_command_picks_the_version_of_the_file_it_writes(self):
        cases = (
            (("habits-explicit", "add", "--statement", "x"), "explicit"),
            (("habits-explicit", "enable", "--id", "habit_e1"), "explicit"),
            (("habits-inferred", "enable", "--id", "habit_i1"), "inferred"),
            (("habits-constraints", "add", "--statement", "x", "--kind", "forbidden_window",
              "--value", "20:00-07:00"), "constraints"),
            (("habits-constraints", "enable", "--id", "hc_1"), "constraints"),
            (("habits-conversion", "--hours-per-day", "6"), "weights"),
            (("habits-conversion", "--reset"), "weights"),
            (("habits-weights", "save", "--json", json.dumps({"weights": FULL_WEIGHTS})), "weights"),
        )
        for argv, file in cases:
            with self.subTest(argv=argv):
                self.calls.clear()
                self.run_client(*argv)
                self.assertEqual(self.only_write().body["expected_version"],
                                 SNAPSHOT["versions"][file],
                                 f"{argv[0]} should send versions.{file}")

    def test_a_409_prints_the_envelope_with_its_snapshot_and_exits_1(self):
        conflict = {
            "snapshot": SNAPSHOT,
            "error": {"code": "version_conflict", "message": "设置已在别处被修改", "details": {}},
        }

        # Mirrors how the real `request()` handles an HTTPError: print the body,
        # exit 1. The point is that the client surfaces the snapshot rather than
        # swallowing it — the user's next move depends on seeing it.
        def conflicting(base, method, path, body=None, query=None, key=None):
            if method == "GET":
                return dict(SNAPSHOT)
            print(json.dumps(conflict, indent=2, ensure_ascii=False))
            sys.exit(1)

        pwq_client.request = conflicting
        out = io.StringIO()
        with self.assertRaises(SystemExit) as ctx, redirect_stdout(out):
            pwq_client.main(["habits-explicit", "add", "--statement", "少开会",
                             "--expected-version", "stale"])
        self.assertEqual(ctx.exception.code, 1)
        printed = json.loads(out.getvalue())
        self.assertEqual(printed["error"]["code"], "version_conflict")
        self.assertEqual(printed["snapshot"]["versions"], SNAPSHOT["versions"])


class TestExplicit(ClientTestCase):
    def test_add_posts_statement_and_optional_kind(self):
        self.run_client("habits-explicit", "add", "--statement", "  上午只做深度工作  ",
                        "--kind", "scheduling", "--expected-version", "v1")
        call = self.only_write()
        self.assertEqual((call.method, call.path), ("POST", "/api/settings/explicit"))
        self.assertEqual(call.body, {"statement": "  上午只做深度工作  ", "kind": "scheduling",
                                     "expected_version": "v1"})

    def test_add_omits_kind_entirely_when_not_given(self):
        # Not `"kind": null` — the server would reject that; absent means
        # "default to preference".
        self.run_client("habits-explicit", "add", "--statement", "少开会", "--expected-version", "v1")
        self.assertNotIn("kind", self.only_write().body)

    def test_enable_defaults_to_on_and_disable_flips_it(self):
        self.run_client("habits-explicit", "enable", "--id", "habit_e1", "--expected-version", "v1")
        call = self.only_write()
        self.assertEqual(call.path, "/api/settings/explicit/habit_e1/enabled")
        self.assertIs(call.body["enabled"], True)

        self.calls.clear()
        self.run_client("habits-explicit", "enable", "--id", "habit_e1", "--disable",
                        "--expected-version", "v1")
        self.assertIs(self.only_write().body["enabled"], False)

    def test_ids_are_url_quoted(self):
        self.run_client("habits-explicit", "enable", "--id", "habit/one two",
                        "--expected-version", "v1")
        self.assertEqual(self.only_write().path,
                         "/api/settings/explicit/habit%2Fone%20two/enabled")

    def test_add_without_statement_is_a_usage_error(self):
        code, err = self.expect_exit("habits-explicit", "add", "--expected-version", "v1")
        self.assertEqual(code, 2)
        self.assertIn("--statement", err)
        self.assertEqual(self.writes, [])

    def test_enable_without_id_is_a_usage_error(self):
        code, err = self.expect_exit("habits-explicit", "enable", "--expected-version", "v1")
        self.assertEqual(code, 2)
        self.assertIn("--id", err)


class TestAdopt(ClientTestCase):
    def test_adopt_sends_both_versions_to_the_inferred_route(self):
        self.run_client("habits-explicit", "adopt-inferred", "--id", "habit_i1",
                        "--expected-version", "iv", "--expected-explicit-version", "ev")
        call = self.only_write()
        self.assertEqual((call.method, call.path),
                         ("POST", "/api/settings/inferred/habit_i1/adopt"))
        # Both keys, both required: adopt writes two files.
        self.assertEqual(call.body, {"expected_version": "iv", "expected_explicit_version": "ev"})

    def test_adopt_fills_either_missing_version_from_one_snapshot_read(self):
        self.run_client("habits-explicit", "adopt-inferred", "--id", "habit_i1")
        self.assertEqual(len([c for c in self.calls if c.method == "GET"]), 1,
                         "both versions should come from a single read")
        self.assertEqual(self.only_write().body, {
            "expected_version": SNAPSHOT["versions"]["inferred"],
            "expected_explicit_version": SNAPSHOT["versions"]["explicit"],
        })

    def test_adopt_fills_only_the_half_that_was_omitted(self):
        self.run_client("habits-explicit", "adopt-inferred", "--id", "habit_i1",
                        "--expected-version", "mine")
        self.assertEqual(self.only_write().body, {
            "expected_version": "mine",
            "expected_explicit_version": SNAPSHOT["versions"]["explicit"],
        })

    def test_adopt_without_id_is_a_usage_error(self):
        code, err = self.expect_exit("habits-explicit", "adopt-inferred",
                                     "--expected-version", "iv",
                                     "--expected-explicit-version", "ev")
        self.assertEqual(code, 2)
        self.assertIn("--id", err)


class TestInferred(ClientTestCase):
    def test_enable_and_disable_hit_the_inferred_route(self):
        self.run_client("habits-inferred", "enable", "--id", "habit_i1", "--expected-version", "v")
        self.assertEqual(self.only_write().path, "/api/settings/inferred/habit_i1/enabled")
        self.assertIs(self.only_write().body["enabled"], True)

        self.calls.clear()
        self.run_client("habits-inferred", "enable", "--id", "habit_i1", "--disable",
                        "--expected-version", "v")
        self.assertIs(self.only_write().body["enabled"], False)

    def test_there_is_no_add_or_edit_action(self):
        # Inferred habits are observations, not user statements: promoting one is
        # `habits-explicit adopt-inferred`, and there is no way to author one.
        code, _ = self.expect_exit("habits-inferred", "add", "--statement", "x")
        self.assertEqual(code, 2)


class TestConstraints(ClientTestCase):
    def test_add_requires_statement_kind_and_value(self):
        self.run_client("habits-constraints", "add", "--statement", "20 点后不安排工作",
                        "--kind", "forbidden_window", "--value", "20:00-07:00",
                        "--expected-version", "v")
        call = self.only_write()
        self.assertEqual((call.method, call.path), ("POST", "/api/settings/constraints"))
        self.assertEqual(call.body, {
            "statement": "20 点后不安排工作",
            "kind": "forbidden_window",
            "value": "20:00-07:00",
            "expected_version": "v",
        })

    def test_add_rejects_a_kind_outside_the_three_known_ones(self):
        code, _ = self.expect_exit("habits-constraints", "add", "--statement", "x",
                                   "--kind", "legacy_custom_kind", "--value", "1")
        self.assertEqual(code, 2, "argparse should reject the unknown kind locally")

    def test_add_missing_any_required_piece_is_a_usage_error(self):
        for argv in (
            ("habits-constraints", "add", "--kind", "forbidden_window", "--value", "x"),
            ("habits-constraints", "add", "--statement", "x", "--value", "y"),
            ("habits-constraints", "add", "--statement", "x", "--kind", "forbidden_window"),
        ):
            with self.subTest(argv=argv):
                self.calls.clear()
                code, _ = self.expect_exit(*argv, "--expected-version", "v")
                self.assertEqual(code, 2)
                self.assertEqual(self.writes, [])

    def test_enable_and_disable(self):
        self.run_client("habits-constraints", "enable", "--id", "hc_1", "--disable",
                        "--expected-version", "v")
        call = self.only_write()
        self.assertEqual(call.path, "/api/settings/constraints/hc_1/enabled")
        self.assertIs(call.body["enabled"], False)


class TestConversion(ClientTestCase):
    def test_sets_one_or_both_coefficients(self):
        self.run_client("habits-conversion", "--hours-per-day", "4", "--days-per-month", "22",
                        "--expected-version", "v")
        call = self.only_write()
        self.assertEqual((call.method, call.path), ("POST", "/api/settings/conversion"))
        self.assertEqual(call.body, {"hours_per_day": 4.0, "days_per_month": 22,
                                     "expected_version": "v"})

        self.calls.clear()
        self.run_client("habits-conversion", "--days-per-month", "22", "--expected-version", "v")
        # Only the key that was given: the server keeps the other at its stored value.
        self.assertEqual(self.only_write().body, {"days_per_month": 22, "expected_version": "v"})

    def test_reset_hits_its_own_route_with_only_a_version(self):
        self.run_client("habits-conversion", "--reset", "--expected-version", "v")
        call = self.only_write()
        self.assertEqual((call.method, call.path), ("POST", "/api/settings/conversion/reset"))
        self.assertEqual(call.body, {"expected_version": "v"})

    def test_reset_cannot_be_combined_with_explicit_values(self):
        code, err = self.expect_exit("habits-conversion", "--reset", "--hours-per-day", "6",
                                     "--expected-version", "v")
        self.assertEqual(code, 2)
        self.assertIn("--reset", err)
        self.assertEqual(self.writes, [])

    def test_no_flags_at_all_is_a_usage_error(self):
        code, err = self.expect_exit("habits-conversion", "--expected-version", "v")
        self.assertEqual(code, 2)
        self.assertIn("--hours-per-day", err)


class TestWeights(ClientTestCase):
    def test_preview_posts_the_draft_with_no_version_and_no_key(self):
        draft = {"weights": FULL_WEIGHTS, "peak_hours": [9, 10]}
        self.run_client("habits-weights", "preview", "--json", json.dumps(draft))
        call = self.only_write()
        self.assertEqual((call.method, call.path), ("POST", "/api/settings/weights/preview"))
        self.assertEqual(call.body, draft)
        # Three separate guarantees that preview is not a write:
        self.assertNotIn("expected_version", call.body)
        self.assertIsNone(call.key, "preview needs no Idempotency-Key — it writes nothing")
        self.assertEqual([c for c in self.calls if c.method == "GET"], [],
                         "preview must not even read a version")

    def test_save_adds_the_version_and_an_idempotency_key(self):
        self.run_client("habits-weights", "save", "--json", json.dumps({"weights": FULL_WEIGHTS}),
                        "--expected-version", "v")
        call = self.only_write()
        self.assertEqual((call.method, call.path), ("POST", "/api/settings/weights"))
        self.assertEqual(call.body, {"weights": FULL_WEIGHTS, "expected_version": "v"})
        self.assertTrue(call.key and call.key.startswith("pwq-settings-weights-save-"))

    def test_bare_six_keys_are_accepted_as_a_shorthand(self):
        self.run_client("habits-weights", "preview", "--json", json.dumps(FULL_WEIGHTS))
        self.assertEqual(self.only_write().body, {"weights": FULL_WEIGHTS})

    def test_individual_flags_merge_over_the_stored_weights(self):
        self.run_client("habits-weights", "preview", "--effort", "0", "--deadline", "2")
        body = self.only_write().body
        self.assertEqual(body["weights"], {**SNAPSHOT["weights"]["weights"],
                                           "effort": 0.0, "deadline": 2.0})
        self.assertEqual(len(body["weights"]), 6, "the draft sent must always be complete")

    def test_json_and_individual_flags_cannot_be_mixed(self):
        code, err = self.expect_exit("habits-weights", "preview",
                                     "--json", json.dumps({"weights": FULL_WEIGHTS}),
                                     "--effort", "0")
        self.assertEqual(code, 2)
        self.assertIn("not both", err)

    def test_an_incomplete_json_draft_is_rejected_before_sending(self):
        code, err = self.expect_exit("habits-weights", "preview",
                                     "--json", json.dumps({"weights": {"deadline": 2}}))
        self.assertEqual(code, 2)
        self.assertIn("missing", err)
        self.assertEqual(self.writes, [])

    def test_malformed_and_non_object_json_are_usage_errors(self):
        for bad in ("{not json", '"a string"', "[1, 2]", json.dumps({"peak_hours": [9]})):
            with self.subTest(bad=bad):
                self.calls.clear()
                code, _ = self.expect_exit("habits-weights", "preview", "--json", bad)
                self.assertEqual(code, 2)
                self.assertEqual(self.writes, [])

    def test_unknown_draft_keys_are_dropped_rather_than_forwarded(self):
        self.run_client("habits-weights", "preview", "--json",
                        json.dumps({"weights": FULL_WEIGHTS, "hours_per_day": 4}))
        # Conversion coefficients are not part of the weights draft — they have
        # their own route, and the server's schema would reject them here.
        self.assertEqual(self.only_write().body, {"weights": FULL_WEIGHTS})

    def test_no_draft_at_all_is_a_usage_error(self):
        code, err = self.expect_exit("habits-weights", "preview")
        self.assertEqual(code, 2)
        self.assertIn("--json", err)


class TestIdempotency(ClientTestCase):
    def test_explicit_stable_mode_derives_the_same_retry_key(self):
        argv = ("habits-explicit", "add", "--statement", "少开会", "--expected-version", "v1", "--stable-key")
        self.run_client(*argv)
        first = self.only_write().key
        self.calls.clear()
        self.run_client(*argv)
        self.assertEqual(self.only_write().key, first,
                         "re-running an identical command must replay, not duplicate")

    def test_a_different_body_derives_a_different_key(self):
        self.run_client("habits-explicit", "add", "--statement", "少开会",
                        "--expected-version", "v1")
        first = self.only_write().key
        self.calls.clear()
        self.run_client("habits-explicit", "add", "--statement", "多写文档",
                        "--expected-version", "v1")
        self.assertNotEqual(self.only_write().key, first)

    def test_new_key_forces_a_fresh_one(self):
        argv = ("habits-explicit", "add", "--statement", "少开会", "--expected-version", "v1")
        self.run_client(*argv)
        derived = self.only_write().key
        self.calls.clear()
        self.run_client(*argv, "--new-key")
        self.assertNotEqual(self.only_write().key, derived)


if __name__ == "__main__":
    unittest.main(verbosity=2)
