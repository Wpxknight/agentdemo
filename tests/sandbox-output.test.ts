import { describe, expect, it } from 'vitest';
import { formatSandboxOutputChunk, parseAnsiSegments, parseSandboxOutput } from '../web/src/sandbox-output';

describe('sandbox terminal output formatting', () => {
  it('keeps each physical stdout line as a separate terminal row', () => {
    const entries = parseSandboxOutput([
      '$ fabric-admin e2e network',
      '=== route/source selection lbhp ===',
      '---192.110.0.20',
      '192.110.0.20 dev vmbr0 src 192.110.0.1 uid 0',
      '=== OVS local summary ===',
      'Bridge boc0',
    ].join('\n'));

    expect(entries.map((entry) => entry.text)).toEqual([
      'fabric-admin e2e network',
      '=== route/source selection lbhp ===',
      '---192.110.0.20',
      '192.110.0.20 dev vmbr0 src 192.110.0.1 uid 0',
      '=== OVS local summary ===',
      'Bridge boc0',
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual([
      'command',
      'stdout',
      'stdout',
      'stdout',
      'stdout',
      'stdout',
    ]);
  });

  it('splits stderr and error output into terminal rows without losing their style', () => {
    const entries = parseSandboxOutput([
      '$ check-network',
      '[stderr]',
      'nameserver limit exceeded',
      'some nameservers omitted',
      '[error] command failed',
      'exit code 1',
    ].join('\n'));

    expect(entries.map((entry) => [entry.kind, entry.text])).toEqual([
      ['command', 'check-network'],
      ['stderr', 'nameserver limit exceeded'],
      ['stderr', 'some nameservers omitted'],
      ['error', 'command failed'],
      ['error', 'exit code 1'],
    ]);
  });

  it('keeps stream output chunks separated even when the SDK omits trailing newlines', () => {
    const output = [
      '$ fabric-admin e2e network\n',
      formatSandboxOutputChunk('stdout', '=== route/source selection lbhp ==='),
      formatSandboxOutputChunk('stdout', '---192.110.0.20'),
      formatSandboxOutputChunk('stderr', 'Nameserver limits were exceeded'),
      formatSandboxOutputChunk('stdout', '=== OVS local summary ==='),
    ].join('');

    expect(parseSandboxOutput(output).map((entry) => [entry.kind, entry.text])).toEqual([
      ['command', 'fabric-admin e2e network'],
      ['stdout', '=== route/source selection lbhp ==='],
      ['stdout', '---192.110.0.20'],
      ['stderr', 'Nameserver limits were exceeded'],
      ['stdout', '=== OVS local summary ==='],
    ]);
  });

  it('recognizes ANSI foreground colors without leaking escape characters', () => {
    const entries = parseSandboxOutput(formatSandboxOutputChunk(
      'stdout',
      'plain \u001b[31mred\u001b[0m \u001b[1;32mok\u001b[22;39m done',
    ));

    expect(entries[0].text).toBe('plain red ok done');
    expect(entries[0].segments).toEqual([
      { text: 'plain ' },
      { text: 'red', className: 'ansi-segment ansi-fg-red' },
      { text: ' ' },
      { text: 'ok', className: 'ansi-segment ansi-fg-green ansi-bold' },
      { text: ' done' },
    ]);
  });

  it('maps extended ANSI colors to safe inline styles', () => {
    expect(parseAnsiSegments('\u001b[38;5;196mhot\u001b[0m')).toEqual([
      { text: 'hot', className: 'ansi-segment', style: { color: 'rgb(255, 0, 0)' } },
    ]);
  });
});
