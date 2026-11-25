import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IMAGE_REQUEST_LIMIT,
  MAX_IMAGES_IN_CONTEXT,
  analyzeModelPayload,
  enforceSessionImageBudget,
  extractToolContentBlocks,
  imageBlockKey,
  isImageOrPayloadRejection,
  sanitizeAgentPollTrajectory,
  sanitizeImageEvents,
} from '../../../runner/image-budget.mjs';
import { validateCall } from '../../../manager/project-runner-calls.mjs';
import { sanitizeTrajectoryInput, sanitizeTrajectoryResult } from '../../../manager/projects.mjs';

const sampleBase64 = Buffer.from('fake-png-bytes-1234567890').toString('base64');

test('sanitizeImageEvents removes raw base64 across image blocks and data URLs while preserving metadata', () => {
  const input = {
    type: 'tool',
    name: 'view_message_image',
    result: {
      resource_id: 'res_abc',
      content: [
        { type: 'text', text: '{"resource_id":"res_abc"}' },
        { type: 'image', data: sampleBase64, mimeType: 'image/png' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: sampleBase64 } },
        { type: 'image_url', image_url: { url: `data:image/webp;base64,${sampleBase64}` } },
        { type: 'input_image', image_url: `data:image/gif;base64,${sampleBase64}` },
      ],
      rawUrl: `data:image/png;base64,${sampleBase64}`,
    },
  };
  const sanitized = sanitizeImageEvents(input);
  const serialized = JSON.stringify(sanitized);
  assert.ok(!serialized.includes(sampleBase64), 'no raw base64 must remain in sanitized event');
  assert.equal(sanitized.result.resource_id, 'res_abc');
  assert.equal(sanitized.result.content[1].omitted, true);
  assert.equal(sanitized.result.content[1].mimeType, 'image/png');
  assert.equal(sanitized.result.content[1].bytes, Buffer.from('fake-png-bytes-1234567890').length);
  assert.equal(sanitized.result.content[2].source.omitted, true);
  assert.match(sanitized.result.content[3].image_url.url, /image omitted/);
  assert.match(sanitized.result.content[4].image_url, /image omitted/);
  assert.match(sanitized.result.rawUrl, /image omitted/);
});

