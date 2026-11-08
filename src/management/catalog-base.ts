import type { Json } from '../core/security.js';
export const str = { type: 'string', minLength: 1, maxLength: 60000 };
export const obj = (properties: Json, required: string[] = []): Json => ({ type: 'object', properties, required, additionalProperties: false });
