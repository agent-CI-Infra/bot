import { StringDecoder } from 'node:string_decoder';

export const outputLimit = 1024 * 1024;

// Separate decoders keep UTF-8 and credential prefixes intact across writes to each pipe.
export function maskedStream(secrets, write) {
  const decoder = new StringDecoder('utf8'); let pending = '';
  const flush = final => {
    let held = 0;
    if (!final) for (const secret of secrets) for (let n = 1; n < secret.length; n++)
      if (pending.endsWith(secret.slice(0, n))) held = Math.max(held, n);
    let end = pending.length - held;
    for (const secret of secrets) { const start = pending.lastIndexOf(secret, end - 1); if (start >= 0 && start + secret.length > end) end = start; }
    const text = pending.slice(0, end); pending = pending.slice(end);
    if (text) write(secrets.reduce((value, secret) => value.replaceAll(secret, '[REDACTED]'), text));
  };
  return { data: value => { pending += decoder.write(value); flush(false); }, end: () => { pending += decoder.end(); flush(true); } };
}

// A fixed head and a tail ring keep resident output independent of command duration and volume.
export class CommandOutput {
  bytes = 0;
  head = Buffer.alloc(outputLimit);
  tail = Buffer.alloc(outputLimit / 2);
  cursor = 0;
  append(text) {
    const chunk = Buffer.from(text), before = this.bytes;
    if (before < this.head.length) chunk.copy(this.head, before, 0, this.head.length - before);
    if (chunk.length >= this.tail.length) { chunk.copy(this.tail, 0, chunk.length - this.tail.length); this.cursor = 0; }
    else {
      const first = Math.min(chunk.length, this.tail.length - this.cursor);
      chunk.copy(this.tail, this.cursor, 0, first); chunk.copy(this.tail, 0, first);
      this.cursor = (this.cursor + chunk.length) % this.tail.length;
    }
    this.bytes += chunk.length;
  }
  result() {
    if (this.bytes <= outputLimit) return { output: this.head.subarray(0, this.bytes).toString('utf8'), truncated: false };
    const head = new StringDecoder('utf8').write(this.head.subarray(0, outputLimit / 2));
    const end = Buffer.concat([this.tail.subarray(this.cursor), this.tail.subarray(0, this.cursor)]);
    let start = 0; while (start < 3 && (end[start] & 0xc0) === 0x80) start++;
    const tail = end.subarray(start).toString('utf8');
    return { output: head + `\n[… ${this.bytes - Buffer.byteLength(head) - Buffer.byteLength(tail)} bytes omitted; read the complete result file …]\n` + tail,
      head, tail, output_bytes: this.bytes, truncated: true };
  }
}
