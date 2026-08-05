// file: acquisition.d.ts
import type { ToolContext } from './contracts.js';
import type { SandboxManagerLike } from './lifecycle.js';
import type { SandboxHandle, SandboxSpec } from './types.js';
/** 由调用上下文推导 Sandbox spec；profile 由 generation 在调用开始时固定。 */
export type SpecResolver = (ctx: ToolContext, profile?: string) => Partial<SandboxSpec> | Promise<Partial<SandboxSpec>>;
export interface SandboxAcquisition {
    handle: SandboxHandle;
    spec: SandboxSpec;
    /** 淘汰本次取得的精确缓存句柄；句柄已被控制面 kill 时调用。 */
    invalidate?(): void;
    /** 将凭据污染标记写回本次实际使用的 generation/entry。 */
    markCredentialInjected(): void;
}
export interface SandboxAcquirer extends SandboxManagerLike {
    acquire(ctx: ToolContext, profile?: string): Promise<SandboxAcquisition>;
    acquireSpec(ctx: ToolContext, spec: SandboxSpec | (() => SandboxSpec | Promise<SandboxSpec>)): Promise<SandboxAcquisition>;
}
export declare function isSandboxAcquirer(manager: SandboxManagerLike): manager is SandboxAcquirer;

// file: aios-e2b.d.ts
import type { AiosLifecycleHttpOptions } from './aios-http.js';
import type { SandboxHandle, SandboxProvider, SandboxProviderOperationOptions, SandboxSpec } from './types.js';
/** AIOS Lifecycle REST API 所需的固定调度位置。 */
export interface AiosSandboxPlacement {
    clusterId: string;
    namespace?: string;
}
export interface AiosE2bProviderOptions extends AiosLifecycleHttpOptions {
    /** Generic Key 创建所需的固定调度位置。 */
    placement: AiosSandboxPlacement;
    /** 当前 Runtime generation 从 AIOS 目录加载的模板 ID。 */
    allowedTemplateIds: ReadonlySet<string>;
    /** readiness probe 最大次数；仅供测试或特殊部署调整。 */
    readinessAttempts?: number;
    /** readiness probe 重试间隔(ms)。 */
    readinessDelayMs?: number;
    /** 可注入等待函数，避免测试实际等待。 */
    sleep?: (ms: number) => Promise<void>;
}
type CommandResponse = {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    timedOut?: boolean;
};
/** 通过 AIOS E2B-compatible Lifecycle REST API 创建和连接沙箱。 */
export declare class AiosE2bProvider implements SandboxProvider {
    private readonly opts;
    private readonly http;
    private readonly readinessAttempts;
    private readonly readinessDelayMs;
    private readonly sleep;
    constructor(opts: AiosE2bProviderOptions);
    create(spec: SandboxSpec, options?: SandboxProviderOperationOptions): Promise<SandboxHandle>;
    connect(sandboxId: string, spec: SandboxSpec, options?: SandboxProviderOperationOptions): Promise<SandboxHandle>;
    command(sandboxId: string, command: string, timeoutMs?: number, signal?: AbortSignal): Promise<CommandResponse>;
    request<T = unknown>(path: string, init: {
        method: string;
        body?: unknown;
    }, requestOptions?: {
        timeoutMs?: number;
        maxResponseBytes?: number;
        signal?: AbortSignal;
    }): Promise<T>;
    private assertTemplateAllowed;
    private waitUntilReady;
}
export {};

// file: aios-http.d.ts
export declare class AiosLifecycleHttpError extends Error {
    readonly status: number;
    constructor(status: number);
}
export interface AiosLifecycleHttpOptions {
    lifecycleUrl: string;
    apiKey?: string;
    fetch?: typeof globalThis.fetch;
    timeoutMs?: number;
    maxResponseBytes?: number;
}
interface AiosLifecycleRequestInit {
    method?: string;
    body?: unknown;
}
export interface AiosLifecycleRequestOptions {
    timeoutMs?: number;
    maxResponseBytes?: number;
    signal?: AbortSignal;
}
export declare class AiosLifecycleHttpClient {
    private readonly apiKey;
    private readonly fetchImpl;
    private readonly lifecycleUrl;
    private readonly maxResponseBytes;
    private readonly timeoutMs;
    constructor(opts: AiosLifecycleHttpOptions);
    requestJson<T>(path: string, init?: AiosLifecycleRequestInit, allowedStatuses?: readonly number[], requestOptions?: AiosLifecycleRequestOptions): Promise<{
        body: T;
        status: number;
    }>;
    private fetchResponse;
}
export {};

// file: aios-template-catalog.d.ts
import { type AiosLifecycleHttpOptions } from './aios-http.js';
import type { SandboxProfile } from './profiles.js';
export type AiosTemplateEnvType = 'code' | 'browser';
export type SandboxRuntimeRole = 'sandbox-reader' | 'sandbox-diag';
export interface AiosTemplateCatalogEntry {
    templateId: string;
    name: string;
    aliases: string[];
    description: string;
    envType: AiosTemplateEnvType;
    runtimeRole: SandboxRuntimeRole;
    image: string;
    defaultTimeoutMs?: number;
}
export interface AiosTemplateCatalogSnapshot {
    templates: AiosTemplateCatalogEntry[];
    fingerprint: string;
    loadedAt: string;
}
export declare function sandboxProfilesFromAiosCatalog(entries: readonly AiosTemplateCatalogEntry[]): SandboxProfile[];
export declare class AiosTemplateCatalog {
    private readonly client;
    constructor(opts: AiosLifecycleHttpOptions);
    load(): Promise<AiosTemplateCatalogSnapshot>;
}

