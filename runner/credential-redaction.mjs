// Credential formats shared by the runner and the control plane (src/core/redaction.ts), so agent output loses a
// credential by its form wherever it is stored or shown, not only when the exact value is known (#1087).

/**
 * A GitHub token: ghp_, gho_, ghu_, ghs_, ghr_ or github_pat_, in the classic form (`ghs_` and 36 characters) or as
 * `<prefix><id>_<JWT>`, whose segments are joined by `.` and `-`. The `*` tail that `gh auth status` prints for the part
 * after the token's last `_` belongs to it; a sentence's final period does not. It starts at a word boundary, or right
 * after an escape (`\n` inside JSON text) or a terminal colour code. At least 20 characters after the prefix keep names
 * such as `ghs_prefix` readable; a token `gh` masked completely (`ghs_****`) has nothing left to hide and stays.
 * The prefix comes first and the boundary is checked behind it, so a scan only stops where the prefix occurs.
 */
export const githubTokenSource = String.raw`(?:github_pat_|gh[pousr]_)(?<=(?:^|\W|\\[nrt]|\[[\d;]*m)(?:github_pat_|gh[pousr]_))(?=[\w.-]{20})\w+(?:[.-]\w+)*\**`;
export const githubTokens = () => new RegExp(githubTokenSource, 'g');

const privateKey = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?)-----[\s\S]*?(?:-----END \1-----|$)/g;
const privateKeyStart = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?)-----/;
// Credentials that name themselves by their own form. None of them spans a line.
const tokens = new RegExp(githubTokenSource + '|' + String.raw`\b(?:sk|sk-proj)-[\w-]+|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:glpat-[\w-]+|xox[baprs]-[\w-]+|AIza[\w-]{30,})|\brrt_[\w-]{12}\.[\w-]{20,}|\beyJ[\w-]+\.[\w-]+\.[\w-]+\b`, 'g');

const credentialName = /^(?:(?:[\w-]*[_-])?(?:token|secret|secret[ _-]?key|password|passwd|api[ _-]?key|access[ _-]?key|credential|credential[ _-]?value)|authorization|cookie|set-cookie|private[_-]?key|encrypt[_-]?key|密码|凭据|私钥)$/i;
const explicitSecretName = /^(?:authorization|cookie|set-cookie|.*(?:password|passwd|secret|secret[ _-]?key|api[ _-]?key|access[ _-]?key|private[_-]?key|encrypt[_-]?key)|密码|凭据|私钥)$/i;
function credentialLike(value) {
  return value.length >= 16 && /^[A-Za-z0-9._~+/=-]+$/.test(value)
    && (value.length >= 24 || /[0-9._~+/=-]/.test(value) || /[a-z]/.test(value) && /[A-Z]/.test(value));
}
function secretValue(name, value, code = false) {
  name = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  if (!credentialName.test(name) || !value.trim() || value === '[REDACTED]') return false;
  // A named Authorization header is a credential position, including short Basic and non-Bearer schemes.
  if (/^authorization$/i.test(name)) return true;
  // An unquoted function call is code. Explicit password fields can contain digits or parentheses too.
  if (code && /^[\w$.]+\([^)]*\)$/.test(value) || /^\d+(?:\.\d+)?$/.test(value) && !explicitSecretName.test(name)) return false;
  return credentialLike(value) || explicitSecretName.test(name);
}

