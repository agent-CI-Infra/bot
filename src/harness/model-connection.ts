import { stop } from '../agent/common.js';
import { resolveModelWireUrl, type RuntimeModel } from '../agent/model.js';
import { readProviderCredentialFile, type FileBackedModelProvider } from './model-gateway.js';

export type ModelTransport = 'direct' | 'gateway';
export function modelTransport(value?: unknown): ModelTransport {
  const mode = value ?? process.env.BOT_HARNESS_MODEL_TRANSPORT ?? 'direct';
  if (mode !== 'direct' && mode !== 'gateway') return stop('harness_model_transport_invalid', 'waiting_configuration', 'modelTransport must be direct or gateway.');
  return mode;
}

export interface NativeModelConnection {
  baseUrl: string;
  key: string;
  interfaceType: 'openai-responses' | 'openai-chat-completions' | 'anthropic-messages';
}
export function nativeModelConnection(model?: RuntimeModel, provider?: FileBackedModelProvider, providerDefault:NativeModelConnection['interfaceType']='openai-responses'): NativeModelConnection | undefined {
  let result: NativeModelConnection;
  if (provider) result = {
    baseUrl: provider.baseUrl,
    key: provider.credentialFile ? readProviderCredentialFile(provider.credentialFile).key : provider.apiKey ?? '',
    interfaceType: provider.interfaceType ?? providerDefault,
  };
  else {
    if (!model) return undefined; // Use the Harness's own configured provider/login.
    result = { baseUrl: model.url, key: model.key, interfaceType: model.protocol?.interface_type ?? 'openai-chat-completions' };
  }
  const wireUrl=resolveModelWireUrl(result.baseUrl,result.interfaceType);
  result.baseUrl=result.interfaceType==='anthropic-messages'?wireUrl.replace(/\/v1\/messages$/,'').replace(/\/messages$/,''):wireUrl.replace(/\/(?:responses|chat\/completions)$/,'');
  return result;
}
