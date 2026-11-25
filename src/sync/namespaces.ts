import { fail } from '../core/security.js';
import type { SyncNamespaceName, SyncNamespacePolicy } from './types.js';

export const SYNC_NAMESPACE_POLICIES: Readonly<Record<SyncNamespaceName, SyncNamespacePolicy>> = Object.freeze({
  'tool-results': Object.freeze({
    name: 'tool-results',
    containerPath: '/results',
    mode: 'ro',
    immutable: true,
    conflictPolicy: 'reject',
    redact: false,
    redactionPolicy: 'none',
    history: false,
    rejectSensitivePaths: false,
    allowInternalSymlinks: false,
    maxFileBytes: 64 * 1024 * 1024,
    maxBatchBlobs: 256,
    maxBatchBytes: 64 * 1024 * 1024,
  }),
  'project-tools': Object.freeze({
    name: 'project-tools',
    containerPath: '/opt/project-tools',
    mode: 'ro',
    immutable: false,
    conflictPolicy: 'reject',
    redact: false,
    redactionPolicy: 'none',
    history: false,
    rejectSensitivePaths: true,
    allowInternalSymlinks: true,
    maxFileBytes: 256 * 1024 * 1024,
    maxBatchBlobs: 256,
    maxBatchBytes: 64 * 1024 * 1024,
  }),
  'agent-tools': Object.freeze({
    name: 'agent-tools',
    containerPath: '/opt/agent-tools',
    mode: 'ro',
    immutable: false,
    conflictPolicy: 'reject',
    redact: false,
    redactionPolicy: 'none',
    history: false,
    rejectSensitivePaths: false,
    allowInternalSymlinks: true,
    maxFileBytes: 256 * 1024 * 1024,
    maxBatchBlobs: 256,
    maxBatchBytes: 64 * 1024 * 1024,
  }),
  'skill-store': Object.freeze({
    name: 'skill-store',
    containerPath: '/opt/bot-skills',
    mode: 'ro',
    immutable: true,
    conflictPolicy: 'reject',
    redact: false,
    redactionPolicy: 'none',
    history: false,
    rejectSensitivePaths: true,
    allowInternalSymlinks: false,
    maxFileBytes: 8 * 1024 * 1024,
    maxBatchBlobs: 256,
    maxBatchBytes: 32 * 1024 * 1024,
  }),
  'project-notes': Object.freeze({
    name: 'project-notes',
    containerPath: '../notes/',
    mode: 'rw',
    immutable: false,
    conflictPolicy: 'merge_or_conflict_copy',
    redact: true,
    redactionPolicy: 'redact',
    history: true,
    rejectSensitivePaths: true,
    allowInternalSymlinks: false,
    maxFileBytes: 1024 * 1024,
    maxBatchBlobs: 128,
    maxBatchBytes: 16 * 1024 * 1024,
  }),
  'assistant-homes': Object.freeze({
    name: 'assistant-homes',
    containerPath: '~/memory/',
    mode: 'rw',
    immutable: false,
    conflictPolicy: 'merge_or_conflict_copy',
    redact: true,
    redactionPolicy: 'redact',
    history: true,
    rejectSensitivePaths: true,
    allowInternalSymlinks: false,
    maxFileBytes: 256 * 1024,
    maxBatchBlobs: 128,
    maxBatchBytes: 16 * 1024 * 1024,
  }),
});

export const SYNC_NAMESPACE_NAMES: readonly SyncNamespaceName[] = Object.freeze(
  Object.keys(SYNC_NAMESPACE_POLICIES) as SyncNamespaceName[],
);

export function isSyncNamespaceName(value: unknown): value is SyncNamespaceName {
  return typeof value === 'string' && Object.hasOwn(SYNC_NAMESPACE_POLICIES, value);
}

export function getSyncNamespacePolicy(name: unknown): SyncNamespacePolicy {
  if (!isSyncNamespaceName(name)) return fail(404, 'sync_namespace_not_found');
  return SYNC_NAMESPACE_POLICIES[name];
}
