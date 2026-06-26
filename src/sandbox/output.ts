export function joinLogText(parts: string[]): string {
  let out = '';
  for (const part of parts) {
    if (!part) continue;
    if (out && !out.endsWith('\n') && !part.startsWith('\n')) out += '\n';
    out += part;
  }
  return out;
}
