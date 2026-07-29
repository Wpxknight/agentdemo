import { posix } from 'node:path';

export function remoteWorkspacePath(relativePath = ''): string {
  const normalized = relativePath.replace(/\\/g, '/');
  if (posix.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error('sandbox path escapes sandbox root');
  }
  return normalized ? posix.join('/workspace', normalized) : '/workspace';
}