/** Private keys and self-identifying tokens: the shapes that are a credential wherever they appear, code included. */
function shapes(text, hit) {
  const marker = () => { hit(); return '[REDACTED]'; };
  return text.replace(privateKey, marker).replace(tokens, marker);
}
/** The shapes and the credentials recognized by their context: headers, Bearer values, named fields and URL parts. */
function credentialText(text, hit) {
  const marker = () => { hit(); return '[REDACTED]'; };
  return shapes(text, hit)
    // Match the value inside prose or a backtick span. Digest authorization may contain several quoted parameters.
    .replace(/(\bauthorization["']?[ \t]*[:=][ \t]*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|(?:Bearer|Basic|Token)[ \t]+[^\s`"',;]+|\[REDACTED\]|[^\r\n`]+)/gi,
      (all, prefix) => all.slice(prefix.length) === '[REDACTED]' ? all : prefix + marker())
    // Cookie headers can carry several name=value pairs. Keep the sentence following the last pair.
    .replace(/(\b(?:cookie|set-cookie)["']?[ \t]*[:=][ \t]*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[\w!#$%&'*+.^_|~-]+=(?:"[^"\r\n]*"|[^;\s`'"]*)(?:;[ \t]*[\w!#$%&'*+.^_|~-]+=(?:"[^"\r\n]*"|[^;\s`'"]*))*|\[REDACTED\]|[^\r\n`]+)/gi,
      (all, prefix) => all.slice(prefix.length) === '[REDACTED]' ? all : prefix + marker())
    .replace(/\b(?:Bearer|Basic)\s+([A-Za-z0-9._~+/=-]+)/gi, (all, value) => credentialLike(value) ? marker() : all)
    .replace(/([?&](?:amp;)?)([\w%.-]{1,128})=(\[REDACTED\]|[^&#\s"'<>{}`)\]]*)/g, (all, separator, name, value) => {
      let key = name;
      try { key = decodeURIComponent(name); } catch { /* Keep the literal parameter name. */ }
      const sensitive = credentialName.test(key.replace(/([a-z0-9])([A-Z])/g, '$1_$2'))
        || /^(?:sig|signature|jwt|x-(?:amz|goog)-(?:signature|credential|security-token)|key-pair-id|googleaccessid|awsaccesskeyid)$/i.test(key);
      return sensitive && value && value !== '[REDACTED]' ? separator + name + '=' + marker() : all;
    })
    .replace(/((\b(?:api[ _-]?key|access[ _-]?key|[\w-]{1,128})|密码|凭据|私钥)["']?\s*[:=]\s*)(?:(["'])(.*?)\3|(\[REDACTED\]|[^\s,;"'}]+))/gi,
      (all, prefix, name, _quote, quoted, unquoted) => secretValue(name, quoted ?? unquoted ?? '', unquoted !== undefined) ? prefix + marker() : all)
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, (_all, scheme) => scheme + marker() + '@');
}

// Walks strings, arrays and objects. Text that is JSON is cleaned as its parsed value, so an escaped credential is found
// too, and keeps its exact bytes when nothing in it changed. named: also redact the values of credential-named fields.
// A rule changes text only through its marker, so counting markers tells whether anything changed.
function inspect(value, text, named) {
  let hits = 0; const hit = () => { hits++; };
  const visit = item => {
    if (typeof item === 'string') {
      if (/^\s*[\[{]/.test(item)) {
        let parsed; try { parsed = JSON.parse(item); } catch {}
        if (parsed !== undefined) { const before = hits, cleaned = visit(parsed); if (hits !== before) return JSON.stringify(cleaned); }
      }
      return text(item, hit);
    }
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, field]) => {
      if (named && (typeof field === 'string' || typeof field === 'number') && secretValue(key, String(field))) { hit(); return [key, '[REDACTED]']; }
      return [key, visit(field)];
    }));
    return item;
  };
  const cleaned = visit(value); return { value: cleaned, redacted: hits > 0 };
}

/** For what people read (logs, events, trajectories, snapshots): every credential rule. Ordinary keys and bytes stay. */
export function redactCredentials(value) { return inspect(value, credentialText, true).value; }
export function hasCredentials(value) { return inspect(value, credentialText, true).redacted; }
/**
 * For what the agent reads and acts on (tool results, result files): only the self-identifying shapes. The context
 * rules would also rewrite ordinary code such as `const token = options.token`, which the agent then edits.
 */
export function redactCredentialShapes(value) { return inspect(value, shapes, false).value; }

/**
 * redactCredentialShapes for text that arrives in pieces, such as a command's output. A shape never spans a line except a
 * private key block, so complete lines are cleaned as they arrive and an open block drops everything up to its end line.
 * A line longer than holdLimit is cut before a character that cannot belong to a shape.
 */
export function credentialShapeStream(write, holdLimit = 1024 * 1024) {
  let pending = '', open = null;
  const clean = text => {
    let out = '';
    for (;;) {
      if (open) { const end = text.indexOf(open); if (end < 0) return out; text = text.slice(end + open.length); open = null; }
      const begin = privateKeyStart.exec(text);
      if (!begin) return out + shapes(text, () => {});
      out += shapes(text.slice(0, begin.index), () => {}) + '[REDACTED]';
      open = `-----END ${begin[1]}-----`; text = text.slice(begin.index + begin[0].length);
    }
  };
  const flush = end => { if (end > 0) { const text = clean(pending.slice(0, end)); pending = pending.slice(end); if (text) write(text); } };
  return {
    data(text) {
      pending += text;
      let end = pending.lastIndexOf('\n') + 1;
      if (!end && pending.length > holdLimit) { const match = /[^\w.*\- [;][\w.*\- [;]*$/.exec(pending); end = match ? match.index : pending.length; }
      flush(end);
    },
    end() { flush(pending.length); open = null; }
  };
}
