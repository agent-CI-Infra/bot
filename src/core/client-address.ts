import { isIP } from 'node:net';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';

// The bucket a password-login attempt counts against. Everything the decision needs enters here, and only a checked IP
// literal leaves: the request (with its forwarding headers) and the trusted-proxy list never travel further.
export function loginBucket(request: IncomingMessage, trustedProxies: readonly string[] = []): string {
  const resolved = clientAddress(request.socket.remoteAddress, request.headers, trustedProxies);
  return isIP(resolved) ? resolved : 'unknown';
}

// A forwarded address is read only when the immediate peer is a configured trusted proxy; otherwise the socket address
// is the client, so a forged header cannot buy a fresh bucket.
function clientAddress(peer: string | undefined, headers: IncomingHttpHeaders, trustedProxies: readonly string[]): string {
  const socket = normalize(peer || '');
  if (!socket) return 'unknown';
  if (!isTrusted(socket, trustedProxies)) return socket;
  // The nearest hop is our own proxy; walk back to the first address no trusted proxy stands for.
  for (const hop of forwardedChain(headers).reverse()) {
    const address = normalize(hop);
    if (address && !isTrusted(address, trustedProxies)) return address;
  }
  return socket;
}

function forwardedChain(headers: IncomingHttpHeaders): string[] {
  const raw = Array.isArray(headers['x-forwarded-for']) ? headers['x-forwarded-for'].join(',') : String(headers['x-forwarded-for'] || '');
  const fromHeader = raw.split(',').map(value => value.trim()).filter(Boolean);
  if (fromHeader.length) return fromHeader;
  const forwarded = Array.isArray(headers.forwarded) ? headers.forwarded.join(',') : String(headers.forwarded || '');
  return forwarded.split(',').map(part => {
    const match = /(?:^|;)\s*for=(?:"([^"]+)"|([^;]+))/i.exec(part.trim());
    return (match?.[1] || match?.[2] || '').trim();
  }).filter(Boolean);
}

function normalize(raw: string): string {
  let value = raw.trim().replace(/^"(.*)"$/, '$1');
  if (value.startsWith('[')) value = value.slice(1, value.indexOf(']'));
  else if (value.split(':').length === 2 && isIP(value.split(':')[0]!) === 4) value = value.split(':')[0]!;
  value = value.replace(/%.*$/, '');
  if (value.startsWith('::ffff:') && isIP(value.slice(7)) === 4) value = value.slice(7);
  return isIP(value) ? value.toLowerCase() : '';
}

function isTrusted(address: string, trustedProxies: readonly string[]): boolean {
  return trustedProxies.some(entry => {
    const value = entry.trim(); if (!value) return false;
    if (!value.includes('/')) return normalize(value) === address;
    const [base = '', bits = ''] = value.split('/'), size = Number(bits), network = normalize(base);
    // isIP() answers the address family (4 or 6), never the bit width; a prefix length is checked against 32 or 128 or
    // every CIDR an operator writes (/8, /32, /64 …) would be refused and the proxy trust would silently never apply.
    const addressValue = number(address), networkValue = number(network), width = isIP(address) === 4 ? 32 : 128;
    // 0 is a valid address value (0.0.0.0, ::), so an unparsable side is null and nothing else.
    if (addressValue === null || networkValue === null || isIP(address) !== isIP(network) || !Number.isInteger(size) || size < 0 || size > width) return false;
    const shift = BigInt(width - size);
    return addressValue >> shift === networkValue >> shift;
  });
}

function number(ip: string): bigint | null {
  const version = isIP(ip); if (!version) return null;
  if (version === 4) return ip.split('.').reduce((value, part) => (value << 8n) | BigInt(Number(part)), 0n);
  const [head, tail = ''] = ip.split('::'), left = head ? head.split(':') : [], right = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return groups.reduce((value, group) => (value << 16n) | BigInt(parseInt(group || '0', 16)), 0n);
}
