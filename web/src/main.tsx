import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createStandaloneHost } from './standalone-host';
import { WebCore } from './web-core';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WebCore host={createStandaloneHost()} />
  </StrictMode>,
);
