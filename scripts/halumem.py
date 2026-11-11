#!/usr/bin/env python3
"""Pinned HaluMem data, native Workbench replay, and official judge integration."""
import argparse
import ast
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from urllib.parse import urlencode
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from halumem_judge import JudgeProxy

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / ".cache" / "halumem"
UPSTREAM_COMMIT = "d653749586bfc7d13f5b68e8851f52155b5b1650"
DATASET = "IAAR-Shanghai/HaluMem"
DATASET_REVISION = "cb04336aa1b732d4b24f5186c552456b4099806e"
DATASET_HASHES = {
    "medium": "486fbc130a5c8781a2af27ffa508a1d7855245137aa449c193ac4d29c45634e7",
    "long": "dfdbed570b402b7b8c17e0d7808fc6f3ae7a53b6144f18feb16bbdd3f55cb0c9",
}


def identity(value):
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", value):
        raise ValueError("Invalid evaluation identity")
    return value


def file_hash(path):
    with path.open("rb") as content:
        return hashlib.file_digest(content, "sha256").hexdigest()


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def read_json_url(url):
    with urlopen(url, timeout=60) as response:
        return json.load(response)


def load_env(path):
    # Only this benchmark's namespace is imported. Existing shell values take priority.
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        match = re.fullmatch(r"\s*(HALUMEM_[A-Z0-9_]+|judge_LLM_API_BASE|judge_LLM_API_KEY|judge_LLM_MODELID)\s*=\s*(.*?)\s*", line)
        if match:
            os.environ.setdefault(match[1], match[2].strip("\"'"))


def fetch_data(args):
    upstream = CACHE / "upstream"
    if not upstream.exists():
        subprocess.run(["git", "clone", "--no-checkout", "https://github.com/MemTensor/HaluMem.git", str(upstream)], check=True)
    subprocess.run(["git", "-C", str(upstream), "checkout", "--detach", UPSTREAM_COMMIT], check=True)
    source = ast.parse((upstream / "eval" / "prompts.py").read_text(encoding="utf-8"))
    prompts = {node.targets[0].id: ast.literal_eval(node.value) for node in source.body if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name) and node.targets[0].id.startswith("PROMPT_")}
    save(CACHE / "prompts.json", prompts)
    revision = DATASET_REVISION
    tree = read_json_url(f"https://huggingface.co/api/datasets/{DATASET}/tree/{revision}")
    manifest_path = CACHE / "sources.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {"datasets": {}}
    manifest.update(upstream_commit=UPSTREAM_COMMIT, dataset=DATASET)
    variants = ["medium", "long"] if args.dataset == "both" else [args.dataset]
    for variant in variants:
        name = f"HaluMem-{variant.title()}.jsonl"
        entry = next(item for item in tree if item["path"] == name)
        expected = entry["lfs"]["oid"]
        if expected != DATASET_HASHES[variant]:
            raise ValueError("Official dataset digest differs from pinned digest")
        target = CACHE / "data" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists() or file_hash(target) != expected:
            temporary = target.with_suffix(".download")
            with urlopen(f"https://huggingface.co/datasets/{DATASET}/resolve/{revision}/{name}", timeout=180) as response, temporary.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
            with temporary.open("rb") as downloaded:
                if hashlib.file_digest(downloaded, "sha256").hexdigest() != expected:
                    raise ValueError("Dataset checksum mismatch")
            temporary.replace(target)
        manifest["datasets"][variant] = {"revision": revision, "sha256": expected, "size": target.stat().st_size, "file": target.relative_to(ROOT).as_posix()}
        save(manifest_path, manifest)
        print(json.dumps({"dataset": variant, **manifest["datasets"][variant]}), flush=True)


