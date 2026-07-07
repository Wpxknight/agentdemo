import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** 私网 / 环回 / 链路本地网段：SSRF 防护据此拒绝目标地址。 */
export function isPrivateAddress(ip: string): boolean {
  if (ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')) return true;
  // IPv4-mapped IPv6（::ffff:10.0.0.1）取末段按 IPv4 判定
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const v4 = mapped ? mapped[1]! : ip;
  const p = v4.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return false;
  const [a, b] = p as [number, number, number, number];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true; // 链路本地（含云元数据 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/**
 * 校验对外请求 URL：仅 http/https；除非 allowPrivate，否则解析后的目标 IP 不得落在私网。
 * 返回解析后的 URL 对象。抛错表示应拒绝。
 */
export async function assertPublicUrl(rawUrl: string, allowPrivate = false): Promise<URL> {
  const url = new URL(rawUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`仅支持 http/https：${url.protocol}`);
  }
  if (allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true })).map((r) => r.address);
  if (!ips.length) throw new Error(`无法解析主机：${host}`);
  for (const ip of ips) {
    if (isPrivateAddress(ip)) throw new Error(`目标解析到私网地址（${ip}），已拒绝`);
  }
  return url;
}
