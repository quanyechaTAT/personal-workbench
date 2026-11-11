"""Offline regression tests for HaluMem replay boundaries and aggregation."""
import argparse
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import halumem
from halumem_judge import JudgeProxy, cacheable, normalize_completion


def empty_records():
    return {name: [] for name in ["memory_integrity_records", "memory_accuracy_records", "memory_update_records", "question_answering_records"]}


class HaluMemTests(unittest.TestCase):
    def test_parallel_users_keep_official_session_order_even_when_source_timestamps_regress(self):
        barrier = threading.Barrier(2)
        observed = {"alice": [], "bob": []}
        def api(path, body=None):
            if path == "/health":
                return {"model": {"provider": "openai-codex", "modelId": "gpt-6-luna"}}
            if path == "/add-dialogue":
                observed[body["user_id"]].append(body["session_id"])
                if body["session_id"] == "session-0":
                    barrier.wait(timeout=5)
                return {"duration_ms": 1, "diagnostics": []}
            if path.startswith("/get-dialogue-memory?"):
                return {"memories": []}
            self.fail(path)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            session = {"start_time": "Jan 01, 2025, 00:00:00", "dialogue": [{"role": "user", "content": "user", "timestamp": "Jan 01, 2025, 00:00:00"}, {"role": "assistant", "content": "assistant", "timestamp": "Jan 01, 2025, 00:00:01"}]}
            second = {**session, "start_time": "Dec 31, 2024, 00:00:00"}
            dataset = root / "corpus.jsonl"
            dataset.write_text("".join(json.dumps({"uuid": name, "sessions": [session, second]}) + "\n" for name in observed), encoding="utf-8")
            digest = halumem.file_hash(dataset)
            halumem.save(root / "sources.json", {"datasets": {"medium": {"file": "corpus.jsonl", "sha256": digest, "revision": halumem.DATASET_REVISION}}})
            args = argparse.Namespace(run_id="parallel", dataset="medium", limit_users=2, max_sessions=0, max_questions=0, workers=2, attempts=1)
            with patch.object(halumem, "ROOT", root), patch.object(halumem, "CACHE", root), patch.object(halumem, "DATASET_HASHES", {"medium": digest}), patch.object(halumem, "api", side_effect=api), contextlib.redirect_stdout(io.StringIO()):
                halumem.replay(args)
            self.assertEqual(observed, {name: ["session-0", "session-1"] for name in observed})
            metadata = json.loads((root / "results/parallel/run.json").read_text())
            self.assertEqual(metadata["sessions"], 4)
            self.assertEqual(metadata["status"], "artifacts_ready")
            artifact = json.loads((root / "results/parallel/users/alice.json").read_text())
            self.assertEqual(artifact["sessions"][1]["corpus_diagnostics"][0]["kind"], "timestamp_regression")

    def test_request_journal_survives_failure_without_reusing_another_sessions_context(self):
        body = {"query": "home city", "top_k": 20, "generate_answer": True}
        with tempfile.TemporaryDirectory() as directory, patch.object(halumem, "api", side_effect=[RuntimeError("HaluMem API 502: temporary model failure"), {"system_response": "Paris"}, {"system_response": "Berlin"}]) as api, patch.object(halumem.time, "sleep"), contextlib.redirect_stdout(io.StringIO()):
            root = Path(directory)
            first = halumem.session_api(root, "alice", "session-0", "/retrieve-memory", body, 3)
            self.assertEqual(first["system_response"], "Paris")
            self.assertEqual(halumem.session_api(root, "alice", "session-0", "/retrieve-memory", body, 3), first)
            self.assertEqual(halumem.session_api(root, "alice", "session-1", "/retrieve-memory", body, 3)["system_response"], "Berlin")
            self.assertEqual(api.call_count, 3)

    def test_judge_fence_adaptation_preserves_the_entire_json_value(self):
        content = '{"score":"2","reasoning":"来源充分\\n中文"}'
        value = {"choices": [{"message": {"content": content}}]}
        normalized = normalize_completion(value)
        self.assertEqual(normalized["choices"][0]["message"]["content"], "```json\n" + content + "\n```")
        self.assertTrue(cacheable(normalized))
        self.assertEqual(normalize_completion(normalized), normalized)
        self.assertFalse(cacheable({"choices": [{"message": {"content": '{"score":9}'}}]}))

    def test_judge_proxy_authentication_and_per_prompt_recovery_cache(self):
        payload = {"model": "fixture-judge", "messages": [{"role": "user", "content": "Original official prompt"}]}
        upstream_reply = {"model": "fixture-judge", "choices": [{"message": {"content": '{"score":"2","reasoning":"supported"}'}}], "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}}
        with tempfile.TemporaryDirectory() as directory, patch("halumem_judge.urlopen", return_value=io.BytesIO(json.dumps(upstream_reply).encode())) as upstream:
            with JudgeProxy("https://judge.example/v1", "fixture-only", "fixture-judge", directory) as proxy:
                url = proxy.base_url + "/chat/completions"
                for _ in range(2):
                    request = Request(url, data=json.dumps(payload).encode(), headers={"Authorization": "Bearer " + proxy.token, "Content-Type": "application/json"})
                    with urlopen(request, timeout=5) as response:
                        self.assertTrue(cacheable(json.load(response)))
                with self.assertRaises(HTTPError):
                    urlopen(Request(url, data=json.dumps(payload).encode()), timeout=5)
                self.assertEqual(proxy.stats["network_requests"], 1)
                self.assertEqual(proxy.stats["cache_hits"], 1)
                self.assertEqual(proxy.stats["total_tokens"], 15)
            upstream.assert_called_once()
            self.assertEqual(json.loads(upstream.call_args.args[0].data), payload)
            with JudgeProxy("https://judge.example/v1", "fixture-only", "fixture-judge", directory) as reopened:
                self.assertTrue(cacheable(reopened.request(payload)))
                self.assertEqual(reopened.stats["network_requests"], 0)

    def test_empty_categories_are_undefined_not_perfect(self):
        records = empty_records()
        self.assertEqual(halumem.validate_judgments(records), 0)
        metrics = halumem.aggregate(records)
        self.assertIsNone(metrics["all"]["memory_extraction_f1"])
        self.assertIsNone(metrics["memory_update_records"]["all"]["correct"])

    def test_invalid_judge_values_cannot_inflate_scores(self):
        records = empty_records()
        records["memory_integrity_records"] = [
            {"memory_source": "user", "memory_type": "Persona Memory", "importance": 2, "memory_integrity_score": 2},
            {"memory_source": "user", "memory_type": "Persona Memory", "importance": 2, "memory_integrity_score": 9},
            {"memory_source": "interference", "memory_type": "Persona Memory", "importance": 1, "memory_integrity_score": 0},
        ]
        records["memory_accuracy_records"] = [
            {"is_included_in_golden_memories": "True", "memory_accuracy_score": 2},
            {"is_included_in_golden_memories": "True", "memory_accuracy_score": True},
        ]
        records["memory_update_records"] = [{"memory_update_type": "Other", "memory_type": "Persona Memory"}]
        records["question_answering_records"] = [{"result_type": "unexpected"}]
        self.assertEqual(halumem.validate_judgments(records), 3)
        metrics = halumem.aggregate(records)
        self.assertEqual(metrics["all"]["memory_recall"], .5)
        self.assertEqual(metrics["valid"]["memory_recall"], 1)
        self.assertEqual(metrics["all"]["weighted_memory_recall"], .5)
        self.assertEqual(metrics["all"]["target_memory_precision"], .5)
        self.assertEqual(metrics["memory_update_records"]["all"]["other"], 1)
        self.assertEqual(metrics["question_answering_records"]["valid_count"], 0)

    def test_user_judge_field_names_and_shell_precedence(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"judge_LLM_MODELID": "shell-judge"}, clear=True):
            path = Path(directory) / ".env"
            path.write_text('judge_LLM_API_BASE="http://localhost:9999/v1"\njudge_LLM_API_KEY=fixture-only\njudge_LLM_MODELID=file-judge\nUNRELATED_SECRET=ignored\n')
            halumem.load_env(path)
            self.assertEqual(os.environ["judge_LLM_MODELID"], "shell-judge")
            self.assertEqual(os.environ["judge_LLM_API_KEY"], "fixture-only")
            self.assertNotIn("UNRELATED_SECRET", os.environ)

    def test_missing_judge_fails_before_any_network_or_artifact_read(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(halumem, "api") as api:
            with self.assertRaisesRegex(ValueError, "judge_LLM_API_BASE"):
                halumem.score(argparse.Namespace(run_id="smoke", workers=1))
            api.assert_not_called()
        with self.assertRaisesRegex(ValueError, "Invalid evaluation identity"):
            halumem.score(argparse.Namespace(run_id="../escape", workers=1))

    def test_replay_hides_gold_and_resumes_at_session_boundary(self):
        calls = []
        def api(path, body=None):
            calls.append((path, body))
            if path == "/health":
                return {"model": {"provider": "openai-codex", "modelId": "gpt-6-luna"}}
            if path == "/add-dialogue":
                self.assertEqual(set(body), {"run_id", "user_id", "session_id", "timestamp", "dialogue"})
                self.assertEqual([turn["role"] for turn in body["dialogue"]], ["user", "assistant"])
                return {"duration_ms": 1, "diagnostics": []}
            if path.startswith("/get-dialogue-memory?"):
                return {"memories": [{"memory": "native extracted fact"}]}
            if path == "/retrieve-memory":
                self.assertNotIn("answer", body)
                self.assertIn(body["top_k"], [10, 20])
                return {"context": "native extracted fact", "memories": [{"timestamp": "2025-01-01T00:00:00Z", "memory": "native extracted fact"}], "system_response": "model answer", "search_duration_ms": 1, "response_duration_ms": 1}
            self.fail(path)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dataset = root / "corpus.jsonl"
            session = {"start_time": "Jan 01, 2025, 00:00:00", "dialogue": [{"role": "user", "content": "source user", "timestamp": "Jan 01, 2025, 00:00:00"}, {"role": "assistant", "content": "unverified source assistant", "timestamp": "Jan 01, 2025, 00:00:01"}], "memory_points": [{"is_update": "True", "original_memories": ["gold original"], "memory_content": "gold update"}], "questions": [{"question": "Which city?", "answer": "GOLD-SECRET", "evidence": []}]}
            dataset.write_text(json.dumps({"uuid": "alice", "sessions": [session]}) + "\n", encoding="utf-8")
            digest = halumem.file_hash(dataset)
            halumem.save(root / "sources.json", {"datasets": {"medium": {"file": "corpus.jsonl", "sha256": digest, "revision": halumem.DATASET_REVISION}}})
            args = argparse.Namespace(run_id="smoke", dataset="medium", limit_users=1, max_sessions=1, max_questions=1)
            with patch.object(halumem, "ROOT", root), patch.object(halumem, "CACHE", root), patch.object(halumem, "DATASET_HASHES", {"medium": digest}), patch.object(halumem, "api", side_effect=api), contextlib.redirect_stdout(io.StringIO()):
                halumem.replay(args)
                first = list(calls)
                calls.clear()
                metadata_path = root / "results/smoke/run.json"
                metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
                metadata["failures"] = [{"error": "复盘输出结构无效，需要重试"}]
                halumem.save(metadata_path, metadata)
                halumem.replay(args)
            self.assertEqual([call[0] for call in calls], ["/health"])
            qa_body = next(body for path, body in first if path == "/retrieve-memory" and body.get("generate_answer"))
            self.assertEqual(qa_body["query"], "Which city?")
            self.assertNotIn("GOLD-SECRET", json.dumps(first))
            artifact = json.loads((root / "results/smoke/workbench_eval_results.jsonl").read_text())
            self.assertEqual(artifact["sessions"][0]["questions"][0]["answer"], "GOLD-SECRET")
            self.assertEqual(artifact["sessions"][0]["extracted_memories"], ["native extracted fact"])


if __name__ == "__main__":
    unittest.main()
