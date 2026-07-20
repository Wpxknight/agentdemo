export const SESSION_TERMINAL_MAX_BYTES = 2 * 1024 * 1024;
export const TERMINAL_CACHE_MAX_BYTES = 20 * 1024 * 1024;
export const TERMINAL_TRUNCATION_NOTICE = '[系统] 部分早期输出已省略。\n';

export interface SessionTerminalEntry {
  output: string;
  lastAccess: number;
}

export type SessionTerminalCache = Record<string, SessionTerminalEntry>;

export interface TerminalCacheLimits {
  perSessionBytes: number;
  totalBytes: number;
}

const DEFAULT_LIMITS: TerminalCacheLimits = {
  perSessionBytes: SESSION_TERMINAL_MAX_BYTES,
  totalBytes: TERMINAL_CACHE_MAX_BYTES,
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodedBytes(text: string): number {
  return encoder.encode(text).length;
}

function utf8Tail(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return decoder.decode(bytes.subarray(start));
}

function boundedOutput(output: string, maxBytes: number): string {
  if (encodedBytes(output) <= maxBytes) return output;
  return `${TERMINAL_TRUNCATION_NOTICE}${utf8Tail(output, maxBytes)}`;
}

function enforceTotalLimit(
  cache: SessionTerminalCache,
  activeSessionId: string,
  totalBytes: number,
): SessionTerminalCache {
  let size = Object.values(cache).reduce((sum, entry) => sum + encodedBytes(entry.output), 0);
  if (size <= totalBytes) return cache;

  const next = { ...cache };
  const candidates = Object.entries(next)
    .filter(([sessionId]) => sessionId !== activeSessionId)
    .sort((left, right) => left[1].lastAccess - right[1].lastAccess);
  for (const [sessionId, entry] of candidates) {
    delete next[sessionId];
    size -= encodedBytes(entry.output);
    if (size <= totalBytes) break;
  }
  return next;
}

export function setSessionTerminal(
  cache: SessionTerminalCache,
  sessionId: string,
  output: string,
  now = Date.now(),
  limits: TerminalCacheLimits = DEFAULT_LIMITS,
): SessionTerminalCache {
  if (!sessionId) return cache;
  const next = {
    ...cache,
    [sessionId]: {
      output: boundedOutput(output, Math.max(0, limits.perSessionBytes)),
      lastAccess: now,
    },
  };
  return enforceTotalLimit(next, sessionId, Math.max(0, limits.totalBytes));
}

export function appendSessionTerminal(
  cache: SessionTerminalCache,
  sessionId: string,
  chunk: string,
  now = Date.now(),
  limits: TerminalCacheLimits = DEFAULT_LIMITS,
): SessionTerminalCache {
  if (!sessionId || !chunk) return cache;
  return setSessionTerminal(cache, sessionId, `${cache[sessionId]?.output || ''}${chunk}`, now, limits);
}

export function touchSessionTerminal(
  cache: SessionTerminalCache,
  sessionId: string,
  now = Date.now(),
): SessionTerminalCache {
  const entry = cache[sessionId];
  if (!entry || entry.lastAccess === now) return cache;
  return { ...cache, [sessionId]: { ...entry, lastAccess: now } };
}

export function removeSessionTerminals(
  cache: SessionTerminalCache,
  sessionIds: string[],
): SessionTerminalCache {
  const targets = new Set(sessionIds);
  if (![...targets].some((sessionId) => cache[sessionId])) return cache;
  const next = { ...cache };
  for (const sessionId of targets) delete next[sessionId];
  return next;
}

export function sessionTerminalOutput(cache: SessionTerminalCache, sessionId: string): string {
  return cache[sessionId]?.output || '';
}
