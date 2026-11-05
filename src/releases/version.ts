// The console receives this exact pattern from preflight; GitHub tags never use build metadata.
export const versionPattern = '^(?![\\s\\S]*\\s)v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?$';
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
// Suggestions shown when a version is not above the previous tag: a prerelease's own stable version, otherwise the
// next patch and the next minor. The major version is never raised for the maintainer.
export function nextVersions(version: string): string[] {
  const at = version.indexOf('-'), [major, minor, patch] = version.slice(1, at < 0 ? undefined : at).split('.').map(BigInt) as [bigint, bigint, bigint];
  return at >= 0 ? [`v${major}.${minor}.${patch}`] : [`v${major}.${minor}.${patch + 1n}`, `v${major}.${minor + 1n}.0`];
}
