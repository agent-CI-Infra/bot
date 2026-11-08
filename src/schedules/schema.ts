import { obj, str } from '../management/catalog-base.js';
import { eventTypes } from './types.js';

const integer = { type: 'integer', minimum: 0 }, bool = { type: 'boolean' };
export const limitsSchema = obj({ concurrency: { ...integer, minimum: 1, maximum: 100 }, runtime_ms: { ...integer, minimum: 1, maximum: 3600000 },
  runs: integer, model_calls: integer, cost_micros: integer, retries: { ...integer, maximum: 10 }, manual_retries: { ...integer, maximum: 5 }, notifications_per_minute: { ...integer, maximum: 1000 } },
  ['concurrency', 'runtime_ms', 'runs', 'model_calls', 'cost_micros', 'retries', 'manual_retries', 'notifications_per_minute']);
export const planSchema = obj({ name: str, kind: { type: 'string', enum: ['personal', 'project'] }, actor_id: str, owner_id: str, maintainer_id: str,
  workflow: str, parameters: { type: 'object' }, timezone: str, cron: { ...str, maxLength: 100 }, interval_ms: { ...integer, minimum: 60000, maximum: 31536000000 },
  start_at: integer, end_at: integer, enabled: bool, misfire: { type: 'string', enum: ['skip', 'once'] }, grace_ms: { ...integer, maximum: 86400000 },
  destination_id: str, limits: limitsSchema }, ['name', 'kind', 'actor_id', 'owner_id', 'maintainer_id', 'workflow', 'parameters', 'timezone', 'start_at', 'enabled', 'misfire', 'grace_ms', 'destination_id', 'limits']);
export const subscriptionSchema = obj({ name: str, destination_id: str, events: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', enum: eventTypes } },
  projects: { type: 'array', minItems: 1, maxItems: 100, items: str }, aggregate_ms: { ...integer, maximum: 86400000 }, timezone: str,
  quiet_start: str, quiet_end: str, enabled: bool }, ['name', 'destination_id', 'events', 'projects', 'aggregate_ms', 'timezone', 'enabled']);
export const schedulingCommands = {
  'schedule.register': { capability: 'schedules.manage', arguments: obj({ plan: planSchema }, ['plan']), description: '保存持久化个人或项目服务计划，返回解析时区及下次触发。' },
  'schedule.update': { capability: 'schedules.manage', arguments: obj({ id: str, revision: integer, plan: planSchema }, ['id', 'revision', 'plan']), description: '按版本修改计划；已有实例保留原始快照。' },
  ...Object.fromEntries(['pause', 'resume', 'delete', 'run-now'].map(action => ['schedule.' + action, { capability: 'schedules.manage', arguments: obj({ id: str, revision: integer }, ['id', 'revision']), description: '显式' + action + '持久化计划。' }])),
  'notification.register': { capability: 'schedules.manage', arguments: obj({ subscription: subscriptionSchema }, ['subscription']), description: '保存可解除的事件订阅及受控目的地。' },
  'subscription.update': { capability: 'schedules.manage', arguments: obj({ id: str, revision: integer, subscription: subscriptionSchema }, ['id', 'revision', 'subscription']), description: '按版本修改订阅，旧待发送消息失效。' },
  ...Object.fromEntries(['pause', 'resume', 'delete'].map(action => ['subscription.' + action, { capability: 'schedules.manage', arguments: obj({ id: str, revision: integer }, ['id', 'revision']), description: '显式' + action + '事件订阅。' }])),
  'notification.retry': { capability: 'schedules.manage', arguments: obj({ id: str, acknowledge_unknown: bool }, ['id']), description: '人工重试死信；结果未知需要显式接受可能重复送达，仍复用逻辑幂等键。' },
};
