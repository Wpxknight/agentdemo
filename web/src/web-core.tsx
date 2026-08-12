import { createContext, useContext, type ReactNode } from 'react';
import App from './App';
import type { WebHostAdapter } from './host-adapter';
// Extracted as the explicit aiop-web/style.css export; consumers must import that subpath.
import './index.css';

const HostContext = createContext<WebHostAdapter | undefined>(undefined);

export function useWebHost(): WebHostAdapter {
  const host = useContext(HostContext);
  if (!host) throw new Error('WebCore requires a WebHostAdapter');
  return host;
}

/** Reusable application core. An external host only needs to supply WebHostAdapter. */
export function WebCore({ host }: { host: WebHostAdapter }): ReactNode {
  return (
    <HostContext.Provider value={host}>
      <App />
    </HostContext.Provider>
  );
}

export type { LoginCredentials, WebAuthProvider, WebDeploymentMode, WebHostAdapter, WebHostAssets } from './host-adapter';
export { apiUrl } from './host-adapter';
export { AiosHostAdapter, type AiosExchangeCredential, type AiosHostAdapterOptions } from './aios-host-adapter';
