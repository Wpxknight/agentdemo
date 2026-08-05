import { describe, expect, it, vi } from 'vitest';
import { CommandDesktopProvider } from '../packages/sandbox-runtime/src/command-desktop.js';
import { OpenSandboxDesktopProvider } from '../packages/sandbox-runtime/src/opensandbox-desktop.js';
import type { SandboxManagerLike } from '../packages/sandbox-runtime/src/lifecycle.js';
import type { ExecResult, SandboxHandle, SandboxSpec } from '../packages/sandbox-runtime/src/types.js';

const SCREENSHOT = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

function decodeCommand(command: string): { action?: string; payload?: Record<string, unknown> } {
  const match = command.match(/^node - '([^']+)' '([^']+)'/m);
  if (!match) return {};
  const encoded = match[2]!.replace(/-/g, '+').replace(/_/g, '/');
  return {
    action: match[1],
    payload: JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as Record<string, unknown>,
  };
}

function setup() {
  const commands: string[] = [];
  const runCommand = vi.fn(async (command: string): Promise<ExecResult> => {
    commands.push(command);
    const { action } = decodeCommand(command);
    if (action === 'url') {
      return { stdout: 'noise\n__AIOP_URL__https://example.test\n', stderr: '', exitCode: 0 };
    }
    if (action === 'screenshot') {
      return {
        stdout: `__AIOP_SCREENSHOT__${Buffer.from(SCREENSHOT).toString('base64')}\n`,
        stderr: '',
        exitCode: 0,
      };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });
  const sandbox: SandboxHandle = {
    sandboxId: 'sandbox-1',
    runCode: vi.fn(async () => ({ stdout: '', stderr: '' })),
    runCommand,
    readFile: vi.fn(async () => new Uint8Array()),
    setTimeout: vi.fn(async () => {}),
    kill: vi.fn(async () => {}),
  };
  const get = vi.fn(async (_spec: SandboxSpec) => sandbox);
  const use = vi.fn(async <T>(_key: string, action: () => Promise<T>) => action());
  const manager = { get, touch: vi.fn(() => true), use } as unknown as SandboxManagerLike;
  return { commands, get, manager, use };
}

describe('CommandDesktopProvider', () => {
  it('starts headed Chrome with localhost-only CDP access', async () => {
    const { commands, manager } = setup();
    const desktop = await new CommandDesktopProvider(manager).create({ key: 'browser' });

    const stream = await desktop.startStream();

    expect(stream).toBe(desktop.streamUrl());
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('curl -fsS http://127.0.0.1:9222/json/version');
    expect(commands[0]).toContain('--remote-debugging-address=127.0.0.1');
    expect(commands[0]).toContain('--remote-debugging-port=9222');
    expect(commands[0]).not.toMatch(/noVNC|novnc|websockify/i);
  });

  it('drives browser actions through localhost CDP and refreshes the screenshot preview', async () => {
    const { commands, manager, use } = setup();
    const desktop = await new CommandDesktopProvider(manager).create({ key: 'browser' });

    await desktop.launch('google-chrome', 'https://target.example/path?q=1');
    await desktop.leftClick(12, 34);
    await desktop.write('hello\n');
    expect(desktop.currentUrl).toBeDefined();
    await expect(desktop.currentUrl!()).resolves.toBe('https://example.test');
    const screenshot = await desktop.screenshot();
    expect([...screenshot]).toEqual([...SCREENSHOT]);

    const actions = commands.map(decodeCommand).filter((item) => item.action);
    expect(actions).toEqual([
      { action: 'navigate', payload: { url: 'https://target.example/path?q=1' } },
      { action: 'click', payload: { x: 12, y: 34 } },
      { action: 'type', payload: { text: 'hello\n' } },
      { action: 'url', payload: {} },
      { action: 'screenshot', payload: {} },
    ]);
    const cdpCommands = commands.filter((command) => decodeCommand(command).action);
    expect(cdpCommands).toHaveLength(5);
    expect(use).toHaveBeenCalledTimes(6);
    expect(use.mock.calls.every(([key]) => key === 'browser')).toBe(true);
    for (const command of cdpCommands) {
      expect(command).toContain("fetch('http://127.0.0.1:' + port + path");
      expect(command).not.toMatch(/noVNC|novnc|websockify/i);
    }
    expect(cdpCommands[0]).toContain("page.send('Page.navigate', { url: payload.url })");
    expect(cdpCommands[1]).toContain("page.send('Input.dispatchMouseEvent'");
    expect(cdpCommands[2]).toContain("page.send('Input.insertText', { text: body })");
    expect(cdpCommands[2]).toContain("key: 'Enter'");
    expect(decodeURIComponent(desktop.streamUrl())).toContain(Buffer.from(SCREENSHOT).toString('base64'));
  });

  it('keeps the OpenSandbox provider as a compatible subclass', async () => {
    const { get, manager } = setup();
    const provider = new OpenSandboxDesktopProvider(manager);

    expect(provider).toBeInstanceOf(CommandDesktopProvider);
    const desktop = await provider.connect('existing-sandbox', { key: 'browser' });

    expect(desktop.sandboxId).toBe('sandbox-1');
    expect(get).toHaveBeenCalledWith({ key: 'browser', sandboxId: 'existing-sandbox' });
  });
});
