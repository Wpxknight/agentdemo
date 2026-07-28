// file: index.d.ts
import type { AcquireSandboxInput, DownloadFile, SandboxCommand, SandboxHandle, SandboxOutput, SandboxProvider, UploadFile } from '@aiop/sandbox-core';
interface OpenSandboxClient {
    id: string;
    commands: {
        run(command: string, options?: {
            workingDirectory?: string;
            timeoutSeconds?: number;
            envs?: Record<string, string>;
        }, handlers?: {
            onStdout?: (message: {
                text: string;
            }) => void;
            onStderr?: (message: {
                text: string;
            }) => void;
        }, signal?: AbortSignal): Promise<{
            exitCode?: number | null;
            error?: unknown;
        }>;
    };
    files: {
        writeFiles(files: Array<{
            path: string;
            data: Uint8Array;
        }>): Promise<unknown>;
        readBytes(path: string): Promise<Uint8Array>;
    };
    kill(): Promise<void>;
    close(): Promise<void>;
}
export interface OpenSandboxSdkFactory {
    create(options: {
        connectionConfig?: {
            domain?: string;
            protocol?: 'http' | 'https';
            apiKey?: string;
            requestTimeoutSeconds?: number;
        };
        image: string;
        timeoutSeconds?: number;
        metadata: Record<string, string>;
        resource?: Record<string, string>;
        networkPolicy?: {
            defaultAction: 'allow' | 'deny';
        };
    }): Promise<OpenSandboxClient>;
}
export interface OpenSandboxProviderOptions {
    domain?: string;
    protocol?: 'http' | 'https';
    apiKey?: string;
    defaultImage?: string;
    requestTimeoutSeconds?: number;
    sdkFactory?: OpenSandboxSdkFactory;
}
export declare class OpenSandboxProvider implements SandboxProvider {
    private readonly options;
    private readonly handles;
    private readonly factory;
    constructor(options?: OpenSandboxProviderOptions);
    acquire(input: AcquireSandboxInput): Promise<SandboxHandle>;
    execute(handle: SandboxHandle, command: SandboxCommand): AsyncIterable<SandboxOutput>;
    upload(handle: SandboxHandle, file: UploadFile): Promise<void>;
    download(handle: SandboxHandle, path: string): Promise<DownloadFile>;
    release(handle: SandboxHandle): Promise<void>;
    private requireHandle;
}
export {};
