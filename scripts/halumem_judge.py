"""Local transport compatibility for the unmodified HaluMem judge parser."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import secrets
import threading
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


class QuotaExhausted(RuntimeError):
    def __init__(self, stage):
        self.stage = stage
        super().__init__(f"HaluMem {stage} model quota exhausted")


QUOTA_ERROR = re.compile(
    r"insufficient[ _-](?:quota|balance|credits)|usage_limit_reached|usage_not_included|"
    r"billing_hard_limit_reached|exceeded your current quota|quota (?:exceeded|exhausted)|"
    r"usage limit (?:has been )?reached|out of budget|credit balance is too low|余额不足|额度(?:不足|已用尽)",
    re.IGNORECASE,
)


def normalize_completion(completion):
    """Add only the fence required by upstream when content is already a JSON object."""
    for choice in completion.get("choices", []):
        message = choice.get("message", {})
        content = message.get("content")
        if not isinstance(content, str):
            continue
        try:
            value = json.loads(content)
        except ValueError:
            continue
        if isinstance(value, dict):
            message["content"] = "```json\n" + content + "\n```"
    return completion


def cacheable(completion):
    try:
        content = completion["choices"][0]["message"]["content"].strip()
        if content.startswith("```json") and content.endswith("```"):
            content = content[7:-3].strip()
        value = json.loads(content)
        if "score" in value:
            return str(value["score"]) in ["0", "1", "2"]
        if "accuracy_score" in value:
            return str(value["accuracy_score"]) in ["0", "1", "2"]
        return value.get("evaluation_result") in ["Correct", "Hallucination", "Omission", "Other"]
    except (KeyError, IndexError, TypeError, ValueError, AttributeError):
        return False


class JudgeProxy:
    """Authenticate locally, forward unchanged prompts, and cache each valid response."""
    def __init__(self, base_url, api_key, model_id, cache_root):
        parsed = urlsplit(base_url)
        if parsed.scheme not in ["http", "https"] or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("Judge API base must be an HTTP(S) root without embedded credentials, query or fragment")
        self.endpoint = base_url.rstrip("/") + "/chat/completions"
        self.api_key = api_key
        self.model_id = model_id
        self.token = secrets.token_urlsafe(32)
        self.cache_root = Path(cache_root)
        self.lock = threading.Lock()
        self.quota_exhausted = threading.Event()
        self.request_locks = {}
        self.stats = {"network_requests": 0, "cache_hits": 0, "failures": 0, "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "fenced_json_responses": 0, "response_models": []}
        proxy = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                if self.path != "/v1/chat/completions" or self.headers.get("Authorization") != "Bearer " + proxy.token:
                    self.send_result(403, {"error": {"message": "Invalid local judge request"}})
                    return
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 16 * 1024 * 1024:
                    self.send_result(400, {"error": {"message": "Invalid judge request length"}})
                    return
                try:
                    payload = json.loads(self.rfile.read(size))
                    if payload.get("model") != proxy.model_id or payload.get("stream"):
                        raise ValueError("Unexpected judge model or streaming request")
                    result = proxy.request(payload)
                    self.send_result(200, result)
                except QuotaExhausted as error:
                    self.send_result(402, {"error": {"code": "quota_exhausted", "message": str(error)}})
                except HTTPError as error:
                    self.send_result(error.code, {"error": {"message": "Configured judge upstream rejected the request"}})
                except (ValueError, TypeError, OSError, URLError):
                    self.send_result(502, {"error": {"message": "Configured judge returned an invalid response or is unavailable"}})

            def send_result(self, status, value):
                body = json.dumps(value, ensure_ascii=False).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                try:
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_args):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    @property
    def base_url(self):
        return f"http://127.0.0.1:{self.server.server_port}/v1"

    def request(self, payload):
        body = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
        digest = hashlib.sha256(body).hexdigest()
        with self.lock:
            request_lock = self.request_locks.setdefault(digest, threading.Lock())
        with request_lock:
            cached = self.cache_root / (digest + ".json")
            if cached.exists():
                with self.lock:
                    self.stats["cache_hits"] += 1
                return json.loads(cached.read_text(encoding="utf-8"))
            with self.lock:
                if self.quota_exhausted.is_set():
                    raise QuotaExhausted("judge")
                self.stats["network_requests"] += 1
            try:
                request = Request(self.endpoint, data=body, headers={"Authorization": "Bearer " + self.api_key, "Content-Type": "application/json"})
                with urlopen(request, timeout=120) as response:
                    result = json.load(response)
                if isinstance(result, dict) and QUOTA_ERROR.search(json.dumps(result.get("error"), ensure_ascii=False)):
                    self.quota_exhausted.set()
                    raise QuotaExhausted("judge")
            except HTTPError as error:
                with self.lock:
                    self.stats["failures"] += 1
                with error:
                    if error.code == 402 or QUOTA_ERROR.search(error.read(8192).decode("utf-8", errors="replace")):
                        self.quota_exhausted.set()
                        raise QuotaExhausted("judge") from None
                raise
            except (OSError, ValueError):
                with self.lock:
                    self.stats["failures"] += 1
                raise
            before = [choice.get("message", {}).get("content") for choice in result.get("choices", [])]
            result = normalize_completion(result)
            after = [choice.get("message", {}).get("content") for choice in result.get("choices", [])]
            with self.lock:
                self.stats["fenced_json_responses"] += before != after
                usage = result.get("usage") or {}
                for key in ["prompt_tokens", "completion_tokens", "total_tokens"]:
                    self.stats[key] += usage.get(key) or 0
                model = result.get("model")
                if model and model not in self.stats["response_models"]:
                    self.stats["response_models"].append(model)
            if cacheable(result):
                cached.parent.mkdir(parents=True, exist_ok=True)
                temporary = cached.with_suffix(".tmp")
                temporary.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
                temporary.replace(cached)
            return result
