import concurrent.futures
import json
import math
import os
import time
from collections import Counter
from datetime import datetime, timezone

from e2b import Sandbox


# Constants: override with environment variables when adapting the benchmark.
COMMAND_TIMEOUT_SECONDS = int(os.environ.get("E2B_COMMAND_TIMEOUT_SECONDS", "30"))
READY_CHECK_COMMAND = os.environ.get("E2B_BENCH_READY_CHECK_COMMAND", "true")
BENCH_FILE_PREFIX = os.environ.get("E2B_BENCH_FILE_PREFIX", "/workspace/e2b-bench")
BENCH_FILE_CONTENT_PREFIX = os.environ.get("E2B_BENCH_FILE_CONTENT_PREFIX", "benchmark-case")


def env_int(name, default, min_value=0):
    raw = os.environ.get(name, str(default))
    try:
        value = int(raw)
    except ValueError:
        raise SystemExit(f"{name} must be an integer, got {raw!r}")
    if value < min_value:
        raise SystemExit(f"{name} must be >= {min_value}, got {value}")
    return value


def duration_ms(start_ns, end_ns=None):
    if end_ns is None:
        end_ns = time.perf_counter_ns()
    return round((end_ns - start_ns) / 1_000_000)


def sid_of(sandbox):
    return getattr(sandbox, "sandbox_id", None) or getattr(sandbox, "id", None)


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def classify_error(stage, exc):
    msg = str(exc)
    lower = msg.lower()
    if "target cluster" in lower and "not found" in lower:
        return "service_unavailable_cluster_not_found"
    if "service_unavailable" in lower or "503" in lower:
        return "service_unavailable"
    if "unauthorized" in lower or "401" in lower:
        return "auth_failed"
    if "sandbox is not running" in lower:
        return "ready_timeout" if stage == "ready" else "sandbox_not_running"
    if stage == "create":
        return "create_failed"
    if stage == "ready":
        return "ready_failed"
    if stage == "command":
        return "command_failed"
    if stage.startswith("file_"):
        return "file_failed"
    if stage == "kill":
        return "kill_failed"
    return "unknown_failed"


def wait_until_ready(sandbox, attempts, interval_seconds):
    start_ns = time.perf_counter_ns()
    last = None
    for attempt in range(1, attempts + 1):
        try:
            sandbox.commands.run(READY_CHECK_COMMAND, timeout=COMMAND_TIMEOUT_SECONDS)
            return duration_ms(start_ns), attempt
        except Exception as exc:
            last = exc
            if "sandbox is not running" not in str(exc):
                raise
            if attempt < attempts:
                time.sleep(interval_seconds)
    raise TimeoutError(f"sandbox is not running after {attempts} attempts: {last}")


API_URL = os.environ["E2B_API_URL"]
SANDBOX_URL = os.environ.get("E2B_SANDBOX_URL")
API_KEY = os.environ["E2B_API_KEY"]
TEMPLATE = os.environ["CUBE_TEMPLATE_ID"]
RUN_DIR = os.environ.get("E2B_BENCH_RUN_DIR", os.getcwd())
ITERATIONS = env_int("E2B_BENCH_ITERATIONS", 10, 1)
CONCURRENCY = env_int("E2B_BENCH_CONCURRENCY", 1, 1)
MAX_CONCURRENCY = env_int("E2B_BENCH_MAX_CONCURRENCY", 5, 1)
WARMUP = env_int("E2B_BENCH_WARMUP", 1, 0)
READY_ATTEMPTS = env_int("E2B_BENCH_READY_ATTEMPTS", 12, 1)
READY_INTERVAL_SECONDS = env_int("E2B_BENCH_READY_INTERVAL_SECONDS", 1, 0)
COMMAND = os.environ.get("E2B_BENCH_COMMAND", "printf bench-command-ok")

if CONCURRENCY > MAX_CONCURRENCY:
    raise SystemExit(f"E2B_BENCH_CONCURRENCY={CONCURRENCY} exceeds E2B_BENCH_MAX_CONCURRENCY={MAX_CONCURRENCY}")

RESULTS_PATH = os.path.join(RUN_DIR, "benchmark_results.jsonl")
SUMMARY_JSON_PATH = os.path.join(RUN_DIR, "benchmark_summary.json")
SUMMARY_TXT_PATH = os.path.join(RUN_DIR, "benchmark_summary.txt")