// file: command-desktop.d.ts
import type { DesktopHandle, DesktopProvider, DesktopSpec } from './desktop.js';
import type { SandboxManagerLike } from './lifecycle.js';
export declare class CommandDesktopProvider implements DesktopProvider {
    private readonly manager;
    constructor(manager: SandboxManagerLike);
    create(spec: DesktopSpec): Promise<DesktopHandle>;
    connect(sandboxId: string, spec: DesktopSpec): Promise<DesktopHandle>;
}

// file: contracts.d.ts
import type { OutputSink } from './types.js';
export type Role = 'platform_admin' | 'tenant_admin' | 'user';
export interface RequestContext {
    tenantId: string;
    userId: string;
    role: Role;
}
export interface ToolContext {
    sessionId: string;
    tenantId?: string;
    userId?: string;
    role?: Role;
    signal?: AbortSignal;
    onOutput?: OutputSink;
    [key: string]: unknown;
}
export interface SandboxProfileConfig {
    template?: string;
    image?: string;
    description?: string;
    domain?: string;
    namespace?: string;
    serviceAccount?: string;
    desktop?: boolean;
    privileged: boolean;
    capabilities: string[];
    envs?: Record<string, string>;
    timeoutMs?: number;
}
export interface SandboxConfig {
    enabled: boolean;
    provider: 'local' | 'e2b' | 'opensandbox';
    apiKey?: string;
    aios?: {
        lifecycleUrl: string;
        placement: {
            clusterId: string;
            namespace: string;
        };
    };
    domain?: string;
    protocol?: 'http' | 'https';
    defaultImage?: string;
    idleMs?: number;
    timeoutMs?: number;
    desktop: boolean;
    warmPoolSize?: number;
    profiles?: Record<string, SandboxProfileConfig>;
    userHomeRoot?: string;
    userHomeMountPath: string;
}
export interface SandboxSettings {
    enabled: boolean;
    mode: 'standard_e2b' | 'aios_lifecycle' | 'opensandbox' | 'local';
    domain?: string;
    protocol?: 'http' | 'https';
    defaultImage?: string;
    lifecycleUrl?: string;
    placement?: {
        clusterId: string;
        namespace: string;
    };
}
export interface SandboxSettingsRecord {
    settings: SandboxSettings;
    encryptedApiKey?: string;
}
export type SandboxSettingsSecretUpdate = {
    action: 'retain';
} | {
    action: 'replace';
    encryptedApiKey: string;
} | {
    action: 'clear';
};
export interface SandboxSettingsStore {
    getSandboxSettingsRecord(ctx: {
        tenantId: string;
    }): Promise<SandboxSettingsRecord | undefined>;
    setSandboxSettingsRecord(ctx: {
        tenantId: string;
    }, settings: SandboxSettings, secret: SandboxSettingsSecretUpdate): Promise<void>;
}
export interface SecretBoxLike {
    seal(plain: string): string;
    open(envelope: string): string;
}

// file: desktop.d.ts
/**
 * 远端浏览器预览 + computer-use 操作抽象。
 * 工具只依赖这些接口，由 E2bDesktopProvider（@e2b/desktop）或测试 mock 实现。
 */
export interface DesktopSpec {
    key: string;
    profile?: string;
    sandboxId?: string;
    template?: string;
    domain?: string;
    namespace?: string;
    serviceAccount?: string;
    metadata?: Record<string, string>;
    envs?: Record<string, string>;
    timeoutMs?: number;
}
export interface DesktopHandle {
    readonly sandboxId: string;
    /** 启动浏览器预览，返回前端 iframe 渲染的页面 URL。 */
    startStream(): Promise<string>;
    streamUrl(): string;
    /** 启动应用（如 google-chrome）并可选打开 URL。 */
    launch(application: string, uri?: string): Promise<void>;
    /** 远端浏览器当前页面 URL（用户可在本地浏览器新标签页直接打开）；后端不支持时缺省。 */
    currentUrl?(): Promise<string>;
    leftClick(x: number, y: number): Promise<void>;
    write(text: string): Promise<void>;
    screenshot(): Promise<Uint8Array>;
    kill(): Promise<void>;
}
export interface DesktopProvider {
    create(spec: DesktopSpec): Promise<DesktopHandle>;
    connect(sandboxId: string, spec: DesktopSpec): Promise<DesktopHandle>;
}

// file: e2b-desktop.d.ts
import type { DesktopHandle, DesktopProvider, DesktopSpec } from './desktop.js';
export interface E2bDesktopOptions {
    apiKey?: string;
    domain?: string;
}
/** 基于 @e2b/desktop 的远端桌面后端。 */
export declare class E2bDesktopProvider implements DesktopProvider {
    private readonly opts;
    constructor(opts?: E2bDesktopOptions);
    private connectOpts;
    create(spec: DesktopSpec): Promise<DesktopHandle>;
    connect(sandboxId: string, spec: DesktopSpec): Promise<DesktopHandle>;
}

