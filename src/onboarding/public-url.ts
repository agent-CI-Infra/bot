import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { publicAddress } from '../external/target.js';
import { fail, text } from '../core/security.js';

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
