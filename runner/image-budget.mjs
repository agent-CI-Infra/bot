export const TEXT_REQUEST_LIMIT = 2 * 1024 * 1024;
export const IMAGE_REQUEST_LIMIT = 20 * 1024 * 1024;
export const MAX_IMAGES_IN_CONTEXT = 8;
export const IMAGE_TOKEN_ESTIMATE = 1600;

const DATA_IMAGE_RE = /^data:image\/([a-z0-9.+-]+);base64,(.+)$/is;

function approxBase64Bytes(base64) {
  if (typeof base64 !== 'string' || !base64.length) return 0;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/**
 * Recursively removes raw base64 image data before writing runner events or receipts to disk.
 */
export function sanitizeImageEvents(value, depth = 0) {
  if (depth > 16 || value === null || value === undefined) return value;
  if (typeof value === 'string') {
    const match = DATA_IMAGE_RE.exec(value);
    if (match) return `[image omitted: image/${match[1].toLowerCase()}, ${approxBase64Bytes(match[2])} bytes]`;
    return value;
  }
  if (Array.isArray(value)) return value.map(item => sanitizeImageEvents(item, depth + 1));
  if (typeof value !== 'object') return value;

  if (value.type === 'image' && typeof value.data === 'string') {
    return {
      type: 'image',
      mimeType: typeof value.mimeType === 'string' ? value.mimeType : typeof value.media_type === 'string' ? value.media_type : 'image/unknown',
      bytes: approxBase64Bytes(value.data),
      omitted: true,
    };
  }
  if (value.type === 'image' && value.source && typeof value.source === 'object' && value.source.type === 'base64' && typeof value.source.data === 'string') {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: typeof value.source.media_type === 'string' ? value.source.media_type : 'image/unknown',
        bytes: approxBase64Bytes(value.source.data),
        omitted: true,
      },
    };
  }
  if (value.type === 'image_url' && typeof value.image_url?.url === 'string' && DATA_IMAGE_RE.test(value.image_url.url)) {
    const match = DATA_IMAGE_RE.exec(value.image_url.url);
    return {
      type: 'image_url',
      image_url: { url: `[image omitted: image/${match[1].toLowerCase()}, ${approxBase64Bytes(match[2])} bytes]` },
    };
  }
  if (value.type === 'input_image' && typeof value.image_url === 'string' && DATA_IMAGE_RE.test(value.image_url)) {
    const match = DATA_IMAGE_RE.exec(value.image_url);
    return {
      type: 'input_image',
      image_url: `[image omitted: image/${match[1].toLowerCase()}, ${approxBase64Bytes(match[2])} bytes]`,
    };
  }

  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = sanitizeImageEvents(v, depth + 1);
  return out;
}

/**
 * Strips raw base64 image payloads from workspace_agent_poll results before persisting to task_tools / trajectories.
 */
function scrubSerializedBody(body) {
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body);
      const { imageCount } = analyzeModelPayload(parsed, Buffer.byteLength(body, 'utf8'));
      if (imageCount > 0) return JSON.stringify(sanitizeImageEvents(parsed));
      return body;
    } catch {
      return sanitizeImageEvents(body);
    }
  }
  if (body && typeof body === 'object') {
    const { imageCount } = analyzeModelPayload(body);
    if (imageCount > 0) return sanitizeImageEvents(body);
  }
  return body;
}

export function sanitizeAgentPollTrajectory(result) {
  if (!result || typeof result !== 'object') return result;
  const out = { ...result };
  if (out.request && typeof out.request === 'object' && 'body' in out.request) {
    out.request = { ...out.request, body: scrubSerializedBody(out.request.body) };
  }
  if (Array.isArray(out.model_requests)) {
    out.model_requests = out.model_requests.map(item => {
      if (!item || typeof item !== 'object' || item.data === undefined) return item;
      if (typeof item.data === 'string') return { ...item, data: scrubSerializedBody(item.data) };
      if (item.data && typeof item.data === 'object') {
        const nextData = 'body' in item.data ? { ...item.data, body: scrubSerializedBody(item.data.body) } : sanitizeImageEvents(item.data);
        return { ...item, data: nextData };
      }
      return item;
    });
  }
  if (Array.isArray(out.events)) out.events = sanitizeImageEvents(out.events);
  return out;
}