// file: e2b.d.ts
import type { AiosE2bProviderOptions } from './aios-e2b.js';
import type { SandboxHandle, SandboxProvider, SandboxProviderOperationOptions, SandboxSpec } from './types.js';
export interface E2bProviderOptions {
    /** E2B API key；缺省读 E2B_API_KEY 环境变量。 */
    apiKey?: string;
    /** 自定义 E2B API 域名（自托管 / 集群内网关）。 */
    domain?: string;
    /** 配置时改走 AIOS Lifecycle REST；未配置时保持官方 E2B SDK 路径。 */
    aios?: AiosE2bProviderOptions;
}
/** 基于 @e2b/code-interpreter 的沙箱后端：新建 / 连接远端。 */
export declare class E2bProvider implements SandboxProvider {
    private readonly opts;
    private readonly aios?;
    constructor(opts?: E2bProviderOptions);
    private connectOpts;
    create(spec: SandboxSpec, options?: SandboxProviderOperationOptions): Promise<SandboxHandle>;
    connect(sandboxId: string, spec: SandboxSpec, options?: SandboxProviderOperationOptions): Promise<SandboxHandle>;
}

// file: index.d.ts
export * from './contracts.js';
export * from './types.js';
export * from './acquisition.js';
export * from './aios-e2b.js';
export * from './aios-http.js';
export * from './aios-template-catalog.js';
export * from './command-desktop.js';
export * from './desktop.js';
export * from './e2b-desktop.js';
export * from './e2b.js';
export * from './keys.js';
export * from './lifecycle.js';
export * from './local-desktop.js';
export * from './local.js';
export * from './notes.js';
export * from './opensandbox-desktop.js';
export * from './opensandbox.js';
export * from './output.js';
export * from './profiles.js';
export * from './runtime-controller.js';
export * from './runtime.js';
export * from './settings.js';
export * from './tool-adapter.js';
export * from './userhome.js';
export * from './warmpool.js';
export * from './workspace-path.js';

// file: keys.d.ts
export interface SandboxIdentity {
    tenantId?: string;
    userId?: string;
    sessionId: string;
}
export declare function sandboxIdentityKey(ctx: SandboxIdentity): string;
export declare function sandboxIdentityMetadata(ctx: SandboxIdentity): Record<string, string>;
export declare function sandboxScopedKey(identity: SandboxIdentity, suffix?: string): string;

// file: lifecycle.d.ts
import type { RequestContext } from './contracts.js';
import type { SandboxHandle, SandboxProvider, SandboxSpec } from './types.js';
import type { WarmPool } from './warmpool.js';
export interface SandboxSummary {
    id: string;
    sandboxId: string;
    key: string;
    status: 'ready';
    type: string;
    /** 已注入用户凭据（污染标记，销毁不回收）。 */
    credentialInjected?: boolean;
    profile?: string;
    image?: string;
    domain?: string;
    namespace?: string;
    serviceAccount?: string;
    capabilities?: string[];
    privileged?: boolean;
    sessionId: string;
    createdAt: string;
    lastUsedAt: string;
    metadata?: Record<string, string>;
}
export interface SandboxManagerLike {
    get(spec: SandboxSpec, options?: {
        signal?: AbortSignal;
    }): Promise<SandboxHandle>;
    evict?(key: string, expectedHandle: SandboxHandle): boolean;
    has(key: string): boolean;
    touch(key: string): boolean;
    use<T>(key: string, action: () => Promise<T>): Promise<T>;
    markCredentialInjected(key: string): void;
    size(): number;
    list(ctx?: RequestContext): SandboxSummary[];
    dispose(key: string): Promise<void>;
    disposeSession(ctx: RequestContext, sessionId: string): Promise<string[]>;
    disposeSession(sessionId: string): Promise<string[]>;
    disposeAll(): Promise<void>;
}
export interface SandboxManagerOptions {
    provider: SandboxProvider;
    /** 空闲多久(ms)后 GC 回收，默认 10 分钟。 */
    idleMs?: number;
    /** 默认沙箱存活超时(ms)，默认 1 小时。 */
    timeoutMs?: number;
    /** 可注入时钟，便于测试。 */
    now?: () => number;
    /** 可选预热池：新建（非连接远端）时优先从池中取，降低冷启动。 */
    warmPool?: WarmPool;
}
/**
 * 按逻辑键（默认 session×cluster）缓存沙箱：
 * - 首次按 spec 新建或连接远端，之后复用；
 * - 并发 get 同键只创建一次（inflight 去重）；
 * - 空闲超 idleMs 由 sweep() 回收（idle GC）。
 */
