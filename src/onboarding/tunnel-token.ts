import { fail } from '../core/security.js';

function validToken(token: string): boolean {
  if (token.length > 16384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(token)) return false;
  try {
    const decoded = Buffer.from(token, 'base64');
    // Buffer's decoder ignores malformed input; require a base64 round trip as well.
    const encoded = decoded.toString('base64');
    if ((token.includes('=') ? encoded : encoded.replace(/=+$/, '')) !== token) return false;
    const value = JSON.parse(decoded.toString('utf8'));
    return value !== null && ['a', 't', 's'].every(key => typeof value[key] === 'string' && value[key].trim().length > 0);
  } catch { return false; }
}

export function tunnelToken(input: string): string {
  const raw = input.trim();
  if (validToken(raw)) return raw;

  // Read shell words and remove quoting/line continuations without executing any input.
  const words = (raw.replace(/\\\r?\n/g, '').match(/(?:[^\s'"\\;&|()<>`]|\\[^\r\n]|'[^']*'|"(?:\\[\s\S]|[^"\\])*")+/g) || [])
    .map(word => word.replace(/'([^']*)'|"((?:\\[\s\S]|[^"\\])*)"|\\([^\r\n])/g,
      (_match, single: string | undefined, double: string | undefined, escaped: string | undefined) =>
        single ?? double?.replace(/\\([$`"\\])/g, '$1') ?? escaped ?? ''));
  const preferred = words.flatMap((word, index) => {
    if (word === '--token' || word === 'install' && words[index - 1] === 'service') return [words[index + 1] || ''];
    return word.startsWith('--token=') ? [word.slice('--token='.length)] : [];
  });
  // Scan the whole paste too: a second distinct valid token makes the choice ambiguous.
  const tokens = new Set([...preferred, ...words].filter(validToken));
  if (tokens.size !== 1) return fail(400, 'invalid_tunnel_token');
  return [...tokens][0]!;
}