def timestamp(value):
    try:
        date = datetime.strptime(value, "%b %d, %Y, %H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        date = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if date.tzinfo is None:
            date = date.replace(tzinfo=timezone.utc)
    return date.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def selected_users(path, limit):
    with path.open(encoding="utf-8") as content:
        for index, line in enumerate(content):
            if index >= limit:
                break
            yield json.loads(line)


def api(path, body=None):
    base = os.environ.get("HALUMEM_URL", "http://127.0.0.1:4243").rstrip("/")
    token = os.environ.get("HALUMEM_API_TOKEN")
    if not token:
        raise ValueError("Set HALUMEM_API_TOKEN")
    request = Request(base + path, data=None if body is None else json.dumps(body).encode(), headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urlopen(request, timeout=600) as response:
            return json.load(response)
    except HTTPError as error:
        try:
            detail = json.load(error).get("error", {}).get("message", "Evaluation API rejected the request")
        except (ValueError, AttributeError):
            detail = "Evaluation API rejected the request"
        raise RuntimeError(f"HaluMem API {error.code}: {detail}") from None


def session_api(output, user_id, session_id, path, body, attempts):
    key = hashlib.sha256(json.dumps({"path": path, "body": body}, sort_keys=True).encode()).hexdigest()
    cached = output / "requests" / user_id / session_id / (key + ".json")
    if cached.exists():
        return json.loads(cached.read_text(encoding="utf-8"))
    for attempt in range(1, attempts + 1):
        try:
            value = api(path, body)
            save(cached, value)
            return value
        except (RuntimeError, URLError, TimeoutError, ConnectionError) as error:
            transient = not isinstance(error, RuntimeError) or re.match(r"HaluMem API (429|502|503|504):", str(error))
            print(json.dumps({"event": "request.failed", "user": user_id, "session": session_id, "path": path.split("?")[0], "attempt": attempt, "retrying": bool(transient and attempt < attempts), "error": str(error)}), flush=True)
            if not transient or attempt == attempts:
                raise
            time.sleep(min(30, 2 ** attempt))


def replay_user(user, args, output):
    identity(user["uuid"])
    user_path = output / "users" / f"{user['uuid']}.json"
    result = json.loads(user_path.read_text(encoding="utf-8")) if user_path.exists() else {"uuid": user["uuid"], "user_name": user["uuid"], "sessions": []}
    sessions = user["sessions"][:args.max_sessions] if args.max_sessions else user["sessions"]
    previous = None
    for index, session in enumerate(sessions):
        current = timestamp(session["start_time"])
        corpus_diagnostics = []
        if previous and current < previous:
            corpus_diagnostics.append({"kind": "timestamp_regression", "previous": previous, "current": current})
            print(json.dumps({"event": "corpus.timestamp_regression", "user": user["uuid"], "session": index, "previous": previous, "current": current}), flush=True)
        previous = current
        if index < len(result["sessions"]):
            continue
        scope = {"run_id": args.run_id, "user_id": user["uuid"]}
        session_id = f"session-{index}"
        dialogue = [{"role": turn["role"], "content": turn["content"], "timestamp": timestamp(turn["timestamp"])} for turn in session["dialogue"]]
        print(json.dumps({"event": "session.started", "user": user["uuid"], "session": index, "turns": len(dialogue)}), flush=True)
        def request(path, body=None):
            return session_api(output, user["uuid"], session_id, path, body, getattr(args, "attempts", 3))
        # Gold memories, persona_info, questions and answers never enter this payload.
        added = request("/add-dialogue", {**scope, "session_id": session_id, "timestamp": current, "dialogue": dialogue})
        extracted = request("/get-dialogue-memory?" + urlencode({**scope, "session_id": session_id}))
        item = {"dialogue": session["dialogue"], "memory_points": json.loads(json.dumps(session.get("memory_points", []))), "extracted_memories": [memory["memory"] for memory in extracted["memories"]], "add_dialogue_duration_ms": added["duration_ms"], "extraction_usage": added.get("extraction_usage"), "adapter_diagnostics": added["diagnostics"], "questions": []}
        if corpus_diagnostics:
            item["corpus_diagnostics"] = corpus_diagnostics
        if session.get("is_generated_qa_session", False):
            item["is_generated_qa_session"] = True
        for memory in item["memory_points"]:
            if str(memory.get("is_update")).lower() == "true" and memory.get("original_memories"):
                found = request("/retrieve-memory", {**scope, "query": memory["memory_content"], "top_k": 10})
                memory["memories_from_system"] = [f"{row['timestamp']}: {row['memory']}" for row in found["memories"]]
                memory["retrieval_diagnostics"] = found.get("retrieval_diagnostics", [])
        questions = session.get("questions", [])
        if args.max_questions:
            questions = questions[:args.max_questions]
        for question in questions:
            found = request("/retrieve-memory", {**scope, "query": question["question"], "top_k": 20, "generate_answer": True})
            item["questions"].append({**question, "context": found["context"], "system_response": found["system_response"], "search_duration_ms": found["search_duration_ms"], "response_duration_ms": found["response_duration_ms"], "qa_usage": found.get("qa_usage"), "retrieval_diagnostics": found.get("retrieval_diagnostics", [])})
        result["sessions"].append(item)
        save(user_path, result)
        print(json.dumps({"event": "session.completed", "user": user["uuid"], "session": index, "memories": len(item["extracted_memories"]), "questions": len(item["questions"]), "diagnostics": len(item["adapter_diagnostics"])}), flush=True)
    return result


def replay(args):
    identity(args.run_id)
    source_path = CACHE / "sources.json"
    sources = json.loads(source_path.read_text(encoding="utf-8"))
    dataset = sources["datasets"][args.dataset]
    path = ROOT / dataset["file"]
    if dataset["revision"] != DATASET_REVISION or dataset["sha256"] != DATASET_HASHES[args.dataset] or file_hash(path) != dataset["sha256"]:
        raise ValueError("Dataset differs from pinned source")
    health = api("/health")
    if health["model"]["modelId"] != "gpt-6-luna":
        raise ValueError("The evaluated model must be gpt-6-luna")
    output = CACHE / "results" / args.run_id
    metadata_path = output / "run.json"
    selection = {"dataset": args.dataset, "limit_users": args.limit_users, "max_sessions": args.max_sessions, "max_questions": args.max_questions, "dataset_sha256": dataset["sha256"], "upstream_commit": UPSTREAM_COMMIT, "model": health["model"]}
    if metadata_path.exists() and json.loads(metadata_path.read_text(encoding="utf-8"))["selection"] != selection:
        raise ValueError("Run ID already uses different data, limits or model")
    prior = json.loads(metadata_path.read_text(encoding="utf-8")) if metadata_path.exists() else {}
    metadata = {"selection": selection, "status": "replaying", "started_at": prior.get("started_at", datetime.now(timezone.utc).isoformat()), "judge_status": "not_configured", "users": 0, "sessions": 0, "questions": 0}
    metadata["execution"] = {"parallel_users": getattr(args, "workers", 1), "request_attempts": getattr(args, "attempts", 3), "request_journal": True, "session_order": "official_dataset_order"}
    save(metadata_path, metadata)
    failures = []
    with ThreadPoolExecutor(max_workers=getattr(args, "workers", 1)) as executor:
        futures = {executor.submit(replay_user, user, args, output): user["uuid"] for user in selected_users(path, args.limit_users)}
        for future in as_completed(futures):
            try:
                result = future.result()
            except Exception as error:
                failures.append({"user": futures[future], "error": str(error)})
                metadata["failures"] = failures
                print(json.dumps({"event": "user.failed", **failures[-1]}), flush=True)
            else:
                metadata["users"] += 1
                metadata["sessions"] += len(result["sessions"])
                metadata["questions"] += sum(len(item.get("questions", [])) for item in result["sessions"])
                print(json.dumps({"event": "user.completed", "user": result["uuid"], "sessions": len(result["sessions"])}), flush=True)
            save(metadata_path, metadata)
    if failures:
        metadata["status"] = "replay_failed"
        save(metadata_path, metadata)
        raise RuntimeError(f"{len(failures)} corpus users remain incomplete; retry the same command to resume")
    artifacts = output / "workbench_eval_results.jsonl"
    artifacts.write_text("".join(json.dumps(json.loads(item.read_text(encoding="utf-8")), ensure_ascii=False) + "\n" for item in sorted((output / "users").glob("*.json"))), encoding="utf-8")
    metadata["status"] = "artifacts_ready"
    metadata["artifact_sha256"] = hashlib.sha256(artifacts.read_bytes()).hexdigest()
    metadata["judge_status"] = prior.get("judge_status", "awaiting_configuration") if prior.get("artifact_sha256") == metadata["artifact_sha256"] else "awaiting_configuration"
    save(metadata_path, metadata)
    print(json.dumps(metadata), flush=True)


def ratio(numerator, denominator):
    return numerator / denominator if denominator else None


def aggregate(records):
    integrity = records["memory_integrity_records"]
    target = [item for item in integrity if item["memory_source"] != "interference"]
    distractors = [item for item in integrity if item["memory_source"] == "interference"]
    accuracy = records["memory_accuracy_records"]
    matching = [item for item in accuracy if str(item.get("is_included_in_golden_memories")).lower() == "true"]
    metrics = {}
    for valid_only, suffix in [(False, "all"), (True, "valid")]:
        selected = [item for item in target if not valid_only or item["is_valid"]]
        selected_accuracy = [item for item in accuracy if not valid_only or item["is_valid"]]
        selected_matching = [item for item in matching if not valid_only or item["is_valid"]]
        selected_distractors = [item for item in distractors if not valid_only or item["is_valid"]]
        recall = ratio(sum(item.get("memory_integrity_score") == 2 for item in selected), len(selected))
        precision = ratio(sum((item.get("memory_accuracy_score") or 0) / 2 for item in selected_matching), len(selected_matching))
        metrics[suffix] = {
            "memory_recall": recall,
            "weighted_memory_recall": ratio(sum((item.get("memory_integrity_score") or 0) * item["importance"] / 2 for item in selected), sum(item["importance"] for item in selected)),
            "target_memory_precision": precision,
            "memory_accuracy": ratio(sum((item.get("memory_accuracy_score") or 0) / 2 for item in selected_accuracy), len(selected_accuracy)),
            "false_memory_resistance": ratio(sum(item.get("memory_integrity_score") == 0 for item in selected_distractors), len(selected_distractors)),
            "memory_extraction_f1": None if recall is None or precision is None else 2 * recall * precision / (recall + precision) if recall + precision else 0,
            "denominators": {"target_memories": len(selected), "target_importance": sum(item["importance"] for item in selected), "extracted_memories": len(selected_accuracy), "matched_memories": len(selected_matching), "distractors": len(selected_distractors)},
        }
    for group, field in [("memory_update_records", "memory_update_type"), ("question_answering_records", "result_type")]:
        items = records[group]
        categories = ["Correct", "Hallucination", "Omission"] + (["Other"] if field == "memory_update_type" else [])
        metrics[group] = {"all": {name.lower(): ratio(sum(item.get(field) == name for item in items), len(items)) for name in categories}, "valid": {name.lower(): ratio(sum(item.get(field) == name for item in items), sum(item["is_valid"] for item in items)) for name in categories}, "count": len(items), "valid_count": sum(item["is_valid"] for item in items)}
    metrics["memory_type_accuracy"] = {}
    for kind in ["Event Memory", "Persona Memory", "Relationship Memory"]:
        selected = [item for item in integrity if item["memory_type"] == kind]
        updates = [item for item in records["memory_update_records"] if item["memory_type"] == kind]
        denominator = len(selected) + len(updates)
        recalled = sum(item.get("memory_integrity_score") == 2 for item in selected)
        updated = sum(item.get("memory_update_type") == "Correct" for item in updates)
        metrics["memory_type_accuracy"][kind] = {"memory_integrity_acc": ratio(recalled, denominator), "memory_update_acc": ratio(updated, denominator), "memory_acc": ratio(recalled + updated, denominator), "total_num": denominator}
    return metrics


def validate_judgments(records):
    invalid = 0
    for key, field, allowed in [
        ("memory_integrity_records", "memory_integrity_score", [0, 1, 2]),
        ("memory_accuracy_records", "memory_accuracy_score", [0, 1, 2]),
        ("memory_update_records", "memory_update_type", ["Correct", "Hallucination", "Omission", "Other"]),
        ("question_answering_records", "result_type", ["Correct", "Hallucination", "Omission"]),
    ]:
        for item in records[key]:
            value = item.get(field)
            item["is_valid"] = value in allowed and (field not in ["memory_integrity_score", "memory_accuracy_score"] or type(value) is int)
            if not item["is_valid"]:
                item["invalid_judge_value"] = value
                item[field] = None
                invalid += 1
    return invalid


def score(args):
    identity(args.run_id)
    required = ["judge_LLM_API_BASE", "judge_LLM_API_KEY", "judge_LLM_MODELID"]
    missing = [key for key in required if not os.environ.get(key)]
    if missing:
        raise ValueError("Configure the judge in .env before scoring: " + ", ".join(missing))
    output = CACHE / "results" / args.run_id
    metadata = json.loads((output / "run.json").read_text(encoding="utf-8"))
    if metadata["status"] != "artifacts_ready":
        raise ValueError("Complete corpus replay before scoring")
    artifact_hash = file_hash(output / "workbench_eval_results.jsonl")
    if artifact_hash != metadata["artifact_sha256"]:
        raise ValueError("Replay artifacts changed after completion")
    upstream = CACHE / "upstream" / "eval"
    actual = subprocess.check_output(["git", "-C", str(upstream.parent), "rev-parse", "HEAD"], text=True).strip()
    if actual != UPSTREAM_COMMIT:
        raise ValueError("Official evaluator revision differs from pinned revision")
    subprocess.run(["git", "-C", str(upstream.parent), "diff", "--exit-code", "HEAD", "--", "eval"], check=True, stdout=subprocess.DEVNULL)
    records = {key: [] for key in ["memory_integrity_records", "memory_accuracy_records", "memory_update_records", "question_answering_records"]}
    judge_config = {"artifact_sha256": artifact_hash, "model_id": os.environ[required[2]], "baseurl_sha256": hashlib.sha256(os.environ[required[0]].encode()).hexdigest(), "upstream_commit": UPSTREAM_COMMIT, "transport": "bare-json-fence-v1"}
    cache_id = hashlib.sha256(json.dumps(judge_config, sort_keys=True).encode()).hexdigest()[:24]
    with JudgeProxy(os.environ[required[0]], os.environ[required[1]], os.environ[required[2]], output / "judge-responses" / cache_id) as proxy:
        os.environ.update(OPENAI_BASE_URL=proxy.base_url, OPENAI_API_KEY=proxy.token, OPENAI_MODEL=os.environ[required[2]], RETRY_TIMES="3", WAIT_TIME_LOWER="1", WAIT_TIME_UPPER="8", OPENAI_TIMEOUT="150")
        sys.path.insert(0, str(upstream))
        spec = importlib.util.spec_from_file_location("halumem_official_evaluation", upstream / "evaluation.py")
        evaluator = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(evaluator)
        try:
            for index, line in enumerate((output / "workbench_eval_results.jsonl").read_text(encoding="utf-8").splitlines(), 1):
                user = json.loads(line)
                identity(user["uuid"])
                judged = output / "judged" / cache_id / f"{user['uuid']}.json"
                if judged.exists():
                    result = json.loads(judged.read_text(encoding="utf-8"))
                else:
                    result = evaluator.process_user(index, user, max_workers=args.workers)
                    save(judged, result)
                for key in records:
                    records[key].extend(result[key])
        finally:
            save(output / "judge-transport.json", {"judge": judge_config, "current_attempt": proxy.stats, "recorded_at": datetime.now(timezone.utc).isoformat()})
    invalid = validate_judgments(records)
    result = {"status": "incomplete" if invalid else "scored", "invalid_judgments": invalid, "judge": judge_config, "agent_model": metadata["selection"]["model"], "selection": metadata["selection"], "metrics": aggregate(records), "records": records}
    save(output / "scores.json", result)
    metadata["judge_status"] = result["status"]
    save(output / "run.json", metadata)
    print(json.dumps({key: value for key, value in result.items() if key != "records"}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env", type=Path, default=ROOT / ".env")
    commands = parser.add_subparsers(dest="command", required=True)
    download = commands.add_parser("fetch")
    download.add_argument("--dataset", choices=["medium", "long", "both"], default="medium")
    run = commands.add_parser("run")
    run.add_argument("--dataset", choices=["medium", "long"], default="medium")
    run.add_argument("--run-id", required=True)
    run.add_argument("--limit-users", type=int, default=1)
    run.add_argument("--max-sessions", type=int, default=3)
    run.add_argument("--max-questions", type=int, default=3)
    run.add_argument("--workers", type=int, default=1, help="Independent users in parallel; each user's sessions remain chronological")
    run.add_argument("--attempts", type=int, default=3, help="Maximum attempts per transiently failed API operation")
    scoring = commands.add_parser("score")
    scoring.add_argument("--run-id", required=True)
    scoring.add_argument("--workers", type=int, default=1)
    args = parser.parse_args()
    load_env(args.env)
    if args.command == "fetch":
        fetch_data(args)
    elif args.command == "run":
        if args.limit_users < 1 or args.max_sessions < 0 or args.max_questions < 0 or args.workers < 1 or args.attempts < 1:
            parser.error("User count must be positive and limits must be non-negative; zero removes a session/question limit")
        replay(args)
    else:
        if args.workers < 1:
            parser.error("Judge worker count must be positive")
        score(args)


if __name__ == "__main__":
    main()