export declare class SandboxManager implements SandboxManagerLike {
    private provider;
    private draining;
    private disposed;
    private readonly idleMs;
    private readonly timeoutMs;
    private readonly now;
    private readonly warmPool?;
    private readonly entries;
    private readonly inflight;
    private inflightActivity;
    private readonly keyEpochs;
    private cleanupActivity;
    private sweepPromise?;
    private disposePromise?;
    constructor(opts: SandboxManagerOptions);
    /** 运行期切换沙箱后端（设置页保存连接配置后生效）：已有沙箱句柄不受影响，新建走新 provider。 */
    setProvider(provider: SandboxProvider): void;
    beginDrain(): void;
    activity(): {
        active: number;
        inflight: number;
        cleanup: number;
    };
    /** 取得（必要时创建 / 连接）一个沙箱句柄，并刷新其活跃时间。 */
    get(spec: SandboxSpec, options?: {
        signal?: AbortSignal;
    }): Promise<SandboxHandle>;
    has(key: string): boolean;
    /** 仅当缓存仍指向预期句柄时淘汰，避免旧执行误删同 key 的新句柄。 */
    evict(key: string, expectedHandle: SandboxHandle): boolean;
    /** 刷新缓存沙箱的本地活跃时间；用于已缓存 Desktop 的后续浏览器操作。 */
    touch(key: string): boolean;
    /** 在一次外部操作期间固定缓存 entry，避免 idle sweep 回收仍在执行的浏览器命令。 */
    use<T>(key: string, action: () => Promise<T>): Promise<T>;
    /**
     * 标记沙箱已注入用户凭据（污染）：该沙箱与用户绑定，生命周期只能随会话终结（sweep/dispose 即 kill），
     * 永不进入任何复用池。当前实现所有回收路径都是 kill，此标记兜底未来的复用型回收并供运维页展示。
     */
    markCredentialInjected(key: string): void;
    size(): number;
    /** 列出当前活跃沙箱，供运维页面展示会话绑定关系。 */
    list(ctx?: RequestContext): SandboxSummary[];
    /** 回收空闲超时的沙箱；重叠调用合并到同一次 kill 清理。 */
    sweep(): Promise<string[]>;
    private runSweep;
    /** 主动销毁某个沙箱；同时使相同 key 的并发创建失效。 */
    dispose(key: string): Promise<void>;
    /**
     * 销毁某会话名下的全部沙箱（会话关闭时调用）：
     * 默认键 = sessionId，集群键 = `${sessionId}:${cluster}`。单个 kill 失败仅告警，不影响其余。
     */
    disposeSession(ctx: RequestContext, sessionId: string): Promise<string[]>;
    disposeSession(sessionId: string): Promise<string[]>;
    /** 销毁全部（进程退出时调用）；晚完成的 provider create 会自毁且不写入缓存。 */
    disposeAll(): Promise<void>;
    private runDisposeAll;
    private invalidate;
    private kill;
}

// file: local-desktop.d.ts
import type { DesktopHandle, DesktopProvider, DesktopSpec } from './desktop.js';
export declare class LocalDesktopProvider implements DesktopProvider {
    create(spec: DesktopSpec): Promise<DesktopHandle>;
    connect(sandboxId: string, spec: DesktopSpec): Promise<DesktopHandle>;
}

// file: local.d.ts
import type { SandboxHandle, SandboxProvider, SandboxSpec } from './types.js';
export declare const LOCAL_SYNC_MAX_GENERATIONS = 16;
export declare const LOCAL_SYNC_MAX_BYTES: number;
export interface LocalSandboxProviderOptions {
    platform?: NodeJS.Platform;
    procFdAvailable?: () => Promise<boolean>;
    maxSyncGenerations?: number;
    maxSyncBytes?: number;
}
/** 本地开发用沙箱：在临时目录中执行命令/代码，不提供强隔离。 */
export declare class LocalSandboxProvider implements SandboxProvider {
    private readonly platform;
    private readonly procFdAvailable;
    private readonly limits;
    constructor(options?: LocalSandboxProviderOptions);
    create(spec: SandboxSpec): Promise<SandboxHandle>;
    connect(_sandboxId: string, spec: SandboxSpec): Promise<SandboxHandle>;
    private rejectUnsupportedResources;
    private requireSupportedPlatform;
}

// file: logger.d.ts
import pino from 'pino';
export declare const logger: pino.Logger<never, boolean>;

// file: notes.d.ts
/**
 * 沙箱启用时注入系统提示的静态规范片段（与按用户动态生成的 userhome.ts 提示并列注入）。
 */
/** 服务类代码的启动与访问链接规范：让用户能直接点开沙箱里跑起来的服务。 */
export declare const SANDBOX_SERVICE_NOTE: string;

// file: opensandbox-desktop.d.ts
import { CommandDesktopProvider } from './command-desktop.js';
export declare class OpenSandboxDesktopProvider extends CommandDesktopProvider {
}

// file: opensandbox.d.ts
import type { SandboxHandle, SandboxProvider, SandboxSpec } from './types.js';
/**
 * OpenSandbox（阿里开源沙箱）后端：通过 @alibaba-group/opensandbox SDK
 * 对接其 Lifecycle + execd API，适配为统一的 SandboxProvider/SandboxHandle，
 * 与 E2bProvider 可互换（由 config.sandbox.provider 选择）。
 */
export interface OpenSandboxProviderOptions {
    /** Lifecycle API 域名（host[:port]，无 scheme）；缺省由 SDK 取 env / localhost:8080。 */
    domain?: string;
    /** http / https；缺省由 SDK 推断（默认 http）。 */
    protocol?: 'http' | 'https';
    /** API key（请求头 OPEN-SANDBOX-API-KEY）。 */
    apiKey?: string;
    /** 未指定 template 时的默认镜像。 */
    defaultImage?: string;
    /** 单请求超时（秒）。 */
    requestTimeoutSeconds?: number;
}
export declare class OpenSandboxProvider implements SandboxProvider {
    private readonly opts;
    constructor(opts?: OpenSandboxProviderOptions);
    private connConfig;
    create(spec: SandboxSpec): Promise<SandboxHandle>;
    connect(sandboxId: string, spec: SandboxSpec): Promise<SandboxHandle>;
}

