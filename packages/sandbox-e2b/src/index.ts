import type { SandboxProvider } from '@aiop/agent-contracts';

/** E2B SDK integration boundary; product credentials are injected by the composition root. */
export class E2BSandboxProviderAdapter implements SandboxProvider {
  constructor(private readonly delegate: SandboxProvider) {}
  acquire: SandboxProvider['acquire'] = (input) => this.delegate.acquire(input);
  execute: SandboxProvider['execute'] = (handle, command) => this.delegate.execute(handle, command);
  upload: SandboxProvider['upload'] = (handle, file) => this.delegate.upload(handle, file);
  download: SandboxProvider['download'] = (handle, path) => this.delegate.download(handle, path);
  release: SandboxProvider['release'] = (handle) => this.delegate.release(handle);
}