/**
 * Separates inline base64 image payloads from text payloads across OpenAI Chat, OpenAI Responses,
 * and Anthropic Messages request bodies so text byte/token budgets are never inflated by base64.
 */
export function analyzeModelPayload(parsed, rawBytes) {
  let imageCount = 0;
  let imageBytes = 0;

  const stripPart = part => {
    if (!part || typeof part !== 'object') return part;
    if (part.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      if (typeof url === 'string' && DATA_IMAGE_RE.test(url)) {
        imageCount++;
        imageBytes += Buffer.byteLength(url, 'utf8');
        return typeof part.image_url === 'string'
          ? { ...part, image_url: '[image]' }
          : { ...part, image_url: { ...part.image_url, url: '[image]' } };
      }
      return part;
    }
    if (part.type === 'input_image' && typeof part.image_url === 'string' && DATA_IMAGE_RE.test(part.image_url)) {
      imageCount++;
      imageBytes += Buffer.byteLength(part.image_url, 'utf8');
      return { ...part, image_url: '[image]' };
    }
    if (part.type === 'image' && part.source && typeof part.source === 'object' && part.source.type === 'base64' && typeof part.source.data === 'string') {
      imageCount++;
      imageBytes += Buffer.byteLength(part.source.data, 'utf8');
      return { ...part, source: { ...part.source, data: '[image]' } };
    }
    if (part.type === 'image' && typeof part.data === 'string') {
      imageCount++;
      imageBytes += Buffer.byteLength(part.data, 'utf8');
      return { ...part, data: '[image]' };
    }
    if (part.type === 'tool_result' && Array.isArray(part.content)) {
      return { ...part, content: part.content.map(stripPart) };
    }
    return part;
  };

  const stripMessage = item => {
    if (!item || typeof item !== 'object') return item;
    if (Array.isArray(item.content)) return { ...item, content: item.content.map(stripPart) };
    if ((item.type === 'function_call_output' || item.type === 'custom_tool_call_output') && Array.isArray(item.output)) {
      return { ...item, output: item.output.map(stripPart) };
    }
    return item;
  };

  let stripped = parsed;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const next = { ...parsed };
    if (Array.isArray(parsed.messages)) next.messages = parsed.messages.map(stripMessage);
    if (Array.isArray(parsed.input)) next.input = parsed.input.map(stripMessage);
    stripped = next;
  }

  const strippedJson = imageCount > 0 ? JSON.stringify(stripped) : null;
  const totalBytes = Number.isSafeInteger(rawBytes) ? rawBytes : Buffer.byteLength(JSON.stringify(parsed), 'utf8');
  const textBytes = strippedJson !== null ? Buffer.byteLength(strippedJson, 'utf8') : totalBytes;
  return { totalBytes, textBytes, imageCount, imageBytes, strippedJson };
}

function isSafeDisplayPath(path) {
  if (typeof path !== 'string' || !path || path.length > 1024 || path.includes('\0')) return false;
  if (path.startsWith('~/') || path.startsWith('/tmp/') || path.startsWith('/home/assistant/')) return true;
  if (!path.startsWith('/') && !path.split('/').includes('..')) return true;
  return false;
}

export function extractImageRef(content) {
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    try {
      const parsed = JSON.parse(block.text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const ref = {};
        if (typeof parsed.resource_id === 'string' && parsed.resource_id) ref.resource_id = parsed.resource_id;
        if (typeof parsed.path === 'string' && isSafeDisplayPath(parsed.path)) ref.path = parsed.path;
        if (typeof parsed.name === 'string' && parsed.name) ref.name = parsed.name;
        if (typeof parsed.mime === 'string' && parsed.mime) ref.mime = parsed.mime;
        if (typeof parsed.size === 'number' && Number.isFinite(parsed.size)) ref.size = parsed.size;
        if (ref.resource_id || ref.path) return ref;
      }
    } catch {
      // Non-JSON text block (for example Pi's built-in read tool output).
    }
  }
  return null;
}