// file: output.d.ts
export declare function joinLogText(parts: string[]): string;

// file: profiles.d.ts
import type { Role, SandboxConfig } from './contracts.js';
import { type SandboxIdentity } from './keys.js';
import type { SandboxSpec } from './types.js';
export type SandboxProfileEnvType = 'code' | 'browser';
export type SandboxProfileRuntimeRole = 'sandbox-reader' | 'sandbox-diag';
export interface SandboxProfile {
    id: string;
    name: string;
    template?: string;
    description: string;
    envType: SandboxProfileEnvType;
    runtimeRole: SandboxProfileRuntimeRole;
    image?: string;
    domain?: string;
    namespace?: string;
    serviceAccount?: string;
    desktop: boolean;
    privileged: boolean;
    capabilities: string[];
    envs?: Record<string, string>;
    timeoutMs?: number;
}
export interface PublicSandboxProfile {
    id: string;
    name: string;
    template?: string;
    description: string;
    envType: SandboxProfileEnvType;
    runtimeRole: SandboxProfileRuntimeRole;
    image?: string;
    domain?: string;
    namespace?: string;
    serviceAccount?: string;
    desktop: boolean;
    privileged: boolean;
    capabilities: string[];
    timeoutMs?: number;
}
export declare function resolveSandboxProfiles(config: SandboxConfig | undefined): SandboxProfile[];
export declare function publicSandboxProfile(profile: SandboxProfile): PublicSandboxProfile;
export declare function publicSandboxProfiles(profiles: SandboxProfile[]): PublicSandboxProfile[];
export declare function canUseSandboxProfile(profile: SandboxProfile, role: Role): boolean;
export declare function visibleSandboxProfiles(profiles: SandboxProfile[], role: Role): SandboxProfile[];
export declare function selectDefaultProfile(profiles: SandboxProfile[], role?: Role): SandboxProfile | undefined;
export declare function selectBrowserProfile(profiles: SandboxProfile[], role?: Role, options?: {
    fallbackToCode?: boolean;
}): SandboxProfile | undefined;
export declare function findSandboxProfile(profiles: SandboxProfile[], selector?: string, role?: Role): SandboxProfile;
export declare function sandboxProfileKey(identity: SandboxIdentity, profile: SandboxProfile): string;
export declare function sandboxSpecForProfile(profile: SandboxProfile, ctx: SandboxIdentity): SandboxSpec;

// file: runtime-controller.d.ts
import type { RequestContext, ToolContext } from './contracts.js';
import { SandboxManager, type SandboxManagerOptions, type SandboxSummary } from './lifecycle.js';
import type { DesktopHandle } from './desktop.js';
import { type PublicSandboxProfile, type SandboxProfile } from './profiles.js';
import type { SandboxHandle, SandboxSpec } from './types.js';
import type { SandboxAcquisition, SandboxAcquirer, SpecResolver } from './acquisition.js';
export interface SandboxCatalogGenerationInfo {
    fingerprint: string;
    templateCount: number;
    loadedAt: string;
}
export interface SandboxGenerationInput {
    manager: SandboxManagerOptions | SandboxManager;
    profiles: SandboxProfile[];
    catalog?: SandboxCatalogGenerationInfo;
    resolveSpec?: SpecResolver;
    sweepMs?: number;
    drainWarmPool?: () => Promise<void>;
    resolveDesktop?: (ctx: ToolContext) => Promise<{
        key: string;
        create: () => Promise<DesktopHandle>;
    }>;
    /** 候选 generation 未 commit 时释放 prepare 阶段创建的资源（如 warm pool）。 */
    disposePrepared?: () => Promise<void>;
    disposeResources?: () => Promise<void>;
}
export declare class SandboxRuntimeController implements SandboxAcquirer {
    private current?;
    private readonly draining;
    private sequence;
    private disposed;
    enabled(): boolean;
    codeEnabled(): boolean;
    desktopEnabled(): boolean;
    catalogInfo(): SandboxCatalogGenerationInfo | undefined;
    profileDefinitions(ctx?: Pick<RequestContext, 'role'>): SandboxProfile[];
    profiles(ctx?: Pick<RequestContext, 'role'>): PublicSandboxProfile[];
    desktop(ctx: ToolContext): Promise<DesktopHandle>;
    acquire(ctx: ToolContext, profile?: string): Promise<SandboxAcquisition>;
    acquireSpec(ctx: ToolContext, source: SandboxSpec | (() => SandboxSpec | Promise<SandboxSpec>)): Promise<SandboxAcquisition>;
    commit(input?: SandboxGenerationInput): Promise<void>;
    get(spec: SandboxSpec): Promise<SandboxHandle>;
    has(key: string): boolean;
    touch(key: string): boolean;
    use<T>(key: string, action: () => Promise<T>): Promise<T>;
    markCredentialInjected(key: string): void;
    size(): number;
    list(ctx?: RequestContext): SandboxSummary[];
    dispose(key: string): Promise<void>;
    disposeSession(ctx: RequestContext, sessionId: string): Promise<string[]>;
    disposeSession(sessionId: string): Promise<string[]>;
    disposeAll(): Promise<void>;
    private createGeneration;
    private generations;
    private killDesktop;
    private evictDesktops;
    private pinCurrent;
    private unpin;
    private resolveSpec;
    private sessionKeys;
    private captureSessionEpochs;
    private operationValid;
    private assertOperationValid;
    private startDrainIfIdle;
    private cleanupDraining;
    private cleanupGeneration;
}

