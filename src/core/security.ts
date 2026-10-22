import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export const randomId = () => randomBytes(24).toString('hex');
export const digest = (text: string) => createHash('sha256').update(text).digest('hex');

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export const fail = (status: number, code: string): never => { throw new HttpError(status, code); };
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
}