export function formatPiImageRecoveryNotice(reason, ref) {
  const summaryParts = [];
  if (ref?.resource_id) summaryParts.push(`resource_id=${ref.resource_id}`);
  if (ref?.path) summaryParts.push(`path=${ref.path}`);
  if (ref?.name) summaryParts.push(`name=${ref.name}`);
  if (ref?.mime) summaryParts.push(`mime=${ref.mime}`);
  if (typeof ref?.size === 'number') summaryParts.push(`size=${ref.size} bytes`);
  const summary = summaryParts.length ? `Omitted image: ${summaryParts.join(', ')}\n` : '';
  let nextStep;
  if (ref?.resource_id) {
    nextStep = `Next step: Use import_message_resource with resource_id="${ref.resource_id}" (for example to /tmp/image-input), resize, compress, crop or convert it on your assistant computer using Python Pillow (PIL.Image) or ImageMagick (convert/identify), and inspect the processed file with view_workspace_image. If the provider error says this model does not accept image input at all, do not retry sending images; explain this clearly to the user instead.`;
  } else if (ref?.path) {
    nextStep = `Next step: Process "${ref.path}" on your computer using Python Pillow (PIL.Image) or ImageMagick (convert/identify) to reduce dimensions, lower quality, crop a target region or convert format, and re-inspect the smaller file. If the provider error says this model does not accept image input at all, do not retry sending images; explain this clearly to the user instead.`;
  } else {
    nextStep = 'Next step: Resize, compress, crop or convert the image on your computer using Python Pillow (PIL.Image) or ImageMagick (convert/identify) and inspect the smaller file, or inspect fewer images per request. If the provider error says this model does not accept image input at all, do not retry sending images; explain this clearly to the user instead.';
  }
  return `[Image input omitted from this model request]\nReason: ${reason}\n${summary}${nextStep}\nDo not claim to have inspected any omitted image.`;
}

export function imageBlockKey(msg, msgIndex, blockIndex, block) {
  const anchor = typeof msg?.toolCallId === 'string' && msg.toolCallId
    ? `tool:${msg.toolCallId}`
    : typeof msg?.timestamp === 'number'
      ? `ts:${msg.timestamp}:${msgIndex}`
      : `idx:${msgIndex}`;
  const data = typeof block?.data === 'string' ? block.data : '';
  const fingerprint = `${data.length}:${data.slice(0, 16)}:${data.slice(-16)}`;
  return `${anchor}:${blockIndex}:${block?.mimeType ?? ''}:${fingerprint}`;
}

/**
 * Preflight image context budget and rejected-image filter for Pi sessions (both direct and gateway).
 * - Strips images previously rejected by the upstream provider, leaving actionable recovery guidance.
 * - Guards against Pi's normalizeToolResultImages passing through raw oversized images on resize failure
 *   and against multi-image accumulation exceeding the 20 MiB request ceiling or max image count.
 */