// file: runtime.d.ts
import type { DownloadFile, ExecResult, OutputSink, SandboxCommand, SandboxHandle, SandboxProvider, SandboxSpec, UploadFile } from './types.js';
import type { IdentityContext } from '@aiop/control-contracts';
import type { SandboxAcquisition } from './acquisition.js';
export interface AcquireSandboxRuntimeInput {
    spec?: SandboxSpec;
    identity?: IdentityContext;
    profile?: string;
    cpu?: number;
    memoryMb?: number;
    network?: 'none' | 'restricted' | 'full';
    timeoutMs?: number;
    signal?: AbortSignal;
}
export interface SandboxLease {
    id: string;
    sandboxId: string;
    provider: string;
    profile?: string;
}
export interface ExecuteSandboxInput {
    lease: SandboxLease;
    command?: string | SandboxCommand;
    code?: string;
    language?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    onOutput?: OutputSink;
}
export interface SandboxExecutionResult extends ExecResult {
    timedOut?: boolean;
}
export interface ReleaseSandboxInput {
    lease: SandboxLease;
}
export interface UploadSandboxInput {
    lease: SandboxLease;
    file: UploadFile;
    signal?: AbortSignal;
}
export interface DownloadSandboxInput {
    lease: SandboxLease;
    path: string;
    signal?: AbortSignal;
}
export interface ReconcileSandboxInput {
    activeLeaseIds: readonly string[];
}
export interface ReconcileSandboxResult {
    activeLeaseIds: string[];
    releasedLeaseIds: string[];
}
export interface SandboxRuntimeOptions {
    provider: SandboxProvider;
    providerName: string;
}
export declare class SandboxRuntime {
    private readonly options;
    private readonly leases;
    constructor(options: SandboxRuntimeOptions);
    acquire(input: AcquireSandboxRuntimeInput): Promise<SandboxLease>;
    adopt(input: {
        handle: SandboxHandle;
        spec: SandboxSpec;
        signal?: AbortSignal;
        invalidate?: () => void;
    }): Promise<SandboxLease>;
    private register;
    execute(input: ExecuteSandboxInput): Promise<SandboxExecutionResult>;
    upload(input: UploadSandboxInput): Promise<void>;
    download(input: DownloadSandboxInput): Promise<DownloadFile>;
    stop(input: ReleaseSandboxInput): Promise<void>;
    release(input: ReleaseSandboxInput): Promise<void>;
    reconcile(input: ReconcileSandboxInput): Promise<ReconcileSandboxResult>;
    private requireActive;
    private raceControls;
    private raceVoid;
    private invalidate;
    private abortEntry;
}
export declare function executeAcquiredSandbox(acquired: Pick<SandboxAcquisition, 'handle' | 'spec' | 'invalidate'>, input: Omit<ExecuteSandboxInput, 'lease'>): Promise<SandboxExecutionResult>;
export declare function downloadAcquiredSandbox(acquired: Pick<SandboxAcquisition, 'handle' | 'spec' | 'invalidate'>, input: Omit<DownloadSandboxInput, 'lease'>): Promise<DownloadFile>;
export declare function uploadAcquiredSandbox(acquired: Pick<SandboxAcquisition, 'handle' | 'spec' | 'invalidate'>, input: Omit<UploadSandboxInput, 'lease'>): Promise<void>;

// file: settings.d.ts
import { z } from 'zod';
import type { SandboxConfig, SandboxSettings, SandboxSettingsStore, SecretBoxLike } from './contracts.js';
export declare const SandboxSettingsSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    enabled: z.ZodBoolean;
    mode: z.ZodLiteral<"standard_e2b">;
    domain: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>>;
}, z.core.$strict>, z.ZodObject<{
    enabled: z.ZodBoolean;
    mode: z.ZodLiteral<"aios_lifecycle">;
    lifecycleUrl: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
    placement: z.ZodObject<{
        clusterId: z.ZodString;
        namespace: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    enabled: z.ZodBoolean;
    mode: z.ZodLiteral<"opensandbox">;
    domain: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>>;
    protocol: z.ZodOptional<z.ZodEnum<{
        http: "http";
        https: "https";
    }>>;
    defaultImage: z.ZodOptional<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
    enabled: z.ZodBoolean;
    mode: z.ZodLiteral<"local">;
}, z.core.$strict>], "mode">;
export type SandboxApiKeyUpdate = {
    action: 'retain';
} | {
    action: 'replace';
    apiKey: string;
} | {
    action: 'clear';
};
export interface LoadedSandboxSettings {
    settings: SandboxSettings;
    apiKey?: string;
    apiKeySet: boolean;
}
export declare function parseSandboxSettings(value: unknown): SandboxSettings;
/** 把当前启动配置投影为页面设置；只用于展示，不写回数据库。 */
export declare function sandboxConfigToSettings(config: SandboxConfig): SandboxSettings;
/** key 只与模式和规范化远端目标绑定；AIOS placement 不改变凭据目标。 */
export declare function credentialTargetForSandboxSettings(settings: SandboxSettings): string;
/** 把已验证、已解密的页面设置转换成 provider 运行配置。 */
export declare function sandboxSettingsToConfig(settings: SandboxSettings, apiKey?: string): SandboxConfig;
/** 平台 Sandbox 设置编排：加解密、目标绑定校验和配置+secret 原子保存。 */
export declare class SandboxSettingsPersistence {
    private readonly store;
    private readonly box;
    private readonly ctx;
    constructor(store: SandboxSettingsStore, box: SecretBoxLike, ctx?: {
        tenantId: string;
    });
    load(): Promise<LoadedSandboxSettings | undefined>;
    save(input: SandboxSettings, update: SandboxApiKeyUpdate): Promise<LoadedSandboxSettings>;
    private retainedSecret;
}

