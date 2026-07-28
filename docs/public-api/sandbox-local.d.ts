import type { AcquireSandboxInput, DownloadFile, SandboxCommand, SandboxHandle, SandboxOutput, SandboxProvider, UploadFile } from '@aiop/sandbox-core';
export declare class LocalSandboxProvider implements SandboxProvider {
    private readonly handles;
    acquire(input: AcquireSandboxInput): Promise<SandboxHandle>;
    execute(handle: SandboxHandle, command: SandboxCommand): AsyncIterable<SandboxOutput>;
    upload(handle: SandboxHandle, file: UploadFile): Promise<void>;
    download(handle: SandboxHandle, path: string): Promise<DownloadFile>;
    release(handle: SandboxHandle): Promise<void>;
    private requireHandle;
}
