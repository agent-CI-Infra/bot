import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { publicAddress } from '../external/target.js';
import { fail, text } from '../core/security.js';
import type { Store } from '../storage/database.js';

// One business listener serves every path below; on the public origin they share a host but are not interchangeable.
export const loginCallbackPath = '/auth/github/callback', setupPath = '/onboarding/github/setup', registrationPath = '/onboarding/github/callback';

/** The public HTTPS origin the wizard verified for this instance, if any. */
export function verifiedOrigin(store: Store): string | undefined {
  const row = store.get("SELECT value FROM settings WHERE key='onboarding.public'");
  const origin = row ? JSON.parse(row.value)?.origin : undefined;
  return typeof origin === 'string' && origin ? origin : undefined;
}

/**
 * The deployment's own origin: BOT_PUBLIC_ORIGIN, or the deprecated BOT_ADMIN_ORIGIN it replaces. A malformed value or two
 * different values stop startup, because this origin anchors the Origin check and the OAuth callback.
 */
export function deploymentOrigin(env: Record<string, string | undefined>, warn: (message: string) => void = () => {}): string | undefined {
  const parse = (name: string): string | undefined => {
    const value = env[name]?.trim(); if (!value) return undefined;
    let url: URL;
    try { url = new URL(value); } catch { throw new Error(`${name} must be an origin such as https://bot.example.com`); }
    // The same rule as the GitHub login callback: HTTPS, or plain HTTP only on this machine for local testing.
    const loopback = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !loopback || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
      throw new Error(`${name} must be an HTTPS origin such as https://bot.example.com (http only for localhost or 127.0.0.1), without a path, query or credentials`);
    return url.origin;
  };
  const current = parse('BOT_PUBLIC_ORIGIN'), legacy = parse('BOT_ADMIN_ORIGIN');
  if (current && legacy && current !== legacy) throw new Error('BOT_PUBLIC_ORIGIN and the deprecated BOT_ADMIN_ORIGIN differ; keep only BOT_PUBLIC_ORIGIN');
  if (legacy) warn('BOT_ADMIN_ORIGIN is deprecated: the console and webhooks now share one origin; set BOT_PUBLIC_ORIGIN instead');
  return current || legacy;
}

export function publicOrigin(value: unknown): string {
  try {
    const url = new URL(text(value, 2048));
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !url.hostname.includes('.') || url.hostname.endsWith('.localhost')) throw new Error();
    return url.origin;
  } catch { return fail(400, 'public_https_origin_required'); }
}
// Resolve and pin every connection; a registered address must not be an SSRF route into the control plane.
export async function probeGet(url: string): Promise<{ status: number; body: string }> {
  const target = new URL(url), addresses = await lookup(target.hostname, { all: true });
  if (!addresses.length || addresses.some(row => !publicAddress(row.address))) return fail(400, 'public_address_required');
  return new Promise((resolve, reject) => {
    const req = https.get(target, { timeout: 10000, headers:{'User-Agent':'department-bot-address-check','Cache-Control':'no-cache'}, lookup: ((_host: string, options: any, callback: any) => {
      const row = addresses[0]!; callback(null, options?.all ? [row] : row.address, row.family);
    }) as any }, response => {
      let body = ''; response.on('data', chunk => { body += chunk.toString(); if (body.length > 65536) req.destroy(new Error('probe_response_too_large')); });
      response.on('end', () => resolve({ status: response.statusCode || 502, body })); response.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('probe_timeout'))); req.on('error', reject);
  });
}
