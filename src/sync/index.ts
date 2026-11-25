import type { Store } from '../storage/database.js';
import type { Manager } from '../projects/service.js';
import type { ProjectToolsService } from '../projects/tools.js';
import type { AssistantHomes } from '../service-roles/assistant-computers.js';
import { LocalDiskBlobStore } from './blob-store.js';
import {
  AgentToolsSyncAdapter,
  createAssistantHomesAdapter,
  createProjectNotesDirectoryAdapter,
  ManagerProjectNotesAdapter,
  ProjectToolsSyncAdapter,
  SkillStoreSyncAdapter,
  ToolResultsSyncAdapter,
} from './adapters.js';
import { FileSyncEngine } from './engine.js';
import { createSyncHttpHandler, type SyncAuthenticator } from './http.js';
import { SyncTokenService } from './storage.js';
import type { BlobStore, SyncNamespaceAdapter } from './types.js';

export * from './types.js';
export * from './namespaces.js';
export * from './paths.js';
export * from './blob-store.js';
export * from './merge3.js';
export * from './storage.js';
export * from './adapters.js';
export * from './engine.js';
export * from './http.js';

export interface CreateDefaultSyncRuntimeOptions {
  store: Store;
  blobStore?: BlobStore;
  blobRoot?: string;
  manager?: Manager;
  projectNotesRoot?: string;
  projectTools?: ProjectToolsService;
  projectToolsRoot?: string;
  agentToolsRoot?: string;
  skillStoreRoot?: string;
  toolResultsRoot?: string;
  assistantHomes?: AssistantHomes;
  assistantHomesRoot?: string;
  extraAdapters?: SyncNamespaceAdapter[];
  authenticate?: SyncAuthenticator;
  tokens?: SyncTokenService;
  clock?: () => number;
}

export interface SyncRuntime {
  engine: FileSyncEngine;
  tokens: SyncTokenService;
  handleHttp: ReturnType<typeof createSyncHttpHandler>;
}

/**
 * Constructs the control-plane FileSyncEngine wired to all 6 platform directory namespaces
 * (`tool-results`, `project-tools`, `agent-tools`, `skill-store`, `project-notes`, `assistant-homes`).
 */
export function createDefaultSyncRuntime(options: CreateDefaultSyncRuntimeOptions): SyncRuntime {
  const defaultBlobRoot = options.blobRoot ?? options.store.syncBlobsDir;
  const blobStore = options.blobStore ?? new LocalDiskBlobStore(defaultBlobRoot);

  const adapters: SyncNamespaceAdapter[] = [
    new ToolResultsSyncAdapter(options.store, options.toolResultsRoot),
    new ProjectToolsSyncAdapter(options.store, options.projectTools, options.projectToolsRoot),
    new AgentToolsSyncAdapter(options.agentToolsRoot, options.store),
    new SkillStoreSyncAdapter(options.store, options.skillStoreRoot),
  ];

  if (options.projectNotesRoot) {
    adapters.push(createProjectNotesDirectoryAdapter(options.projectNotesRoot, options.store));
  } else if (options.manager) {
    adapters.push(new ManagerProjectNotesAdapter(options.manager, options.store));
  }

  if (options.assistantHomes || options.assistantHomesRoot) {
    adapters.push(createAssistantHomesAdapter(options.assistantHomes, options.assistantHomesRoot, options.store));
  }

  if (options.extraAdapters) {
    adapters.push(...options.extraAdapters);
  }

  const engine = new FileSyncEngine({
    store: options.store,
    blobStore,
    adapters,
    clock: options.clock,
  });
  const tokens = options.tokens ?? new SyncTokenService(options.store, options.clock);
  const handleHttp = createSyncHttpHandler({
    engine,
    tokens,
    authenticate: options.authenticate,
  });
  return { engine, tokens, handleHttp };
}
