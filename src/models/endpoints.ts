import type { ModelInterfaceType } from './catalog.js';

// The one place a saved model URL becomes request addresses (tasks, model listing and model tests all use it).
// Only a trailing slash and a trailing /chat/completions are removed; /v1 is never added or removed, so the base the
// administrator wrote decides whether requests carry it. has_v1 reports whether that base path ends in /v1.
export function modelEndpoints(url:string){
  const base=url.replace(/\/$/,'').replace(/\/chat\/completions$/,'');
  let path='';try{path=new URL(base).pathname;}catch{/* A saved URL was validated on write; an unparsable one simply has no /v1. */}
  return {chat_url:base+'/chat/completions',models_url:base+'/models',has_v1:/\/v1$/.test(path)};
}
export function resolveModelWireUrl(url: string, interfaceType: ModelInterfaceType = 'openai-chat-completions'): string {
  const trimmed = url.replace(/\/$/, '');
  if (interfaceType === 'openai-chat-completions') return modelEndpoints(url).chat_url;
  if (interfaceType === 'anthropic-messages') {
    if (trimmed.endsWith('/messages')) return trimmed;
    const stripped = trimmed.replace(/\/(?:chat\/completions|responses)$/, '');
    let path = ''; try { path = new URL(stripped).pathname; } catch {}
    return /\/v1$/.test(path) ? stripped + '/messages' : stripped + '/v1/messages';
  }
  if (trimmed.endsWith('/responses')) return trimmed;
  const stripped = trimmed.replace(/\/(?:chat\/completions|messages)$/, '');
  let path = ''; try { path = new URL(stripped).pathname; } catch {}
  return !path || path === '/' ? stripped + '/v1/responses' : stripped + '/responses';
}
export function resolveModelsListUrl(url: string, interfaceType: ModelInterfaceType = 'openai-chat-completions'): string {
  if (interfaceType === 'openai-chat-completions') return modelEndpoints(url).models_url;
  const stripped = url.replace(/\/$/, '').replace(/\/(?:chat\/completions|responses|messages|models)$/, '');
  let path = ''; try { path = new URL(stripped).pathname; } catch {}
  if (interfaceType === 'anthropic-messages' && !/\/v1$/.test(path)) return stripped + '/v1/models';
  if (interfaceType === 'openai-responses' && (!path || path === '/')) return stripped + '/v1/models';
  return stripped + '/models';
}
/**
 * The addresses a model URL really calls under one interface (#1332): chat_url is the generation request (Chat
 * Completions, Responses or Messages), models_url the model list. has_v1 says whether the path before the
 * interface's own route ends in /v1; for Chat Completions this is exactly modelEndpoints().has_v1.
 */
export function interfaceEndpoints(url: string, interfaceType: ModelInterfaceType) {
  const chat_url = resolveModelWireUrl(url, interfaceType);
  let path = ''; try { path = new URL(chat_url).pathname.replace(/\/(?:chat\/completions|responses|messages)$/, ''); } catch {}
  return { chat_url, models_url: resolveModelsListUrl(url, interfaceType), has_v1: /\/v1$/.test(path) };
}
