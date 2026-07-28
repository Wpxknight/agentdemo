import type { IdentityContext } from '@aiop/control-contracts';

export interface AcquireSandboxInput {
  identity: IdentityContext;
  profile: string;
  cpu?: number;
  memoryMb?: number;
  timeoutMs?: number;
  network?: 'none' | 'restricted' | 'full';
}

export interface SandboxHandle {
  id: string;
  provider: string;
  profile: string;
}

export interface SandboxCommand {
  program: string;
  args?: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}

export interface SandboxOutput {
  stream: 'stdout' | 'stderr';
  text: string;
  exitCode?: number;
}

export interface UploadFile {
  path: string;
  content: Uint8Array;
}

export interface DownloadFile {
  path: string;
  content: Uint8Array;
}

export interface SandboxProvider {
  acquire(input: AcquireSandboxInput): Promise<SandboxHandle>;
  execute(handle: SandboxHandle, command: SandboxCommand): AsyncIterable<SandboxOutput>;
  upload(handle: SandboxHandle, file: UploadFile): Promise<void>;
  download(handle: SandboxHandle, path: string): Promise<DownloadFile>;
  release(handle: SandboxHandle): Promise<void>;
}