test('sanitizeAgentPollTrajectory scrubs inline base64 from parsed object and string request bodies without mutating input', () => {
  const objectPoll = {
    state: 'running',
    request: {
      id: 'a'.repeat(48),
      body: {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'check image' },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${sampleBase64}` } },
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: sampleBase64 } },
            ],
          },
        ],
      },
    },
    events: [{ type: 'tool_end', content: [{ type: 'image', data: sampleBase64, mimeType: 'image/png' }] }],
  };
  const sanitizedObject = sanitizeAgentPollTrajectory(objectPoll);
  assert.ok(!JSON.stringify(sanitizedObject).includes(sampleBase64), 'parsed object request.body must have base64 scrubbed');
  assert.ok(JSON.stringify(objectPoll).includes(sampleBase64), 'original in-memory poll result must remain intact for forwarding');

  const stringPoll = {
    state: 'running',
    request: {
      id: 'b'.repeat(48),
      body: JSON.stringify({
        input: [{ type: 'function_call_output', output: [{ type: 'input_image', image_url: `data:image/webp;base64,${sampleBase64}` }] }],
      }),
    },
  };
  const sanitizedString = sanitizeAgentPollTrajectory(stringPoll);
  assert.ok(!JSON.stringify(sanitizedString).includes(sampleBase64), 'JSON string request.body must have base64 scrubbed');
});

test('manager validateCall rejects removed file-mailbox model relay operations', () => {
  for (const type of ['workspace_agent_request', 'workspace_agent_reply', 'workspace_agent_progress', 'workspace_agent_model_request', 'workspace_agent_model_reply']) {
    assert.throws(() => validateCall({
      type,
      request_id: 'a'.repeat(48),
      offset: 0,
      workspace_id: 'b'.repeat(48),
    }), /invalid_runner_request/, type);
  }
});

test('manager trajectory sanitizers keep inline image base64 and tool payloads off manager trajectories', () => {
  const pollResult = {
    state: 'running',
    events: [{ type: 'tool_end', content: [{ type: 'image', data: sampleBase64, mimeType: 'image/png' }] }],
  };
  const cleanPoll = sanitizeTrajectoryResult('workspace_agent_poll', pollResult);
  assert.ok(!JSON.stringify(cleanPoll).includes(sampleBase64), 'workspace_agent_poll trajectory must scrub image base64');
  assert.ok(JSON.stringify(pollResult).includes(sampleBase64), 'in-memory poll result must remain intact');

  const cleanHarnessPoll = sanitizeTrajectoryResult('workspace_harness_poll', pollResult);
  assert.ok(!JSON.stringify(cleanHarnessPoll).includes(sampleBase64), 'workspace_harness_poll trajectory must scrub image base64');

  const cleanToolInput = sanitizeTrajectoryInput({
    operation_id: 'op1',
    request: { type: 'workspace_agent_tool', request_id: 'c'.repeat(48), offset: 0, final: true, base64: sampleBase64 },
  });
  assert.equal(cleanToolInput.request.base64, '[redacted]');
  assert.ok(!JSON.stringify(cleanToolInput).includes(sampleBase64));
});

test('analyzeModelPayload separates text bytes from inline image payloads across Chat, Responses and Anthropic formats', () => {
  // 4.5 MiB raw -> ~6 MiB base64 payload (well above 2 MiB text ceiling, well below 20 MiB image ceiling).
  const bigBase64 = Buffer.alloc(4.5 * 1024 * 1024, 0x41).toString('base64');

  const chatBody = {
    model: 'vision-chat',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Inspect this image' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${bigBase64}` } }] },
    ],
  };
  const chatAnalysis = analyzeModelPayload(chatBody);
  assert.equal(chatAnalysis.imageCount, 1);
  assert.ok(chatAnalysis.totalBytes > 6 * 1024 * 1024);
  assert.ok(chatAnalysis.textBytes < 1024, `expected small textBytes, got ${chatAnalysis.textBytes}`);

  const responsesBody = {
    model: 'gpt-5-codex',
    input: [
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: [
          { type: 'input_text', text: '{"resource_id":"res_1"}' },
          { type: 'input_image', image_url: `data:image/png;base64,${bigBase64}` },
        ],
      },
    ],
  };
  const respAnalysis = analyzeModelPayload(responsesBody);
  assert.equal(respAnalysis.imageCount, 1);
  assert.ok(respAnalysis.textBytes < 1024);

  const anthropicBody = {
    model: 'claude-sonnet-4-5',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: [
              { type: 'text', text: '{"path":"~/chart.png"}' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: bigBase64 } },
            ],
          },
        ],
      },
    ],
  };
  const anthAnalysis = analyzeModelPayload(anthropicBody);
  assert.equal(anthAnalysis.imageCount, 1);
  assert.ok(anthAnalysis.textBytes < 1024);
});

