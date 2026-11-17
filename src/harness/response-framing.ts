// Some Responses providers label an SSE body as JSON. Inspect only its prefix,
// then replay every byte; never buffer a whole model response or guess from the
// request's stream flag (providers can legitimately answer with a JSON object).
export async function normalizeResponseFraming(response: Response): Promise<Response> {
  if (!response.ok || !response.body || response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) return response;
  const reader = response.body.getReader();
  const prefix: Uint8Array[] = [];
  let bytes = 0, ended = false, sse = false;
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (bytes < 1024) {
      const next = await reader.read();
      if (next.done) { ended = true; break; }
      prefix.push(next.value);
      const remaining = 1024 - bytes;
      bytes += next.value.byteLength;
      text += decoder.decode(next.value.subarray(0, remaining), { stream: true });
      const start = text.trimStart();
      if (!start) continue;
      if (/^(?:event:|data:|id:|retry:|:)/.test(start)) { sse = true; break; }
      if (!['event:', 'data:', 'id:', 'retry:', ':'].some(field => field.startsWith(start))) break;
    }
  } catch (error) {
    reader.releaseLock();
    throw error;
  }
  const headers = new Headers(response.headers);
  if (sse) headers.set('content-type', 'text/event-stream; charset=utf-8');
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < prefix.length) { controller.enqueue(prefix[index++]!); return; }
      if (ended) { controller.close(); reader.releaseLock(); return; }
      try {
        const next = await reader.read();
        if (next.done) { ended = true; controller.close(); reader.releaseLock(); }
        else controller.enqueue(next.value);
      } catch (error) { controller.error(error); reader.releaseLock(); }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { reader.releaseLock(); } },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
