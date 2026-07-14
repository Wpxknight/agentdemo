---
name: aios-sandbox
description: Use when an AIOS agent needs to select an available Sandbox Key, create or operate a sandbox on a Portal or compute Kubernetes cluster, choose sandbox-reader or sandbox-diag templates, or run the bundled official E2B SDK regression scripts.
---

# AIOS Sandbox

## Core workflow

Always determine the task's target Kubernetes cluster before selecting a Key.

1. Identify the target cluster and whether it is a Portal cluster or a compute cluster.
2. Query the current user's enabled Sandbox Keys for the active project.
3. Select a Key using the deterministic rules below.
4. Create the sandbox with the selected Key. Generic Keys require structured placement.
5. Reuse that Key for connect, command, filesystem, list, and delete operations.

Do not ask the user to choose between equivalent Keys. Apply the deterministic ordering in [references/key-selection.md](references/key-selection.md).

## Key selection

### Portal cluster

Use the smallest enabled Generic Key that satisfies the task's CPU and memory needs.

Generic Keys bind only a portable native resource specification such as `1c1g`; they do not bind a cluster, namespace, AIOS resource group, or AIOS resource specification.

### Compute cluster

First choose the smallest enabled Resource Key that:

- is bound to the target compute cluster; and
- satisfies the task's resource needs.

If no Resource Key fits, fall back to the smallest fitting Generic Key.

### Creation contract

Generic Key creation must include:

```json
{
  "placement": {
    "clusterId": "35",
    "namespace": "optional-target-namespace"
  }
}
```

`placement.clusterId` is required for a Generic Key. The namespace is optional and defaults according to the server deployment.

A Resource Key already binds its cluster and namespace. Omit placement unless the caller needs to make the expected target explicit. If supplied, it must match the Key binding.

Never send AIOS resource-group fields for a Generic Key. Never redirect a Resource Key to another cluster.

See [references/key-selection.md](references/key-selection.md) for filtering, sorting, examples, and failure handling.

## Runtime roles

Templates expose exactly two built-in roles:

- `sandbox-reader`: default, non-privileged Kubernetes read-only operations.
- `sandbox-diag`: high-risk diagnostics with privileged mode, host network/PID, diagnostic capabilities, and host mounts.

Choose a template whose role matches the task. Use `sandbox-reader` for inspection (`get/list/watch`, logs and events). Use `sandbox-diag` only when the requested diagnosis requires node networking, CNI, OVS, iptables, conntrack, packet capture, namespace entry, or repair operations.

The role is template-bound. Do not attempt to override ServiceAccount, RBAC, securityContext, hostNetwork, hostPID, or hostPath through sandbox metadata or arbitrary PodSpec fields.

## Safety and lifecycle

- Confirm the user is authorized to operate the target cluster before creating or mutating resources.
- Treat `sandbox-diag` as privileged cluster access and state the intended diagnostic action.
- Keep the selected Key and sandbox ID together for all subsequent operations.
- Delete temporary sandboxes when the task is complete unless the user explicitly asks to retain them.
- Do not print or persist a complete API Key. Use the platform-provided credential context.

## Bundled E2B regression

The existing scripts under `script/` remain the supported way to run the standalone official `e2b==2.24.0` regression and low-concurrency benchmark against AIOS 41.

Run from this Skill directory:

```bash
bash script/run_windows_git_bash.sh
bash script/run_linux_bash.sh
bash script/run_benchmark.sh
```

Before accessing AIOS 41, confirm authorization and set `E2B_API_KEY` outside the conversation. Do not inline or rewrite the bundled shell/Python scripts. Start benchmarks at concurrency 1 and do not exceed the script's configured maximum.

Default endpoints, template, CA, and benchmark settings remain centralized in `script/constants.sh`; use environment-variable overrides rather than editing scripts for one-off runs.