test('enforceSessionImageBudget drops older images first, then oversized current images with safe recovery guidance', () => {
  const mkData = bytes => 'A'.repeat(bytes);
  const olderTool = {
    role: 'toolResult',
    toolCallId: 'old_call',
    content: [
      { type: 'text', text: JSON.stringify({ resource_id: 'res_old', name: 'old.png', mime: 'image/png', size: 1000 }) },
      { type: 'image', data: mkData(40_000), mimeType: 'image/png' },
    ],
  };
  const assistant = { role: 'assistant', content: [{ type: 'text', text: 'Next' }] };
  const smallCurrent = {
    role: 'toolResult',
    toolCallId: 'cur_small',
    content: [
      { type: 'text', text: JSON.stringify({ path: '~/small.png', name: 'small.png', mime: 'image/png', size: 500 }) },
      { type: 'image', data: mkData(10_000), mimeType: 'image/png' },
    ],
  };
  const hugeCurrent = {
    role: 'toolResult',
    toolCallId: 'cur_huge',
    content: [
      { type: 'text', text: JSON.stringify({ resource_id: 'res_huge', name: 'huge.png', mime: 'image/png', size: 90_000 }) },
      { type: 'image', data: mkData(90_000), mimeType: 'image/png' },
    ],
  };

  // Budget allows smallCurrent (~10 KB + overhead) but forces dropping olderTool first and hugeCurrent next.
  const res = enforceSessionImageBudget([olderTool, assistant, smallCurrent, hugeCurrent], { maxTotalBytes: 35_000 });
  assert.equal(res.activeImages.length, 1);
  assert.equal(res.strippedCount, 2);
  assert.equal(res.messages[0].content[1].type, 'text');
  assert.match(res.messages[0].content[1].text, /Previously viewed image omitted/);
  assert.equal(res.messages[2].content[1].type, 'image');
  assert.equal(res.messages[3].content[1].type, 'text');
  assert.match(res.messages[3].content[1].text, /res_huge/);
  assert.match(res.messages[3].content[1].text, /import_message_resource/);
  assert.match(res.messages[3].content[1].text, /Pillow|ImageMagick/);

  // Oversized single image (simulating Pi normalizeToolResultImages passthrough on resize failure) with unsafe host path never leaks host path.
  const hostPathMsg = {
    role: 'toolResult',
    toolCallId: 'giant_passthrough',
    content: [
      { type: 'text', text: JSON.stringify({ path: '/home/host-secret/private.png', name: 'private.png' }) },
      { type: 'image', data: mkData(120_000), mimeType: 'image/png' },
    ],
  };
  const giantRes = enforceSessionImageBudget([hostPathMsg], { maxTotalBytes: 40_000 });
  assert.equal(giantRes.activeImages.length, 0);
  assert.equal(giantRes.messages[0].content[1].type, 'text');
  assert.ok(!giantRes.messages[0].content[1].text.includes('/home/host-secret/'), 'host path must not leak into recovery notice');

  // Previously rejected images are stripped deterministically with the upstream reason.
  const imgBlock = smallCurrent.content[1];
  const key = imageBlockKey(smallCurrent, 0, 1, imgBlock);
  const rejected = new Map([[key, '413 Request Entity Too Large']]);
  const afterReject = enforceSessionImageBudget([smallCurrent], { maxTotalBytes: IMAGE_REQUEST_LIMIT, rejected });
  assert.equal(afterReject.activeImages.length, 0);
  assert.equal(afterReject.messages[0].content[1].type, 'text');
  assert.match(afterReject.messages[0].content[1].text, /413 Request Entity Too Large/);
  assert.match(afterReject.messages[0].content[1].text, /~\/small\.png/);

  // Multi-image count cap (> MAX_IMAGES_IN_CONTEXT).
  const many = Array.from({ length: MAX_IMAGES_IN_CONTEXT + 2 }, (_, idx) => ({
    role: 'toolResult',
    toolCallId: `img_${idx}`,
    content: [{ type: 'text', text: JSON.stringify({ path: `/tmp/img_${idx}.png` }) }, { type: 'image', data: mkData(100 + idx), mimeType: 'image/png' }],
  }));
  const capped = enforceSessionImageBudget(many, { maxTotalBytes: IMAGE_REQUEST_LIMIT });
  assert.equal(capped.activeImages.length, MAX_IMAGES_IN_CONTEXT);
  assert.equal(capped.strippedCount, 2);
});

test('isImageOrPayloadRejection and extractToolContentBlocks handle rejection patterns and multimodal envelopes', () => {
  assert.equal(isImageOrPayloadRejection('413 Request Entity Too Large'), true);
  assert.equal(isImageOrPayloadRejection('model_http_413: payload too large'), true);
  assert.equal(isImageOrPayloadRejection('400 This model does not support image inputs'), true);
  assert.equal(isImageOrPayloadRejection('invalid_image: image exceeds 5 MB maximum'), true);
  assert.equal(isImageOrPayloadRejection('401 authentication_failed'), false);

  const mcpEnvelope = extractToolContentBlocks({
    __bot_tool_content: true,
    observation: { resource_id: 'r1', image_input: 'next_model_request' },
    content: [
      { type: 'text', text: '{"resource_id":"r1"}' },
      { type: 'image', data: sampleBase64, mimeType: 'image/png' },
    ],
    isError: false,
  });
  assert.deepEqual(mcpEnvelope.observation, { resource_id: 'r1', image_input: 'next_model_request' });
  assert.equal(mcpEnvelope.images.length, 1);
  assert.equal(mcpEnvelope.images[0].data, sampleBase64);

  const piEnvelope = extractToolContentBlocks({
    result: { path: '~/img.png', image_input: 'next_model_request' },
    images: [{ type: 'image', data: sampleBase64, mimeType: 'image/jpeg' }],
  });
  assert.deepEqual(piEnvelope.observation, { path: '~/img.png', image_input: 'next_model_request' });
  assert.equal(piEnvelope.images.length, 1);
  assert.equal(piEnvelope.images[0].mimeType, 'image/jpeg');
});
