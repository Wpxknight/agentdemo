import type { AcquireSandboxInput, DownloadFile, SandboxCommand, SandboxHandle, SandboxOutput, SandboxProvider, UploadFile } from '@aiop/sandbox-core';
interface E2BSandboxClient {
    sandboxId: string;
    commands: {
        run(command: string, options?: {
            cwd?: string;
            envs?: Record<string, string>;
            timeoutMs?: number;
            onStdout?: (text: string) => void | Promise<void>;
            onStderr?: (text: string) => void | Promise<void>;
        }): Promise<{
            stdout: string;
            stderr: string;
            exitCode: number;
            error?: string;
        }>;
    };
    files: {
        write(path: string, content: ArrayBuffer): Promise<unknown>;
        read(path: string, options: {
            format: 'bytes';
        }): Promise<Uint8Array>;
    };
    kill(): Promise<unknown>;
}
export interface E2BSandboxSdkFactory {
    create(options: {
        apiKey?: string;
        domain?: string;
        template?: string;
        timeoutMs?: number;
        metadata: Record<string, string>;
        allowInternetAccess?: boolean;
    }): Promise<E2BSandboxClient>;
}
export interface E2BSandboxProviderOptions {
    apiKey?: string;
    domain?: string;
    template?: string;
    sdkFactory?: E2BSandboxSdkFactory;
}
export declare class E2BSandboxProvider implements SandboxProvider {
    private readonly options;
    private readonly handles;
    private readonly factory;
    constructor(options?: E2BSandboxProviderOptions);
    acquire(input: AcquireSandboxInput): Promise<SandboxHandle>;
    execute(handle: SandboxHandle, command: SandboxCommand): AsyncIterable<SandboxOutput>;
    upload(handle: SandboxHandle, file: UploadFile): Promise<void>;
    download(handle: SandboxHandle, path: string): Promise<DownloadFile>;
    release(handle: SandboxHandle): Promise<void>;
    private requireHandle;
}
export {};