export function enforceSessionImageBudget(messages, options = {}) {
  const maxTotalBytes = options.maxTotalBytes ?? IMAGE_REQUEST_LIMIT;
  const maxImages = options.maxImages ?? MAX_IMAGES_IN_CONTEXT;
  const rejected = options.rejected instanceof Map ? options.rejected : new Map();

  if (!Array.isArray(messages) || !messages.length) {
    return { messages, activeImages: [], strippedCount: 0 };
  }

  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') {
      lastAssistantIdx = i;
      break;
    }
  }

  let strippedCount = 0;
  const cloned = messages.map((msg, msgIndex) => {
    if (!msg || !Array.isArray(msg.content) || !msg.content.some(b => b?.type === 'image')) return msg;
    const ref = extractImageRef(msg.content);
    let changed = false;
    const content = msg.content.map((block, blockIndex) => {
      if (block?.type !== 'image' || typeof block.data !== 'string') return block;
      const key = imageBlockKey(msg, msgIndex, blockIndex, block);
      if (rejected.has(key)) {
        changed = true;
        strippedCount++;
        return { type: 'text', text: formatPiImageRecoveryNotice(rejected.get(key), ref) };
      }
      return block;
    });
    return changed ? { ...msg, content } : msg;
  });

  const collectEntries = () => {
    const entries = [];
    for (let msgIndex = 0; msgIndex < cloned.length; msgIndex++) {
      const msg = cloned[msgIndex];
      if (!msg || !Array.isArray(msg.content)) continue;
      for (let blockIndex = 0; blockIndex < msg.content.length; blockIndex++) {
        const block = msg.content[blockIndex];
        if (block?.type === 'image' && typeof block.data === 'string') {
          entries.push({
            msgIndex,
            blockIndex,
            older: msgIndex < lastAssistantIdx,
            bytes: Buffer.byteLength(block.data, 'utf8'),
            key: imageBlockKey(msg, msgIndex, blockIndex, block),
          });
        }
      }
    }
    return entries;
  };

  let entries = collectEntries();
  if (!entries.length) {
    return { messages: cloned, activeImages: [], strippedCount };
  }

  const measureTotalBytes = () => {
    // Account for data URL prefix overhead (~32 bytes per image) and request JSON wrapper overhead.
    return Buffer.byteLength(JSON.stringify(cloned), 'utf8') + entries.length * 64 + 8192;
  };

  const replaceEntry = (entry, text) => {
    const msg = cloned[entry.msgIndex];
    const nextContent = [...msg.content];
    nextContent[entry.blockIndex] = { type: 'text', text };
    cloned[entry.msgIndex] = { ...msg, content: nextContent };
    strippedCount++;
  };

  // First drop older turns' images (oldest first) when over budget or image count.
  while (entries.length > 0 && (entries.length > maxImages || measureTotalBytes() > maxTotalBytes)) {
    const olderIdx = entries.findIndex(e => e.older);
    if (olderIdx < 0) break;
    const [victim] = entries.splice(olderIdx, 1);
    replaceEntry(victim, '[Previously viewed image omitted to stay within the model request image budget; re-inspect it if needed.]');
  }

  // Next drop the largest remaining image(s) from the current turn (covers multi-image accumulation
  // and oversized images passed through raw when Pi image normalization/resize failed).
  while (entries.length > 0 && (entries.length > maxImages || measureTotalBytes() > maxTotalBytes)) {
    let largestIdx = 0;
    for (let i = 1; i < entries.length; i++) {
      if (entries[i].bytes > entries[largestIdx].bytes) largestIdx = i;
    }
    const [victim] = entries.splice(largestIdx, 1);
    const ref = extractImageRef(cloned[victim.msgIndex].content);
    const reason = entries.length + 1 > maxImages
      ? `Inline image count exceeded the maximum of ${maxImages} images per model request.`
      : `Model request payload exceeded the ${Math.round(maxTotalBytes / (1024 * 1024))} MiB image request limit (${maxTotalBytes} bytes), including inline image data.`;
    replaceEntry(victim, formatPiImageRecoveryNotice(reason, ref));
  }

  return {
    messages: cloned,
    activeImages: entries.map(e => e.key),
    strippedCount,
  };
}

const IMAGE_OR_PAYLOAD_REJECTION_RE = /(?:http\s*413|\b413\b|request[_ ]too[_ ]large|payload too large|entity too large|content too large|model_request_invalid|model_http_(?:400|413|415|422)|invalid_image|unsupported[_ ]image|image.*(?:too large|exceed|unsupported|invalid|not supported|not allowed|rejected|decode|corrupt|dimensions|pixels|size)|(?:does not|doesn't|cannot|can't)\s+(?:support|accept|process)\s+image|vision.*not supported|multimodal.*not supported|could not process image)/i;

export function isImageOrPayloadRejection(errorMessage) {
  return typeof errorMessage === 'string' && IMAGE_OR_PAYLOAD_REJECTION_RE.test(errorMessage);
}

/**
 * Extracts clean JSON observation plus any attached standard `{ type: 'image', data, mimeType }` blocks
 * from a mailbox tool reply.
 */
export function extractToolContentBlocks(reply) {
  if (reply && typeof reply === 'object' && !Array.isArray(reply)) {
    if (reply.__bot_tool_content === true && Array.isArray(reply.content)) {
      const images = [];
      for (const block of reply.content) {
        if (block?.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
          images.push({ type: 'image', data: block.data, mimeType: block.mimeType });
        }
      }
      const observation = 'observation' in reply ? reply.observation : null;
      return {
        observation,
        images,
        isError: typeof reply.isError === 'boolean'
          ? reply.isError
          : Boolean(observation && typeof observation === 'object' && observation.error),
      };
    }
    if (Array.isArray(reply.images)) {
      const images = reply.images
        .filter(block => block?.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string')
        .map(block => ({ type: 'image', data: block.data, mimeType: block.mimeType }));
      const observation = 'result' in reply ? reply.result : reply;
      return {
        observation,
        images,
        isError: Boolean(observation && typeof observation === 'object' && observation.error),
      };
    }
  }
  return {
    observation: reply,
    images: [],
    isError: Boolean(reply && typeof reply === 'object' && reply.error),
  };
}