// file: tool-adapter.d.ts
import type { JsonValue } from '@aiop/control-contracts';
import type { GovernedToolDefinition } from '@aiop/pi-runtime';
import type { ExecResult } from './types.js';
import type { DesktopHandle } from './desktop.js';
interface OperationOptions {
    signal?: AbortSignal;
}
export interface SandboxToolOperations {
    runCode(code: string, options: OperationOptions & {
        language?: string;
    }): Promise<ExecResult>;
    runCommand(command: string, options: OperationOptions): Promise<ExecResult>;
    readFile(path: string, options: OperationOptions): Promise<Uint8Array>;
    writeFile(path: string, content: Uint8Array, options: OperationOptions): Promise<void>;
    desktop(input: Record<string, JsonValue>, options: OperationOptions): Promise<string>;
}
export declare class SandboxDesktopRuntime {
    execute<T>(handle: DesktopHandle, operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}
export declare function createSandboxToolDefinitions(operations: SandboxToolOperations): GovernedToolDefinition[];
export {};

// file: types.d.ts
/**
 * 沙箱抽象层：SandboxManager / 工具只依赖这些接口，
 * 具体由 E2bProvider（@e2b/code-interpreter）或测试 mock 实现，
 * 从而 agent / 工具与 E2B SDK 解耦、可在无 API key 时单测。
 */
/** 代码 / 命令执行结果。 */
export interface ExecResult {
    stdout: string;
    stderr: string;
    /** 命令退出码；run_code 一般无退出码。 */
    exitCode?: number;
    /** 执行期错误（异常 / 非零退出）的可读信息。 */
    error?: string;
}
/** 挂载进沙箱的卷（宿主机 hostPath 绑定）。仅 opensandbox 后端支持；local/e2b 忽略。 */
export interface SandboxVolume {
    /** 卷名（沙箱内唯一）。 */
    name: string;
    /** 宿主机绝对路径。 */
    hostPath: string;
    /** 沙箱容器内挂载点（绝对路径）。 */
    mountPath: string;
    readOnly?: boolean;
}
/** 一个沙箱的创建 / 连接规格。 */
export interface SandboxSpec {
    /** 逻辑缓存键：同一 (session × cluster) 复用同一个沙箱。 */
    key: string;
    /** 沙箱模板/profile 名称，用于 UI 展示和会话内多沙箱隔离。 */
    profile?: string;
    /** 连接远端既有沙箱时提供其 id；不提供则新建。 */
    sandboxId?: string;
    /** 模板 / 镜像（动态拉起到集群内部时使用）。 */
    template?: string;
    /** 动态拉起到目标集群时使用的命名空间。 */
    namespace?: string;
    /** 动态拉起到目标集群时绑定的 ServiceAccount。 */
    serviceAccount?: string;
    /** 透传给沙箱控制面的元数据，用于审计 / 调度 / 自托管控制面扩展。 */
    metadata?: Record<string, string>;
    /** 沙箱存活超时(ms)，到期被 E2B 回收。 */
    timeoutMs?: number;
    /** Provider-neutral resource requests retained from the former sandbox packages. */
    cpu?: number;
    memoryMb?: number;
    network?: 'none' | 'restricted' | 'full';
    /** 覆盖 E2B 控制面域名（多集群：每集群一个控制面）。 */
    domain?: string;
    /** 注入沙箱的环境变量（如 in-cluster 标记）。 */
    envs?: Record<string, string>;
    /** 创建时挂载的卷（如用户绑定的主机主目录）。带卷的沙箱不走预热池（卷必须创建时生效）。 */
    volumes?: SandboxVolume[];
}
/** 沙箱执行过程中的实时输出分片（用于前端终端预览）。 */
export interface OutputChunk {
    stream: 'stdout' | 'stderr';
    text: string;
}
/** 实时输出回调：执行期逐段回传 stdout/stderr。 */
export type OutputSink = (chunk: OutputChunk) => void;
export interface RunCodeOpts {
    language?: string;
    /** 提供时逐段回传 stdout/stderr（流式预览）；不影响最终 ExecResult。 */
    onOutput?: OutputSink;
}
export interface RunCommandOpts {
    timeoutMs?: number;
    /** 提供时逐段回传 stdout/stderr（流式预览）；不影响最终 ExecResult。 */
    onOutput?: OutputSink;
}
export interface SandboxCommand {
    program: string;
    args?: readonly string[];
    cwd?: string;
    env?: Readonly<Record<string, string>>;
    timeoutMs?: number;
}
export interface UploadFile {
    path: string;
    content: Uint8Array;
}
export interface DownloadFile {
    path: string;
    content: Uint8Array;
}
/** 一个已就绪沙箱的统一句柄。 */
export interface SandboxHandle {
    readonly sandboxId: string;
    /** Whether this provider can keep injected secret files isolated from the host environment. */
    readonly supportsSecretFiles?: boolean;
    /** Returns a command-visible path beneath this sandbox's workspace root. */
    workspacePath?(relativePath?: string): string;
    /** 在沙箱里执行代码（默认 python）。 */
    runCode(code: string, opts?: RunCodeOpts): Promise<ExecResult>;
    /** 在沙箱里执行 shell 命令。 */
    runCommand(command: string, opts?: RunCommandOpts): Promise<ExecResult>;
    /** Executes without shell parsing when the provider supports structured commands. */
    executeCommand?(command: SandboxCommand, opts?: RunCommandOpts): Promise<ExecResult>;
    /** 读取沙箱内文件的原始字节（用于导出 / 下载）。文件不存在或不可读时抛错。 */
    readFile(path: string): Promise<Uint8Array>;
    /** Writes bytes without placing file contents in a shell command or command log. */
    writeFile?(path: string, content: Uint8Array, options?: {
        mode?: number;
    }): Promise<void>;
    /** Reserves one local skill-sync generation before any files are written. */
    reserveSyncGeneration?(bytes: number): Promise<void>;
    /** 续命，防止被回收。 */
    setTimeout(ms: number): Promise<void>;
    /** 销毁沙箱。 */
    kill(): Promise<void>;
}
/** 沙箱后端：负责新建 / 连接。 */
export interface SandboxProviderOperationOptions {
    signal?: AbortSignal;
}
export interface SandboxProvider {
    create(spec: SandboxSpec, options?: SandboxProviderOperationOptions): Promise<SandboxHandle>;
    connect(sandboxId: string, spec: SandboxSpec, options?: SandboxProviderOperationOptions): Promise<SandboxHandle>;
}

// file: userhome.d.ts
/**
 * 用户主目录绑定：校验 / 归一化宿主机路径（HTTP 绑定时与沙箱创建时共用）。
 * 安全边界：只允许绝对路径、拒绝 . / .. 段；配置 sandbox.userHomeRoot 时必须位于其下。
 */
/** 绑定主目录时注入系统提示的说明：引导模型默认在挂载目录下工作、把交付物写进持久化目录。 */
export declare function userHomeSystemNote(mountPath: string): string;
/**
 * 查询用户绑定并通过校验的主目录，返回对应的系统提示片段；
 * 未绑定 / 校验不过（如管理员事后收紧 root，挂载同样会被拒绝）返回空串。
 */
export declare function boundUserHomeNote(store: {
    getUser(tenantId: string, userId: string): Promise<{
        homeDir?: string;
    } | undefined>;
}, tenantId: string | undefined, userId: string | undefined, cfg: {
    root?: string;
    mountPath: string;
}): Promise<string>;
/** 校验并归一化用户绑定的主机主目录；不合法时抛出带原因的 Error。 */
export declare function normalizeUserHomeDir(raw: string, root?: string): string;

// file: warmpool.d.ts
import type { SandboxHandle, SandboxProvider, SandboxSpec } from './types.js';
export interface WarmPoolOptions {
    provider: SandboxProvider;
    /** 预热使用的基础规格（template/domain 等；key 仅占位）。 */
    spec: Omit<SandboxSpec, 'key'>;
    /** 池容量（预热的空闲沙箱数）。 */
    size: number;
    /** drain 等待并发补位的最长时间，默认 5 秒。 */
    drainTimeoutMs?: number;
    /** 可注入等待函数，便于确定性测试。 */
    sleep?: (ms: number) => Promise<void>;
}
/**
 * 预热池：预先创建若干沙箱，acquire() 立即返回一个并异步补位，
 * 降低冷启动延迟。SandboxManager 创建新沙箱时可优先从池中取。
 */
export declare class WarmPool {
    private readonly provider;
    private readonly baseSpec;
    private readonly size;
    private readonly drainTimeoutMs;
    private readonly sleep?;
    private ready;
    private refillPromise?;
    private drainPromise?;
    private closed;
    constructor(opts: WarmPoolOptions);
    /** 预热到容量。 */
    start(): Promise<void>;
    available(): number;
    /** 取一个预热沙箱（无则即时创建）；取后异步补位。 */
    acquire(): Promise<SandboxHandle>;
    private create;
    private scheduleRefill;
    private refill;
    /** 关闭并销毁池中空闲沙箱；并发补位仅有界等待，晚到 handle 由 refill 自毁。 */
    drain(): Promise<void>;
    private runDrain;
}

// file: workspace-path.d.ts
export declare function remoteWorkspacePath(relativePath?: string): string;
export declare function localWorkspacePath(relativePath?: string): string;
