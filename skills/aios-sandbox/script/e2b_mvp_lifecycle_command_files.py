import os
import time
import importlib.metadata
import inspect
import e2b
from e2b import Sandbox


# Constants: override with environment variables when adapting the test.
READY_ATTEMPTS = int(os.environ.get("E2B_READY_ATTEMPTS", "12"))
READY_INTERVAL_SECONDS = int(os.environ.get("E2B_READY_INTERVAL_SECONDS", "10"))
COMMAND_TIMEOUT_SECONDS = int(os.environ.get("E2B_COMMAND_TIMEOUT_SECONDS", "30"))
CONNECT_TIMEOUT_SECONDS = int(os.environ.get("E2B_CONNECT_TIMEOUT_SECONDS", "30"))
READY_CHECK_COMMAND = os.environ.get("E2B_READY_CHECK_COMMAND", "true")
NORMAL_COMMAND = os.environ.get("E2B_LIFECYCLE_NORMAL_COMMAND", "printf sdk-command-ok")
NORMAL_COMMAND_EXPECTED_STDOUT = os.environ.get("E2B_LIFECYCLE_NORMAL_EXPECTED_STDOUT", "sdk-command-ok")
NONZERO_COMMAND = os.environ.get("E2B_LIFECYCLE_NONZERO_COMMAND", "echo sdk-fail-msg >&2; exit 7")
NONZERO_EXPECTED_EXIT_CODE = int(os.environ.get("E2B_LIFECYCLE_NONZERO_EXPECTED_EXIT_CODE", "7"))
NONZERO_EXPECTED_STDERR = os.environ.get("E2B_LIFECYCLE_NONZERO_EXPECTED_STDERR", "sdk-fail-msg")
WORKSPACE_DIR = os.environ.get("E2B_TEST_WORKSPACE_DIR", "/workspace")
TEST_FILE_NAME = os.environ.get("E2B_LIFECYCLE_TEST_FILE_NAME", "sdk-file.txt")
TEST_FILE_CONTENT = os.environ.get("E2B_LIFECYCLE_TEST_FILE_CONTENT", "hello-from-official-e2b-sdk-files")
TEST_FILE_PATH = f"{WORKSPACE_DIR.rstrip('/')}/{TEST_FILE_NAME}"


def sandbox_id_of(sandbox):
    return getattr(sandbox, "sandbox_id", None) or getattr(sandbox, "id", None)


def wait_until_ready(sandbox, attempts=READY_ATTEMPTS, interval=READY_INTERVAL_SECONDS):
    last = None
    for i in range(1, attempts + 1):
        try:
            sandbox.commands.run(READY_CHECK_COMMAND, timeout=COMMAND_TIMEOUT_SECONDS)
            if i > 1:
                print("ready attempt:", i)
            return
        except Exception as e:
            last = e
            msg = str(e)
            if "sandbox is not running" not in msg:
                raise
            print("waiting sandbox ready:", i, type(e).__name__, msg)
            time.sleep(interval)
    raise last


def list_sandbox_ids(api_key, api_url):
    paginator = Sandbox.list(api_key=api_key, api_url=api_url)
    items = paginator.next_items() if hasattr(paginator, "next_items") else list(paginator)
    ids = [getattr(item, "sandbox_id", None) or getattr(item, "id", None) or str(item) for item in items]
    print("list sandbox ids:", ids)
    return ids


def duration_ms(start_ns, end_ns=None):
    if end_ns is None:
        end_ns = time.perf_counter_ns()
    return round((end_ns - start_ns) / 1_000_000)


api_url = os.environ["E2B_API_URL"]
sandbox_url = os.environ.get("E2B_SANDBOX_URL")
api_key = os.environ["E2B_API_KEY"]
template = os.environ["CUBE_TEMPLATE_ID"]

