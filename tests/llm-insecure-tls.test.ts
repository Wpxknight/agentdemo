import type { Dispatcher } from 'undici';
import { describe, expect, it, vi } from 'vitest';
import {
  createLlmTlsRoutingInterceptor,
  LLM_INSECURE_TLS_HEADER,
} from '../src/llm/insecure-tls.js';

describe('LLM insecure TLS routing', () => {
  it('routes only marked requests through the insecure dispatcher and strips the marker', () => {
    const secureMock = vi.fn((_options: Dispatcher.DispatchOptions, _handler: Dispatcher.DispatchHandler) => true);
    const insecureMock = vi.fn((_options: Dispatcher.DispatchOptions, _handler: Dispatcher.DispatchHandler) => true);
    const secureDispatch = secureMock as unknown as Dispatcher['dispatch'];
    const insecureDispatch = insecureMock as unknown as Dispatcher['dispatch'];
    const dispatch = createLlmTlsRoutingInterceptor({ dispatch: insecureDispatch })(secureDispatch);
    const handler = {} as Dispatcher.DispatchHandler;

    expect(dispatch({
      method: 'POST',
      path: '/v1/messages',
      headers: {
        authorization: 'Bearer secret',
        [LLM_INSECURE_TLS_HEADER.toUpperCase()]: '1',
      },
    }, handler)).toBe(true);

    expect(secureMock).not.toHaveBeenCalled();
    expect(insecureMock).toHaveBeenCalledOnce();
    expect(insecureMock.mock.calls[0]![0].headers).toEqual({ authorization: 'Bearer secret' });
  });

  it('keeps ordinary requests on the original secure dispatcher', () => {
    const secureMock = vi.fn((_options: Dispatcher.DispatchOptions, _handler: Dispatcher.DispatchHandler) => true);
    const insecureMock = vi.fn((_options: Dispatcher.DispatchOptions, _handler: Dispatcher.DispatchHandler) => true);
    const secureDispatch = secureMock as unknown as Dispatcher['dispatch'];
    const insecureDispatch = insecureMock as unknown as Dispatcher['dispatch'];
    const dispatch = createLlmTlsRoutingInterceptor({ dispatch: insecureDispatch })(secureDispatch);
    const handler = {} as Dispatcher.DispatchHandler;

    dispatch({ method: 'GET', path: '/.well-known/openid-configuration', headers: ['accept', 'application/json'] }, handler);

    expect(secureMock).toHaveBeenCalledOnce();
    expect(insecureMock).not.toHaveBeenCalled();
    expect(secureMock.mock.calls[0]![0].headers).toEqual(['accept', 'application/json']);
  });
});
