import json
import os
import time
import importlib.metadata
from e2b import Sandbox


# Constants: override with environment variables when adapting the test.
READY_ATTEMPTS = int(os.environ.get("E2B_READY_ATTEMPTS", "12"))
READY_INTERVAL_SECONDS = int(os.environ.get("E2B_READY_INTERVAL_SECONDS", "10"))
COMMAND_TIMEOUT_SECONDS = int(os.environ.get("E2B_COMMAND_TIMEOUT_SECONDS", "30"))
READY_CHECK_COMMAND = os.environ.get("E2B_AGENT_READY_CHECK_COMMAND", "python3 --version")
PYTHON_BIN = os.environ.get("E2B_SANDBOX_PYTHON_BIN", "python3")
WORKSPACE_DIR = os.environ.get("E2B_TEST_WORKSPACE_DIR", "/workspace")
AGENT_NAME = os.environ.get("E2B_AGENT_NAME", "official-e2b-sdk-e2e")
INPUT_FILE_NAME = os.environ.get("E2B_AGENT_INPUT_FILE_NAME", "agent_input.json")
TASK_FILE_NAME = os.environ.get("E2B_AGENT_TASK_FILE_NAME", "agent_task.py")
RESULT_FILE_NAME = os.environ.get("E2B_AGENT_RESULT_FILE_NAME", "agent_result.json")
INPUT_PATH = f"{WORKSPACE_DIR.rstrip('/')}/{INPUT_FILE_NAME}"
TASK_PATH = f"{WORKSPACE_DIR.rstrip('/')}/{TASK_FILE_NAME}"
RESULT_PATH = f"{WORKSPACE_DIR.rstrip('/')}/{RESULT_FILE_NAME}"


def sid_of(sandbox):
    return getattr(sandbox, "sandbox_id", None) or getattr(sandbox, "id", None)


def wait_until_ready(sandbox, attempts=READY_ATTEMPTS, interval=READY_INTERVAL_SECONDS):
    last = None
    for i in range(1, attempts + 1):
        try:
            result = sandbox.commands.run(READY_CHECK_COMMAND, timeout=COMMAND_TIMEOUT_SECONDS)
            if i > 1:
                print("ready attempt:", i)
            print("ready stdout:", repr(result.stdout))
            return
        except Exception as e:
            last = e
            msg = str(e)
            if "sandbox is not running" not in msg:
                raise
            print("waiting sandbox ready:", i, type(e).__name__, msg)
            time.sleep(interval)
    raise last


def duration_ms(start_ns, end_ns=None):
    if end_ns is None:
        end_ns = time.perf_counter_ns()
    return round((end_ns - start_ns) / 1_000_000)


api_url = os.environ["E2B_API_URL"]
sandbox_url = os.environ.get("E2B_SANDBOX_URL")
api_key = os.environ["E2B_API_KEY"]
template = os.environ["CUBE_TEMPLATE_ID"]
print("e2b version =", importlib.metadata.version("e2b"))
print("api_url =", api_url)
print("sandbox_url =", sandbox_url)
print("template =", template)

sandbox = None
test_start_ns = time.perf_counter_ns()
create_done_ns = None
execute_done_ns = None
try:
    create_start_ns = time.perf_counter_ns()
    try:
        sandbox = Sandbox.create(template=template, api_key=api_key, api_url=api_url, sandbox_url=sandbox_url)
    except Exception:
        create_failed_ns = time.perf_counter_ns()
        print("timing agent create_failed_ms:", duration_ms(create_start_ns, create_failed_ns))
        print("timing agent total_ms:", duration_ms(test_start_ns, create_failed_ns))
        raise
    create_done_ns = time.perf_counter_ns()
    print("sandbox_id:", sid_of(sandbox))
    print("timing agent create_ms:", duration_ms(create_start_ns, create_done_ns))
    wait_until_ready(sandbox)

    agent_input = {
        "agent": AGENT_NAME,
        "items": [
            {"name": "alpha", "score": 5, "tags": ["sdk", "agent"]},
            {"name": "beta", "score": 11, "tags": ["sdk", "workflow"]},
            {"name": "gamma", "score": 7, "tags": ["api", "cleanup"]},
        ],
    }
    task_code = f'''
import json
from collections import Counter
input_path = "{INPUT_PATH}"
result_path = "{RESULT_PATH}"
with open(input_path, "r", encoding="utf-8") as f:
    payload = json.load(f)
items = payload["items"]
score_sum = sum(item["score"] for item in items)
tag_counts = Counter(tag for item in items for tag in item["tags"])
top_item = max(items, key=lambda item: item["score"])["name"]
result = {{
    "agent": payload["agent"],
    "count": len(items),
    "score_sum": score_sum,
    "score_avg": round(score_sum / len(items), 2),
    "tag_counts": dict(sorted(tag_counts.items())),
    "top_item": top_item,
}}
with open(result_path, "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, sort_keys=True)
print("agent_result_written", result_path)
print(json.dumps(result, ensure_ascii=False, sort_keys=True))
'''
    sandbox.files.write(INPUT_PATH, json.dumps(agent_input, ensure_ascii=False, sort_keys=True))
    sandbox.files.write(TASK_PATH, task_code)
    print("agent task files written:", INPUT_PATH, TASK_PATH)
    run = sandbox.commands.run(f"{PYTHON_BIN} {TASK_PATH}", timeout=COMMAND_TIMEOUT_SECONDS)
    print("task stdout:", run.stdout)
    print("task stderr:", repr(run.stderr))
    print("task exit_code:", run.exit_code)
    result_text = sandbox.files.read(RESULT_PATH)
    print("result_text:", result_text)
    result = json.loads(result_text)
    print("parsed result:", json.dumps(result, ensure_ascii=False, sort_keys=True))
    expected = {
        "agent": AGENT_NAME,
        "count": 3,
        "score_sum": 23,
        "score_avg": 7.67,
        "tag_counts": {"agent": 1, "api": 1, "cleanup": 1, "sdk": 2, "workflow": 1},
        "top_item": "beta",
    }
    if result != expected:
        raise AssertionError(f"unexpected agent result: {result!r}")
    entries = sandbox.files.list(WORKSPACE_DIR)
    names = [getattr(e, "name", None) or str(e) for e in entries]
    print("workspace entries:", names)
    for expected_name in [INPUT_FILE_NAME, TASK_FILE_NAME, RESULT_FILE_NAME]:
        if expected_name not in names:
            raise AssertionError(f"missing workspace entry: {expected_name}")
    for path in [INPUT_PATH, TASK_PATH, RESULT_PATH]:
        sandbox.files.remove(path)
        try:
            sandbox.files.read(path)
        except Exception as e:
            print("removed verified:", path, type(e).__name__, str(e))
        else:
            raise AssertionError(f"expected read after remove to fail: {path}")
    execute_done_ns = time.perf_counter_ns()
    print("timing agent execute_ms:", duration_ms(create_done_ns, execute_done_ns))
finally:
    if sandbox is not None:
        kill_start_ns = time.perf_counter_ns()
        kill_result = sandbox.kill(api_key=api_key, api_url=api_url)
        kill_done_ns = time.perf_counter_ns()
        print("killed:", kill_result)
        print("timing agent kill_ms:", duration_ms(kill_start_ns, kill_done_ns))
        print("timing agent total_ms:", duration_ms(test_start_ns, kill_done_ns))