def run_case(case_id, warmup=False):
    record = {
        "case_id": case_id,
        "warmup": warmup,
        "status": "failed",
        "failed_stage": "",
        "error_type": "",
        "error_message": "",
        "sandbox_id": "",
        "ready_attempt": None,
        "timings": {},
        "started_at": utc_now(),
        "finished_at": "",
    }
    sandbox = None
    stage = "create"
    total_start_ns = time.perf_counter_ns()
    try:
        create_start_ns = time.perf_counter_ns()
        sandbox = Sandbox.create(template=TEMPLATE, api_key=API_KEY, api_url=API_URL, sandbox_url=SANDBOX_URL)
        record["timings"]["create_ms"] = duration_ms(create_start_ns)
        record["sandbox_id"] = sid_of(sandbox)

        stage = "ready"
        ready_ms, ready_attempt = wait_until_ready(sandbox, READY_ATTEMPTS, READY_INTERVAL_SECONDS)
        record["timings"]["ready_ms"] = ready_ms
        record["ready_attempt"] = ready_attempt

        stage = "command"
        command_start_ns = time.perf_counter_ns()
        result = sandbox.commands.run(COMMAND, timeout=COMMAND_TIMEOUT_SECONDS)
        record["timings"]["command_ms"] = duration_ms(command_start_ns)
        if getattr(result, "exit_code", 0) != 0:
            raise AssertionError(f"command exit_code={getattr(result, 'exit_code', None)}")

        path = f"{BENCH_FILE_PREFIX}-{case_id}.txt"
        content = f"{BENCH_FILE_CONTENT_PREFIX}-{case_id}"
        stage = "file_write"
        write_start_ns = time.perf_counter_ns()
        sandbox.files.write(path, content)
        record["timings"]["file_write_ms"] = duration_ms(write_start_ns)

        stage = "file_read"
        read_start_ns = time.perf_counter_ns()
        read_content = sandbox.files.read(path)
        record["timings"]["file_read_ms"] = duration_ms(read_start_ns)
        if read_content != content:
            raise AssertionError("files.read returned unexpected content")
        sandbox.files.remove(path)

        record["status"] = "success"
    except Exception as exc:
        record["status"] = "failed"
        record["failed_stage"] = classify_error(stage, exc)
        record["error_type"] = type(exc).__name__
        record["error_message"] = str(exc)[:500]
    finally:
        if sandbox is not None:
            kill_start_ns = time.perf_counter_ns()
            try:
                sandbox.kill(api_key=API_KEY, api_url=API_URL)
            except Exception as exc:
                record["timings"]["kill_ms"] = duration_ms(kill_start_ns)
                record["kill_error_type"] = type(exc).__name__
                record["kill_error_message"] = str(exc)[:500]
                if record["status"] == "success":
                    record["status"] = "failed"
                    record["failed_stage"] = "kill_failed"
                    record["error_type"] = type(exc).__name__
                    record["error_message"] = str(exc)[:500]
            else:
                record["timings"]["kill_ms"] = duration_ms(kill_start_ns)
        record["timings"]["total_ms"] = duration_ms(total_start_ns)
        record["finished_at"] = utc_now()
    return record


def run_many(count, warmup=False):
    if count <= 0:
        return []
    max_workers = 1 if warmup else CONCURRENCY
    label = "warmup" if warmup else "measure"
    records = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(run_case, f"{label}-{i}", warmup) for i in range(1, count + 1)]
        for future in concurrent.futures.as_completed(futures):
            record = future.result()
            records.append(record)
            print("case", record["case_id"], record["status"], json.dumps(record["timings"], sort_keys=True), record.get("failed_stage", ""))
    return sorted(records, key=lambda item: item["case_id"])


def percentile(values, p):
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    k = (len(ordered) - 1) * (p / 100)
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return ordered[int(k)]
    return round(ordered[f] * (c - k) + ordered[c] * (k - f), 2)


def metric_stats(records, metric):
    values = [r["timings"][metric] for r in records if metric in r.get("timings", {})]
    if not values:
        return None
    return {
        "count": len(values),
        "min": min(values),
        "max": max(values),
        "avg": round(sum(values) / len(values), 2),
        "p50": percentile(values, 50),
        "p90": percentile(values, 90),
        "p95": percentile(values, 95),
        "p99": percentile(values, 99),
    }


def build_summary(measured_records, warmup_records):
    success_records = [r for r in measured_records if r["status"] == "success"]
    failures = Counter(r.get("failed_stage") or "unknown_failed" for r in measured_records if r["status"] != "success")
    metrics = ["create_ms", "ready_ms", "command_ms", "file_write_ms", "file_read_ms", "kill_ms", "total_ms"]
    return {
        "config": {
            "iterations": ITERATIONS,
            "concurrency": CONCURRENCY,
            "max_concurrency": MAX_CONCURRENCY,
            "warmup": WARMUP,
            "ready_attempts": READY_ATTEMPTS,
            "ready_interval_seconds": READY_INTERVAL_SECONDS,
            "command": COMMAND,
            "api_url": API_URL,
            "sandbox_url": SANDBOX_URL,
            "template": TEMPLATE,
        },
        "counts": {
            "measured_total": len(measured_records),
            "warmup_total": len(warmup_records),
            "success": len(success_records),
            "failed": len(measured_records) - len(success_records),
            "success_rate": round(len(success_records) / len(measured_records), 4) if measured_records else 0,
        },
        "failures": dict(failures),
        "metrics": {metric: metric_stats(success_records, metric) for metric in metrics},
        "generated_at": utc_now(),
    }


print("benchmark config:", json.dumps({
    "iterations": ITERATIONS,
    "concurrency": CONCURRENCY,
    "max_concurrency": MAX_CONCURRENCY,
    "warmup": WARMUP,
    "template": TEMPLATE,
}, sort_keys=True))

warmup_records = run_many(WARMUP, warmup=True)
measured_records = run_many(ITERATIONS, warmup=False)
all_records = warmup_records + measured_records
summary = build_summary(measured_records, warmup_records)

with open(RESULTS_PATH, "w", encoding="utf-8") as f:
    for record in all_records:
        f.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
with open(SUMMARY_JSON_PATH, "w", encoding="utf-8") as f:
    json.dump(summary, f, ensure_ascii=False, indent=2, sort_keys=True)
with open(SUMMARY_TXT_PATH, "w", encoding="utf-8") as f:
    f.write("E2B SDK MVP benchmark summary\n")
    f.write(json.dumps(summary["config"], ensure_ascii=False, sort_keys=True) + "\n")
    f.write(json.dumps(summary["counts"], ensure_ascii=False, sort_keys=True) + "\n")
    f.write("failures: " + json.dumps(summary["failures"], ensure_ascii=False, sort_keys=True) + "\n")
    for metric, stats in summary["metrics"].items():
        f.write(f"{metric}: {json.dumps(stats, ensure_ascii=False, sort_keys=True)}\n")

print("benchmark summary:")
print(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True))
print("benchmark results:", RESULTS_PATH)
print("benchmark summary json:", SUMMARY_JSON_PATH)
print("benchmark summary txt:", SUMMARY_TXT_PATH)
