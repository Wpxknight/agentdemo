import type { z } from 'zod';
import type { ClusterSchema } from './schema.js';

export type ClusterConfig = z.infer<typeof ClusterSchema>;

export interface ClusterInfo extends ClusterConfig {
  name: string;
}

/** 集群注册表：按名字查找运维目标集群及其访问策略。 */
export class ClusterRegistry {
  private readonly map = new Map<string, ClusterInfo>();

  constructor(clusters: Record<string, ClusterConfig> = {}) {
    for (const [name, cfg] of Object.entries(clusters)) {
      this.map.set(name, { name, ...cfg });
    }
  }

  get(name: string): ClusterInfo | undefined {
    return this.map.get(name);
  }

  has(name: string): boolean {
    return this.map.has(name);
  }

  list(): ClusterInfo[] {
    return [...this.map.values()];
  }

  names(): string[] {
    return [...this.map.keys()];
  }
}
