# K8s Session Sandbox Design

## Goal

When sandboxing is enabled with the OpenSandbox backend, code execution, shell commands, and browser operations all run inside one Kubernetes-backed sandbox per AIOP session.

## Scope

- `sandbox.provider: "opensandbox"` continues to use OpenSandbox Lifecycle + execd for code and command execution.
- `sandbox.desktop: true` enables browser tools for OpenSandbox instead of skipping them.
- Isolation key is the AIOP `sessionId`. A browser operation and a code operation with the same `sessionId` use the same `SandboxManager` entry and therefore the same OpenSandbox Pod.
- Browser preview uses the existing `/v1/browser/stream-view` screenshot polling page. This design does not add noVNC.

## Architecture

The runtime builds one `SandboxManager` for OpenSandbox. Sandbox tools (`sbx__run_code`, `sbx__run_command`) already resolve `key = ctx.sessionId`; browser tools will resolve through a new OpenSandbox desktop provider that receives the same `SandboxManager` and calls `manager.get({ key: sessionId })`.

The OpenSandbox desktop provider implements the existing `DesktopProvider` / `DesktopHandle` contract. It does not create a second sandbox. On first browser use it starts headless Chrome inside the sandbox with a fixed local CDP port and a per-session profile directory. Browser actions run a small Node.js CDP helper inside the sandbox through `SandboxHandle.runCommand`, so CDP traffic stays inside the Pod network namespace.

## Data Flow

1. A user calls `/v1/sandbox/run-code` or an agent uses `sbx__run_code`.
2. `SandboxManager.get({ key: sessionId })` creates or reuses the OpenSandbox Pod.
3. A user calls `/v1/browser/navigate`, `/click`, `/type`, `/screenshot`, or `/stream`.
4. The OpenSandbox desktop provider calls the same `SandboxManager.get({ key: sessionId })`.
5. The provider starts Chrome inside the existing Pod if needed.
6. It runs a sandbox-local Node.js CDP script to navigate, click, type, or capture a screenshot.

Because both paths use the same `key`, file system state, environment variables, and network policy are shared within a session and isolated between sessions.

## Runtime Behavior

- `local`: unchanged; uses local temporary directories and local headless Chrome.
- `e2b`: unchanged; uses E2B code and E2B desktop providers.
- `opensandbox`: code, command, and browser tools are all enabled when `sandbox.enabled` and `sandbox.desktop` are true.

If Chrome or Node.js is missing from the configured OpenSandbox image, the browser tool returns a tool error that identifies the missing binary. Code and command tools still work.

## Deployment

Kubernetes deployment should set:

```jsonc
"sandbox": {
  "enabled": true,
  "provider": "opensandbox",
  "domain": "opensandbox-server.opensandbox-system.svc:80",
  "protocol": "http",
  "desktop": true,
  "defaultImage": "aiop/opensandbox-browser:latest"
}
```

The browser image must include:

- `python3`
- `node` with global `fetch` and `WebSocket`
- `chromium`, `chromium-browser`, or `google-chrome`
- common shell utilities: `bash`, `curl`, `base64`, `mkdir`

## Testing

Automated tests cover:

- the OpenSandbox desktop provider reuses the same `SandboxManager` entry as code tools for the same `sessionId`;
- `buildRuntime` registers browser tools for `sandbox.provider = "opensandbox"` and `sandbox.desktop = true`;
- the CDP helper command formats screenshot output into the existing image content block contract;
- all existing sandbox, HTTP, and runtime tests still pass.
