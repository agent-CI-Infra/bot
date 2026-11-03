// The console receives this exact pattern from preflight; GitHub tags never use build metadata.
export const versionPattern = '^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?$';
export const validVersion = (value: string) => value.length <= 256 && new RegExp(versionPattern).test(value);
export const prerelease = (value: string) => value.includes('-');
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => { const at = v.indexOf('-'); return [v.slice(1, at < 0 ? undefined : at).split('.'), at < 0 ? [] : v.slice(at + 1).split('.')] as const; };
  const [ac, ap] = split(a), [bc, bp] = split(b);
  const numeric = (x: string, y: string) => BigInt(x) < BigInt(y) ? -1 : BigInt(x) > BigInt(y) ? 1 : 0;
  for (let i = 0; i < 3; i++) { const n = numeric(ac[i]!, bc[i]!); if (n) return n; }
  if (!ap.length || !bp.length) return ap.length ? -1 : bp.length ? 1 : 0;
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const x = ap[i], y = bp[i]; if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    return xn && yn ? numeric(x, y) : xn ? -1 : yn ? 1 : x < y ? -1 : 1;
  }
  return 0;
}
