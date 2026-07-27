import type { SandboxProvider } from '@aiop/agent-contracts';

/** OpenSandbox SDK integration boundary; credentials and tenant policy remain outside the provider. */
export class OpenSandboxProviderAdapter implements SandboxProvider {
  constructor(private readonly delegate: SandboxProvider) {}
  acquire: SandboxProvider['acquire'] = (input) => this.delegate.acquire(input);
  execute: SandboxProvider['execute'] = (handle, command) => this.delegate.execute(handle, command);
  upload: SandboxProvider['upload'] = (handle, file) => this.delegate.upload(handle, file);
  download: SandboxProvider['download'] = (handle, path) => this.delegate.download(handle, path);
  release: SandboxProvider['release'] = (handle) => this.delegate.release(handle);
}
