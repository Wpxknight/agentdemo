import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

export async function verifyBackupChecksum(backupPath: string, sidecarPath = `${backupPath}.sha256`): Promise<void> {
  const [backup, sidecar, canonicalBackup] = await Promise.all([
    readFile(backupPath), readFile(sidecarPath, 'utf8'), realpath(backupPath),
  ]);
  const match = sidecar.trim().match(/^([a-fA-F0-9]{64}) [ *](.+)$/);
  if (!match) throw new Error('checksum sidecar must contain exactly one sha256sum record');
  const referenced = match[2]!;
  const referencedPath = isAbsolute(referenced) ? referenced : resolve(dirname(sidecarPath), referenced);
  if (await realpath(referencedPath).catch(() => '') !== canonicalBackup) {
    throw new Error(`checksum sidecar must exactly identify ${basename(backupPath)}`);
  }
  const actual = createHash('sha256').update(backup).digest('hex');
  if (match[1]!.toLowerCase() !== actual) throw new Error(`checksum mismatch for ${basename(backupPath)}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const backupPath = process.argv[2];
  if (!backupPath) throw new Error('backup path is required');
  await verifyBackupChecksum(backupPath);
}
