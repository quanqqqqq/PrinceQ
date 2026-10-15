#!/usr/bin/env python3
import importlib.util
import io
import os
import json
import unittest
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
INSTALLED=Path(os.environ['PWQ_INSTALLED_CLIENT']) if os.environ.get('PWQ_INSTALLED_CLIENT') else None

class ClientMergeTests(unittest.TestCase):
    def setUp(self):
        spec=importlib.util.spec_from_file_location("merged_client", ROOT/"skill/scripts/pwq_client.py")
        self.client=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.client)
        self.calls=[]
        def request(base,method,path,body=None,query=None,key=None):
            self.calls.append((method,path,body,key))
            if method=="GET" and path.startswith("/api/tasks/"): return {"task":{"version":7}}
            return {"ok":True}
        self.client.request=request
        # Isolate argument/body mapping; current preview transport has its own tests.
        self.client.submit_or_control=lambda args,method,path,body,key:self.client.request(args.base,method,path,body=body,key=key)
    def run_cli(self,*args):
        with redirect_stdout(io.StringIO()),redirect_stderr(io.StringIO()):
            self.client.main(list(args))
    def write_call(self):
        return [call for call in self.calls if call[0]!="GET"][-1]
    def test_both_installed_and_repository_client_are_identical(self):
        if INSTALLED is None:
            self.skipTest("Set PWQ_INSTALLED_CLIENT to compare a separately installed client")
        self.assertEqual((ROOT/"skill/scripts/pwq_client.py").read_bytes(),INSTALLED.read_bytes())
    def test_score_decimals_reads_and_submits_expected_version(self):
        self.run_cli("score-task","task/one","--importance-score","72.5","--urgency-score","40","--reason","明确目标影响，无紧迫截止压力")
        method,path,body,key=self.write_call()
        self.assertEqual((method,path),("POST","/api/tasks/task%2Fone/matrix-score"))
        self.assertEqual(body["expected_version"],7)
        self.assertEqual(body["importance_score"],72.5)
        self.assertNotIn("source",body)
        self.assertTrue(key)
    def test_create_combines_score_and_original_duration_capability(self):
        self.run_cli("create-task","隔离任务","--duration-value","1.5","--duration-unit","day","--importance-score","50","--urgency-score","0","--reason","重要但没有紧迫截止要求")
        body=self.write_call()[2]
        self.assertEqual(body["duration_value"],1.5)
        self.assertEqual(body["matrix_score"]["importance_score"],50)
        self.assertNotIn("expected_version",body["matrix_score"])
    def test_invalid_scores_do_not_send_any_request(self):
        for score in ["nan","inf","100.1","-1","72.51"]:
            self.calls.clear()
            with self.assertRaises(SystemExit) as raised:
                self.run_cli("score-task","t","--importance-score",score,"--urgency-score","40","--reason","明确目标影响")
            self.assertEqual(raised.exception.code,2)
            self.assertEqual(self.calls,[])
    def test_fresh_calls_differ_and_explicit_retry_key_is_preserved(self):
        args=("task-action","a","claim")
        self.run_cli(*args);first=self.write_call()[3]
        self.calls.clear();self.run_cli(*args);self.assertNotEqual(self.write_call()[3],first)
        self.calls.clear();self.run_cli(*args,"--idempotency-key",first);self.assertEqual(self.write_call()[3],first)
    def test_stable_keys_are_bound_to_full_path_method_and_body(self):
        self.run_cli("task-action","a","claim","--stable-key");first=self.write_call()[3]
        self.calls.clear();self.run_cli("task-action","b","claim","--stable-key");self.assertNotEqual(self.write_call()[3],first)
        self.calls.clear();self.run_cli("task-action","a","claim","--stable-key");self.assertEqual(self.write_call()[3],first)
        fn=self.client.idempotency_key
        self.assertNotEqual(fn("POST","/x",{},"op",stable=True),fn("PATCH","/x",{},"op",stable=True))
    def test_rescoring_only_submits_requested_axis_and_supports_model_preview(self):
        self.run_cli("rescoring","submit","--id","r/1","--urgency-score","35.5","--reason","截止压力解除，重要程度不变","--agent-name","当前助手")
        self.assertEqual(self.write_call()[1],"/api/rescoring-requests/r%2F1/submit")
        self.assertNotIn("importance_score",self.write_call()[2])
        self.calls.clear();self.run_cli("agent-preview","confirm","pa_123","--session-id","session_1","--confirmed")
        self.assertEqual(self.write_call()[1],"/api/agent/preview/confirm")
        self.assertEqual(self.write_call()[2],{"token":"pa_123","session_id":"session_1"})
    def test_settings_map_survives_client_filtering(self):
        weights={key:1 for key in self.client.WEIGHT_KEYS}
        draft={"weights":weights,"task_type_peak_hours":{"deep_work":[9],"admin":[]}}
        self.run_cli("habits-weights","preview","--json",json.dumps(draft))
        self.assertEqual(self.write_call()[2]["task_type_peak_hours"],draft["task_type_peak_hours"])

if __name__=="__main__":
    unittest.main(verbosity=2)
