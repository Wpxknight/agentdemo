#!/usr/bin/env bash

# E2B SDK / AIOS target defaults. Override these with environment variables
# before running any script when adapting this skill to another environment.
DEFAULT_E2B_SDK_VERSION="2.24.0"
DEFAULT_E2B_API_URL="http://10.50.6.41:30082"
DEFAULT_E2B_SANDBOX_URL="https://10.50.6.41:30083"
DEFAULT_E2B_API_KEY="sk_live_替换为你的41环境凭证"
DEFAULT_CUBE_TEMPLATE_ID="code-interpreter"
DEFAULT_RUN_DIR_NAME="e2b-official-sdk-mvp-41-run"

# Files copied from script/ into the runtime directory.
CA_CERT_FILE="ca.crt"
LIFECYCLE_SCRIPT_FILE="e2b_mvp_lifecycle_command_files.py"
AGENT_E2E_SCRIPT_FILE="e2b_mvp_agent_e2e.py"
BENCHMARK_SCRIPT_FILE="e2b_mvp_benchmark.py"

# Runtime logs.
LIFECYCLE_LOG_FILE="lifecycle_command_files.log"
AGENT_E2E_LOG_FILE="agent_e2e.log"
BENCHMARK_LOG_FILE="benchmark.log"

# Benchmark defaults. Override with E2B_BENCH_* environment variables.
DEFAULT_E2B_BENCH_ITERATIONS="10"
DEFAULT_E2B_BENCH_CONCURRENCY="1"
DEFAULT_E2B_BENCH_MAX_CONCURRENCY="5"
DEFAULT_E2B_BENCH_WARMUP="1"
DEFAULT_E2B_BENCH_READY_ATTEMPTS="12"
DEFAULT_E2B_BENCH_READY_INTERVAL_SECONDS="1"
DEFAULT_E2B_BENCH_COMMAND="printf bench-command-ok"
