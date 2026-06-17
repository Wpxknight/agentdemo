import { readFileSync } from 'node:fs';
import { type Config, ConfigSchema } from './schema.js';

/** 去掉 JSONC 的注释（// 行注释、/* *\/ 块注释），保留字符串内的内容。 */
export function stripJsonComments(input: string): string {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    const next = input[i + 1];

    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i++;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && next === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

/** 把 "${VAR}" 占位替换为环境变量值（缺失则保留原样并不报错）。 */
export function substituteEnv(input: string, env = process.env): string {
  return input.replace(/\$\{([A-Z0-9_]+)\}/g, (m, key: string) => env[key] ?? m);
}

export function parseConfig(raw: string, env = process.env): Config {
  const json = substituteEnv(stripJsonComments(raw), env);
  return ConfigSchema.parse(JSON.parse(json));
}

export function loadConfig(path = process.env.AIOP_CONFIG ?? './config.jsonc'): Config {
  return parseConfig(readFileSync(path, 'utf8'));
}
