import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export const randomId = () => randomBytes(24).toString('hex');
export const digest = (text: string) => createHash('sha256').update(text).digest('hex');

export class HttpError extends Error {
  /** field names the configuration path that caused the error, never request contents or credentials. detail carries
   * configuration facts the person needs to fix it (for example the projects a model is not available to). */
  constructor(readonly status: number, readonly code: string, readonly field?: string, readonly detail?: Json) { super(code); }
}
export const fail = (status: number, code: string, field?: string, detail?: Json): never => { throw new HttpError(status, code, field, detail); };
// Plain HTTP may only reach this machine: model keys travel in the request, so anything off this host would leak them.
// Only the parsed hostname is inspected; new URL() already normalises the numeric IPv4 forms (127.1, decimal, hex, octal).
export function loopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '[::1]' || host === '[::ffff:7f00:1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}
export type Json = Record<string, unknown>;
export function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(400, 'expected_object');
  return value as Json;
}
export function fields(value: Json, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(400, 'unknown_field');
}
export function text(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) return fail(400, 'invalid_field');
  return value.trim();
}
export function password(value: unknown): string {
  if (typeof value !== 'string' || value.length < 12 || value.length > 256) return fail(400, 'password_length_12_to_256');
  return value;
}
function derive(value: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(value, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => err ? reject(err) : resolve(key)));
}
export async function hashPassword(value: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$16384$${salt.toString('hex')}$${(await derive(value, salt)).toString('hex')}`;
}
export async function verifyPassword(value: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt' || parts[1] !== '16384') return false;
  const actual = await derive(value, Buffer.from(parts[2]!, 'hex'));
  const expected = Buffer.from(parts[3]!, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function verifySignature(body: Buffer, secret: string, signature: string): boolean {
  if (!secret || !/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
}

/** AAD binds ciphertext to its row, so it cannot be transplanted between accounts or models. */
const binaryMagic = Buffer.from('SBX1');
export class SecretBox {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('invalid encryption key');
  }
  seal(value: unknown, scope: string): string {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(scope));
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map(b => b.toString('base64')).join('.');
  }
  open(value: string, scope: string): Json {
    const [iv, tag, data] = value.split('.').map(v => Buffer.from(v, 'base64'));
    if (!iv || !tag || !data) throw new Error('invalid ciphertext');
    const cipher = createDecipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(scope)); cipher.setAuthTag(tag);
    return object(JSON.parse(Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8')));
  }
  /** Binary AES-256-GCM envelope (magic + 12-byte IV + 16-byte tag + ciphertext) for file-backed attachments. */
  sealBytes(data: Buffer, scope: string): Buffer {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(scope));
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    return Buffer.concat([binaryMagic, iv, cipher.getAuthTag(), encrypted]);
  }
  openBytes(sealed: Buffer, scope: string): Buffer {
    if (sealed.length < 32 || !sealed.subarray(0, 4).equals(binaryMagic)) throw new Error('invalid ciphertext');
    const iv = sealed.subarray(4, 16), tag = sealed.subarray(16, 32), ciphertext = sealed.subarray(32);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAAD(Buffer.from(scope)); decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}
