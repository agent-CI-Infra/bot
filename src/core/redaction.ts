/** Credential-shaped content is distinct from trace-only field filtering and JSON formatting. */
const credentialName = /^(?:(?:[\w-]*[_-])?(?:token|secret|password|passwd|api[ _-]?key|access[ _-]?key|credential)|authorization|cookie|set-cookie|private[_-]?key|encrypt[_-]?key|密码|凭据|私钥)$/i;
const explicitSecretName = /^(?:authorization|cookie|set-cookie|.*(?:password|passwd|secret|api[ _-]?key|access[ _-]?key|private[_-]?key|encrypt[_-]?key)|密码|凭据|私钥)$/i;
function credentialLike(value: string): boolean {
  return value.length >= 16 && /^[A-Za-z0-9._~+/=-]+$/.test(value)
    && (value.length >= 24 || /[0-9._~+/=-]/.test(value) || /[a-z]/.test(value) && /[A-Z]/.test(value));
}
function secretValue(name: string, value: string, code = false): boolean {
  if (!credentialName.test(name) || !value.trim() || value === '[REDACTED]') return false;
  // An unquoted function call is code. Explicit password fields can contain digits or parentheses too.
  if (code && /^[\w$.]+\([^)]*\)$/.test(value) || /^\d+(?:\.\d+)?$/.test(value) && !explicitSecretName.test(name)) return false;
  if (/^authorization$/i.test(name)) { const match=/^(?:Bearer|Basic)\s+(.+)$/i.exec(value);return credentialLike(match?.[1]??value); }
  return credentialLike(value) || explicitSecretName.test(name);
}
function redactText(text: string, hit: () => void): string {
  const marker = () => { hit(); return '[REDACTED]'; };
  return text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, marker)
    .replace(/\b(?:github_pat_|gh[pousr]_)[\w]+|\b(?:sk|sk-proj)-[\w-]+|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:glpat-[\w-]+|xox[baprs]-[\w-]+|AIza[\w-]{30,})|\brrt_[\w-]{12}\.[\w-]{20,}|\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, marker)
    .replace(/\b(authorization|cookie|set-cookie)["']?\s*[:=]\s*([^\r\n]+)/gi, (all, name: string, value: string) => secretValue(name, value.replace(/^["']|["',]$/g, '')) ? marker() : all)
    .replace(/\b(?:Bearer|Basic)\s+([A-Za-z0-9._~+/=-]+)/gi, (all, value: string) => credentialLike(value) ? marker() : all)
    .replace(/((\b(?:api[ _-]?key|access[ _-]?key|[\w-]{1,128})|密码|凭据|私钥)["']?\s*[:=]\s*)(?:(["'])(.*?)\3|([^\s,;"'}]+))/gi,
      (all, prefix: string, name: string, _quote: string, quoted: string | undefined, unquoted: string | undefined) => secretValue(name, quoted ?? unquoted ?? '', unquoted !== undefined) ? prefix + marker() : all)
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, (_all, scheme: string) => scheme + marker() + '@');
}
/** Preserves ordinary keys and bytes; trace writers may apply their separate private-field policy afterwards. */
export function redactCredentials<T>(value: T): T {
  return inspectCredentials(value).value;
}
export function hasCredentials(value: unknown): boolean { return inspectCredentials(value).redacted; }
function inspectCredentials<T>(value: T): { value: T; redacted: boolean } {
  let redacted = false; const hit = () => { redacted = true; };
  const visit = (item: any): any => {
    if (typeof item === 'string') {
      // Inspect escaped JSON credentials while retaining the exact bytes of ordinary formatted input.
      if(/^\s*[\[{]/.test(item)) {
        let parsed:unknown;try{parsed=JSON.parse(item);}catch{}
        if(parsed!==undefined){const cleaned=visit(parsed);if(JSON.stringify(cleaned)!==JSON.stringify(parsed))return JSON.stringify(cleaned);}
      }
      return redactText(item, hit);
    }
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, field]) => {
      if (typeof field === 'string' && secretValue(key, field)) { hit(); return [key, '[REDACTED]']; }
      return [key, visit(field)];
    }));
    return item;
  };
  const cleaned=visit(value);return { value: cleaned, redacted };
}
