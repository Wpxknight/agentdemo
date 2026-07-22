export const DEFAULT_AGENT_GRAPH_NAME = 'aiop-agent';
export const DEFAULT_AGENT_GRAPH_VERSION = 'v1';

export interface AgentGraphDescriptor<T> {
  name: string;
  version: string;
  value: T;
}

/** 保留旧图版本供在途 run 恢复，禁止无条件漂移到最新版。 */
export class AgentGraphRegistry<T> {
  private readonly graphs = new Map<string, T>();

  register(descriptor: AgentGraphDescriptor<T>): this {
    const key = graphKey(descriptor.name, descriptor.version);
    if (this.graphs.has(key)) throw new Error(`duplicate agent graph: ${key}`);
    this.graphs.set(key, descriptor.value);
    return this;
  }

  get(name: string, version: string): T | undefined {
    return this.graphs.get(graphKey(name, version));
  }

  require(name: string, version: string): T {
    const graph = this.get(name, version);
    if (!graph) throw new Error(`agent graph not found: ${graphKey(name, version)}`);
    return graph;
  }
}

function graphKey(name: string, version: string): string {
  return `${name}@${version}`;
}