print("e2b version =", importlib.metadata.version("e2b"))
print("e2b package file =", e2b.__file__)
print("E2B Sandbox module =", inspect.getmodule(Sandbox).__file__)
print("api_url =", api_url)
print("sandbox_url =", sandbox_url)
print("template =", template)
print("ssl_cert_file_exists =", os.path.exists(os.environ["SSL_CERT_FILE"]))

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
        print("timing lifecycle create_failed_ms:", duration_ms(create_start_ns, create_failed_ns))
        print("timing lifecycle total_ms:", duration_ms(test_start_ns, create_failed_ns))
        raise
    create_done_ns = time.perf_counter_ns()
    sid = sandbox_id_of(sandbox)
    print("created sandbox:", sid)
    print("timing lifecycle create_ms:", duration_ms(create_start_ns, create_done_ns))

    ids = list_sandbox_ids(api_key, api_url)
    print("list contains created:", sid in ids)
    if sid not in ids:
        raise AssertionError("created sandbox missing from Sandbox.list")

    info = sandbox.get_info(api_key=api_key, api_url=api_url)
    print("get_info:", info)

    connected = sandbox.connect(timeout=CONNECT_TIMEOUT_SECONDS, api_key=api_key, api_url=api_url, sandbox_url=sandbox_url)
    print("connected sandbox:", sandbox_id_of(connected))

    wait_until_ready(connected)

    result = connected.commands.run(NORMAL_COMMAND, timeout=COMMAND_TIMEOUT_SECONDS)
    print("command stdout:", repr(result.stdout))
    print("command stderr:", repr(result.stderr))
    print("command exit_code:", result.exit_code)
    if result.stdout != NORMAL_COMMAND_EXPECTED_STDOUT or result.exit_code != 0:
        raise AssertionError("commands.run normal command returned unexpected result")

    try:
        connected.commands.run(NONZERO_COMMAND, timeout=COMMAND_TIMEOUT_SECONDS)
    except Exception as e:
        print("nonzero exception type:", type(e).__name__)
        print("nonzero exception message:", str(e))
        print("nonzero exception exit_code:", getattr(e, "exit_code", None))
        if getattr(e, "exit_code", None) != NONZERO_EXPECTED_EXIT_CODE or NONZERO_EXPECTED_STDERR not in str(e):
            raise AssertionError("nonzero command exception did not include expected stderr/exit_code")
    else:
        raise AssertionError("Expected official SDK to raise for non-zero exit")

    write_info = connected.files.write(TEST_FILE_PATH, TEST_FILE_CONTENT)
    print("write_info:", write_info)
    read_content = connected.files.read(TEST_FILE_PATH)
    print("read_content:", repr(read_content))
    if read_content != TEST_FILE_CONTENT:
        raise AssertionError("files.read returned unexpected content")
    entries = connected.files.list(WORKSPACE_DIR)
    names = [getattr(e, "name", None) or str(e) for e in entries]
    print("workspace entries:", names)
    if TEST_FILE_NAME not in names:
        raise AssertionError(f"files.list missing {TEST_FILE_NAME}")
    connected.files.remove(TEST_FILE_PATH)
    print("removed:", TEST_FILE_PATH)
    try:
        connected.files.read(TEST_FILE_PATH)
    except Exception as e:
        print("post_remove_read_exception:", type(e).__name__, str(e))
    else:
        raise AssertionError("Expected read after remove to fail")
    execute_done_ns = time.perf_counter_ns()
    print("timing lifecycle execute_ms:", duration_ms(create_done_ns, execute_done_ns))
finally:
    if sandbox is not None:
        kill_start_ns = time.perf_counter_ns()
        kill_result = sandbox.kill(api_key=api_key, api_url=api_url)
        kill_done_ns = time.perf_counter_ns()
        print("killed sandbox:", kill_result)
        print("timing lifecycle kill_ms:", duration_ms(kill_start_ns, kill_done_ns))
        print("timing lifecycle total_ms:", duration_ms(test_start_ns, kill_done_ns))
