import { object, type Json } from '../core/security.js';
import { cardText, postText, summarizePayload, systemMessageText } from './format.js';
import type { ChannelMention } from './types.js';

export function messageMentions(value: unknown, bot: string, botName = ''): ChannelMention[] {
  if (!Array.isArray(value)) return [];
  return value.filter(m => m && typeof m === 'object').map(m => {
    // Events carry id.open_id; history pages carry id with an explicit id_type.
    const actor = typeof m.id?.open_id === 'string' ? m.id.open_id : m.id_type === 'open_id' && typeof m.id === 'string' ? m.id : '';
    const self = !!actor && actor === bot, name = typeof m.name === 'string' ? m.name.trim().slice(0, 200) : '';
    return { key: typeof m.key === 'string' ? m.key : '', actor_id: actor, name: name || (self ? botName : '') || actor || '用户', is_self: self };
  });
}

function tryParseObject(raw: string): Json | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Json : null;
  } catch { return null; }
}

function formatDuration(value: unknown): string {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return `（${Math.max(1, Math.round(ms / 1000))}秒）`;
}

export function messageText(type: string, raw: string, mentions: ChannelMention[] = [], omitSelf = false): string {
  const at = (ref: string, name = '') => {
    const mention = ref ? mentions.find(m => m.key === ref || m.actor_id === ref) : undefined;
    return omitSelf && mention?.is_self ? '' : '@' + (mention?.name || name || ref || '用户');
  };
  const keys = [...new Set(mentions.map(m => m.key).filter(Boolean))].sort((a, b) => b.length - a.length);
  // Replace once, so a display name containing another placeholder cannot turn into a different mention.
  const pattern = keys.length ? new RegExp('(?:' + keys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'g') : null;
  const render = (value: string) => pattern ? value.replace(pattern, ref => at(ref)) : value;

  if (['text', 'post', 'image', 'file', 'audio', 'media'].includes(type)) {
    const data = object(JSON.parse(raw));
    if (type === 'text') return render(String(data.text ?? ''));
    if (type === 'image') return '[图片附件]';
    if (type === 'file') return '[附件：' + String(data.file_name ?? 'file') + ']';
    if (type === 'audio') {
      const name = typeof data.file_name === 'string' && data.file_name.trim() ? `：${data.file_name.trim()}` : '';
      return `[语音附件${name}${formatDuration(data.duration)}]`;
    }
    if (type === 'media') {
      const name = typeof data.file_name === 'string' && data.file_name.trim() ? `：${data.file_name.trim()}` : '';
      return `[视频附件${name}${formatDuration(data.duration)}]`;
    }
    return postText(data, at, render);
  }

  const data = tryParseObject(raw);
  if (type === 'interactive') return data ? cardText(data, at, render) : (raw.trim() ? render(raw.trim()) : '[卡片消息]');
  if (type === 'merge_forward') {
    if (data) {
      const title = typeof data.title === 'string' && data.title.trim() ? render(data.title.trim()) : '';
      const items = Array.isArray(data.messages) ? data.messages : Array.isArray(data.items) ? data.items : null;
      if (items?.length) {
        const lines = items.slice(0, 50).map((item: any) => {
          if (typeof item === 'string') return '- ' + render(item);
          const itemType = typeof item?.msg_type === 'string' ? item.msg_type : typeof item?.message_type === 'string' ? item.message_type : '';
          const body = typeof item?.body?.content === 'string' ? item.body.content : typeof item?.content === 'string' ? item.content : '';
          if (itemType && body) {
            try { return '- ' + messageText(itemType, body, mentions, omitSelf); } catch { /* Fall through to summary. */ }
          }
          const summary = summarizePayload(item, render, 0, 500);
          return summary ? '- ' + summary : '';
        }).filter(Boolean);
        return [`[合并转发消息${title ? '：' + title : ''}]`, ...lines].join('\n');
      }
      const bodyText = typeof data.text === 'string' && data.text.trim() && data.text.trim() !== 'Merged and Forwarded Message' ? render(data.text.trim()) : '';
      return [`[合并转发消息${title ? '：' + title : ''}]`, bodyText].filter(Boolean).join('\n');
    }
    const trimmed = raw.trim();
    return !trimmed || trimmed === 'Merged and Forwarded Message' ? '[合并转发消息]' : `[合并转发消息] ${render(trimmed)}`;
  }
  if (type === 'share_chat') {
    const name = typeof (data?.name ?? data?.chat_name) === 'string' ? render(String(data?.name ?? data?.chat_name).trim()) : '';
    const chatId = typeof data?.chat_id === 'string' ? data.chat_id.trim() : '';
    if (name && chatId) return `[分享群聊：${name}（${chatId}）]`;
    if (name || chatId) return `[分享群聊：${name || chatId}]`;
    return '[分享群聊]';
  }
  if (type === 'share_user') {
    const name = typeof (data?.name ?? data?.user_name) === 'string' ? render(String(data?.name ?? data?.user_name).trim()) : '';
    const userId = typeof (data?.user_id ?? data?.open_id) === 'string' ? String(data?.user_id ?? data?.open_id).trim() : '';
    if (name && userId) return `[分享联系人：${name}（${userId}）]`;
    if (name || userId) return `[分享联系人：${name || userId}]`;
    return '[分享联系人]';
  }
  if (type === 'sticker') {
    const name = typeof (data?.file_name ?? data?.text ?? data?.name) === 'string' ? render(String(data?.file_name ?? data?.text ?? data?.name).trim()) : '';
    return name ? `[表情包：${name}]` : '[表情包]';
  }
  if (type === 'location') {
    const name = typeof data?.name === 'string' ? render(data.name.trim()) : '';
    const address = typeof data?.address === 'string' ? render(data.address.trim()) : '';
    const lat = data?.latitude !== undefined && data?.latitude !== null ? String(data.latitude).trim() : '';
    const lng = data?.longitude !== undefined && data?.longitude !== null ? String(data.longitude).trim() : '';
    const coords = lat && lng ? `（${lat}, ${lng}）` : '';
    const place = [name, address].filter(Boolean).join(' · ');
    return place || coords ? `[位置：${place}${coords}]` : '[位置]';
  }
  if (type === 'system') return data ? systemMessageText(data, render) : (raw.trim() ? `[系统消息] ${render(raw.trim())}` : '[系统消息]');
  if (type === 'hongbao') {
    const label = typeof data?.text === 'string' && data.text.trim() ? render(data.text.trim()) : '';
    return label ? `[红包：${label}]` : '[红包]';
  }
  if (['share_calendar_event', 'calendar', 'general_calendar'].includes(type)) {
    const summary = typeof data?.summary === 'string' && data.summary.trim() ? render(data.summary.trim()) : '';
    const time = [data?.start_time, data?.end_time].filter(v => v !== undefined && v !== null && String(v).trim()).join(' - ');
    const detail = [summary, time].filter(Boolean).join(' ');
    return detail ? `[日程：${detail}]` : '[日程]';
  }
  if (type === 'video_chat') {
    const topic = typeof data?.topic === 'string' && data.topic.trim() ? render(data.topic.trim()) : '';
    return topic ? `[视频会议：${topic}]` : '[视频会议]';
  }
  if (type === 'todo') {
    const summary = summarizePayload(data?.summary ?? data?.title ?? data, render, 0, 1000);
    return summary ? `[任务：${summary}]` : '[任务]';
  }
  if (type === 'vote') {
    const topic = typeof (data?.topic ?? data?.title) === 'string' ? render(String(data?.topic ?? data?.title).trim()) : '';
    const options = Array.isArray(data?.options) ? data.options.map((o: any) => typeof o === 'string' ? render(o) : summarizePayload(o, render, 0, 200)).filter(Boolean) : [];
    const detail = [topic, options.length ? `选项：${options.join(' / ')}` : ''].filter(Boolean).join('；');
    return detail ? `[投票：${detail}]` : '[投票]';
  }
  const summary = data ? summarizePayload(data, render) : raw.trim() ? render(raw.trim()) : '';
  return summary ? `[${type}消息] ${summary}` : `[${type}消息]`;
}
