import { Agent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';

export const LLM_INSECURE_TLS_HEADER = 'x-aiop-internal-llm-insecure-tls';
let installed = false;

type Dispatch = Dispatcher['dispatch'];

/**
 * 为显式标记的 LLM 请求跳过服务端证书校验。内部标记会在请求发出前删除，
 * 未标记请求仍交给原全局 dispatcher，避免影响 OIDC、MCP、Sandbox 等连接。
 */
export function llmTlsHeaders(allowInsecureTls?: boolean): Record<string, string> | undefined {
  if (!allowInsecureTls) return undefined;
  installLlmTlsDispatcher();
  return { [LLM_INSECURE_TLS_HEADER]: '1' };
}

export function createLlmTlsRoutingInterceptor(
  insecureDispatcher: Pick<Dispatcher, 'dispatch'>,
): (secureDispatch: Dispatch) => Dispatch {
  return (secureDispatch) => (options, handler) => {
    const routed = stripInsecureTlsHeader(options.headers);
    const next = { ...options, headers: routed.headers };
    return routed.insecure
      ? insecureDispatcher.dispatch(next, handler)
      : secureDispatch(next, handler);
  };
}

function installLlmTlsDispatcher(): void {
  if (installed) return;
  const secureDispatcher = getGlobalDispatcher();
  const insecureDispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  setGlobalDispatcher(secureDispatcher.compose(createLlmTlsRoutingInterceptor(insecureDispatcher)));
  installed = true;
}

function stripInsecureTlsHeader(headers: Dispatcher.DispatchOptions['headers']): {
  headers: Dispatcher.DispatchOptions['headers'];
  insecure: boolean;
} {
  if (!headers) return { headers, insecure: false };
  let insecure = false;

  if (Array.isArray(headers)) {
    const filtered: string[] = [];
    for (let i = 0; i < headers.length; i += 2) {
      const name = headers[i];
      if (typeof name === 'string' && name.toLowerCase() === LLM_INSECURE_TLS_HEADER) {
        insecure = true;
        continue;
      }
      filtered.push(name ?? '', headers[i + 1] ?? '');
    }
    return { headers: filtered, insecure };
  }

  if (Symbol.iterator in Object(headers)) {
    const filtered: Array<[string, string | string[] | undefined]> = [];
    for (const [name, value] of headers as Iterable<[string, string | string[] | undefined]>) {
      if (name.toLowerCase() === LLM_INSECURE_TLS_HEADER) insecure = true;
      else filtered.push([name, value]);
    }
    return { headers: filtered, insecure };
  }

  const filtered: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === LLM_INSECURE_TLS_HEADER) insecure = true;
    else filtered[name] = value;
  }
  return { headers: filtered, insecure };
}
