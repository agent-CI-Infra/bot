import type { Store } from '../storage/database.js';
import { fail, fields, type Json } from '../core/security.js';

export interface Capabilities { context_window: number; max_output_tokens: number; reasoning: boolean }
export interface CatalogEntry {
  ref: string; provider: string; provider_name: string; model: string; name: string; api: string | null; doc: string | null;
  canonical: string | null; capabilities: Capabilities; attachment: boolean; modalities: { input: string[]; output: string[] };
  cost: { input: number; output: number; cache_read?: number; cache_write?: number } | null;
}
export interface CatalogStatus {revision:number;fetched_at:string|null;last_attempt_at:string|null;last_error:string|null;rejected:number;skipped:number;source:string;entries:number}
const defaults: Capabilities = { context_window: 128000, max_output_tokens: 8192, reasoning: false };
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const positive = (v: unknown, max: number) => Number.isSafeInteger(v) && Number(v) > 0 && Number(v) <= max;
const id = (v: unknown, max = 512): v is string => typeof v === 'string' && !!v && v.length <= max && !/[\s\x00-\x1f]/.test(v);
const address = (v: unknown): string | null => { try { const u = new URL(String(v)); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; } catch { return null; } };
export const normalizeModelName = (v: string) => v.replace(/^[^/]+\//, '').replaceAll('.', '-').toLowerCase();

/** Only the public fields used for matching, limits and billing survive validation; provider instructions never do. */
export function parseCatalog(value: unknown) {
  if (!object(value) || Object.keys(value).length > 1000) throw new Error('catalog_invalid');
  const entries: CatalogEntry[] = []; let rejected = 0, skipped = 0;
  for (const [provider, p] of Object.entries(value)) {
    if (!/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(provider) || !object(p) || !object(p.models)) { rejected++; continue; }
    for (const [key, m] of Object.entries(p.models)) {
      if (entries.length + rejected + skipped > 100000) throw new Error('catalog_too_large');
      if (object(m) && m.type !== undefined && m.type !== 'chat') { skipped++; continue; }
      if (!object(m) || !id(key) || !id(m.id) || m.id !== key || typeof m.name !== 'string' || m.name.length > 500 ||
        !object(m.limit) || !positive(m.limit.context, 32000000) || !positive(m.limit.output, 16000000) || m.limit.output > m.limit.context ||
        typeof m.reasoning !== 'boolean' || typeof m.attachment !== 'boolean' || !object(m.modalities) ||
        !['input','output'].every(k => Array.isArray(m.modalities[k]) && m.modalities[k].length > 0 && m.modalities[k].length <= 16 && m.modalities[k].every((v: unknown) => id(v, 32)))) { rejected++; continue; }
      if (!m.modalities.input.includes('text') || !m.modalities.output.includes('text')) { skipped++; continue; }
      let cost: CatalogEntry['cost'] = null;
      if (m.cost !== undefined) {
        if (!object(m.cost) || ['input','output','cache_read','cache_write'].some(k => (k === 'input' || k === 'output' || Object.hasOwn(m.cost,k)) &&
          (typeof m.cost[k] !== 'number' || !Number.isFinite(m.cost[k]) || m.cost[k] < 0 || m.cost[k] > 1000000))) { rejected++; continue; }
        cost = { input: m.cost.input, output: m.cost.output, ...(m.cost.cache_read !== undefined ? {cache_read:m.cost.cache_read}:{}), ...(m.cost.cache_write !== undefined ? {cache_write:m.cost.cache_write}:{}) };
      }
      entries.push({ ref: provider + '/' + key, provider, provider_name: typeof p.name === 'string' ? p.name.slice(0,200) : provider,
        model: key, name: m.name, api: address(p.api), doc: address(p.doc), canonical: id(m.canonical_model_id) ? m.canonical_model_id : null,
        capabilities: { context_window:m.limit.context, max_output_tokens:m.limit.output, reasoning:m.reasoning }, attachment:m.attachment,
        modalities:{input:[...m.modalities.input],output:[...m.modalities.output]}, cost });
    }
  }
  if (!entries.length) throw new Error('catalog_empty');
  return { entries, rejected, skipped };
}
export function modelCatalogStorage(store: Pick<Store,'db'>) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS model_catalog_snapshot(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL DEFAULT 0,
      fetched_at TEXT,last_attempt_at TEXT,last_error TEXT,rejected INTEGER NOT NULL DEFAULT 0,skipped INTEGER NOT NULL DEFAULT 0,data TEXT);
    INSERT OR IGNORE INTO model_catalog_snapshot(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS model_catalog_overrides(model_id TEXT PRIMARY KEY REFERENCES models(id) ON DELETE CASCADE,
      mode TEXT NOT NULL DEFAULT 'auto',catalog_ref TEXT,capabilities TEXT NOT NULL DEFAULT '{}',pricing TEXT);`);
}
const catalogs = new WeakMap<Store,ModelCatalog>();
export function modelCatalog(store:Store) { let catalog=catalogs.get(store);if(!catalog){catalog=new ModelCatalog(store);catalogs.set(store,catalog);}return catalog; }
export class ModelCatalog {
  private revision = -1;
  private entries: CatalogEntry[] = [];
  private pending?: Promise<any>;
  private controller?: AbortController;
  private timer?: ReturnType<typeof setInterval>;
  constructor(readonly store:Store,readonly fetcher:typeof fetch=fetch) {}
  status():CatalogStatus {const row=this.store.get('SELECT revision,fetched_at,last_attempt_at,last_error,rejected,skipped FROM model_catalog_snapshot WHERE id=1')!;
    return {revision:row.revision,fetched_at:row.fetched_at,last_attempt_at:row.last_attempt_at,last_error:row.last_error,rejected:row.rejected,skipped:row.skipped,source:'https://models.dev/api.json',entries:this.snapshot().length};}
  snapshot(): CatalogEntry[] {
    const row=this.store.get('SELECT revision FROM model_catalog_snapshot WHERE id=1')!;
    if(row.revision!==this.revision){const data=this.store.get('SELECT data FROM model_catalog_snapshot WHERE id=1')!.data;this.entries=data?JSON.parse(data):[];this.revision=row.revision;}
    return this.entries;
  }
  refresh():Promise<any> {
    if(this.pending)return this.pending;
    const controller=new AbortController();this.controller=controller;
    this.pending=(async()=>{
      this.store.run('UPDATE model_catalog_snapshot SET last_attempt_at=? WHERE id=1',new Date().toISOString());
      try {
        const response=await this.fetcher('https://models.dev/api.json',{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(20000)]),redirect:'error'});
        if(!response.ok)throw new Error('catalog_http_'+response.status);
        if(!response.body)throw new Error('catalog_response_empty');
        const chunks:Uint8Array[]=[];let bytes=0;
        for await(const part of response.body as any){bytes+=part.length;if(bytes>16*1024*1024){controller.abort();throw new Error('catalog_too_large');}chunks.push(part);}
        const parsed=parseCatalog(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if(controller.signal.aborted)throw new Error('catalog_refresh_cancelled');
        this.store.run('UPDATE model_catalog_snapshot SET revision=revision+1,fetched_at=?,last_error=NULL,rejected=?,skipped=?,data=? WHERE id=1',new Date().toISOString(),parsed.rejected,parsed.skipped,JSON.stringify(parsed.entries));
      } catch(error) {
        const message=String((error as Error).message),code=/^catalog_(?:invalid|empty|too_large|response_empty|refresh_cancelled|http_\d+)$/.test(message)?message:'catalog_refresh_failed';
        this.store.run('UPDATE model_catalog_snapshot SET last_error=? WHERE id=1',code);
      }
      return this.status();
    })().finally(()=>{this.pending=undefined;this.controller=undefined;});
    return this.pending;
  }
  start() {if(this.timer)return;void this.refresh();this.timer=setInterval(()=>void this.refresh(),6*60*60*1000);this.timer.unref();}
  async close(){clearInterval(this.timer);this.timer=undefined;this.controller?.abort();await this.pending;}
  match(model:{id?:string;api_url:string;model_name:string}) {
    const saved=model.id?this.store.get('SELECT * FROM model_catalog_overrides WHERE model_id=?',model.id):undefined;
    const base={fetched_at:this.status().fetched_at,mode:saved?.mode??'auto',selected_ref:saved?.catalog_ref??null};
    if(saved?.mode==='disabled')return {...base,state:'disabled' as const,entry:null};
    const entries=this.snapshot();if(!entries.length)return {...base,state:'unavailable' as const,entry:null};
    if(saved?.mode==='manual'){const entry=entries.find(e=>e.ref===saved.catalog_ref)??null;return {...base,state:entry?'matched' as const:'missing' as const,entry};}
    const sameName=entries.filter(e=>normalizeModelName(e.model)===normalizeModelName(model.model_name));
    let host='';try{host=new URL(model.api_url).hostname.toLowerCase();}catch{}
    const providers=new Set(entries.filter(e=>{
      if(e.api&&new URL(e.api).hostname.toLowerCase()===host)return true;
      if(!e.doc)return false;
      const domain=new URL(e.doc).hostname.replace(/^(?:docs?|api-docs|platform|console)\./,'').toLowerCase();
      return host===domain||host.endsWith('.'+domain);
    }).map(e=>e.provider));
    let candidates:CatalogEntry[];
    if(providers.size)candidates=sameName.filter(e=>providers.has(e.provider));
    else {
      const prefix=model.model_name.includes('/')?model.model_name.split('/')[0]!.toLowerCase():null;
      const official=new Set(sameName.flatMap(e=>e.canonical?[e.canonical.split('/')[0]!]:e.model.includes('/')?[e.model.split('/')[0]!]:[]));
      candidates=sameName.filter(e=>prefix?e.provider.toLowerCase()===prefix:official.has(e.provider));
      // A unique provider record needs no guess. Ambiguous identities remain visible for manual selection.
      if(!candidates.length&&sameName.length===1)candidates=sameName;
    }
    const entry=candidates.length===1?candidates[0]!:null;
    return {...base,state:entry?'matched' as const:candidates.length?'ambiguous' as const:'unmatched' as const,entry,...(candidates.length>1?{candidates:candidates.slice(0,20).map(e=>e.ref)}:{})};
  }
}
export function modelCapabilities(store:Store,model:{id:string;api_url:string;model_name:string}):Capabilities & {source:string;catalog:ReturnType<ModelCatalog['match']>} {
  const catalog=modelCatalog(store),match=catalog.match(model),saved=store.get('SELECT capabilities FROM model_catalog_overrides WHERE model_id=?',model.id);
  const manual=saved?JSON.parse(saved.capabilities):{};
  return { ...defaults,...match.entry?.capabilities,...manual,source:Object.keys(manual).length?'manual':match.entry?'catalog':'default',catalog:match };
}
export function catalogPricing(store:Store,model:{id?:string;api_url:string;model_name:string}) {
  const entry=modelCatalog(store).match(model).entry;if(!entry?.cost)return null;
  return {currency:'USD' as const,input_per_million:entry.cost.input,output_per_million:entry.cost.output,cache_per_million:entry.cost.cache_read??entry.cost.input};
}
/** Catalog choice and manual capabilities are model metadata; they do not rotate the endpoint/model identity version. */
export function saveModelMetadata(store:Store,modelId:string,input:Json) {
  const catalog=modelCatalog(store),previous=store.get('SELECT * FROM model_catalog_overrides WHERE model_id=?',modelId);
  let mode=previous?.mode??'auto',ref=previous?.catalog_ref??null,capabilities=previous?JSON.parse(previous.capabilities):{};
  if(input.catalog!==undefined){const value=input.catalog;if(!object(value))return fail(400,'invalid_model_catalog');fields(value,['mode','ref']);
    if(!['auto','manual','disabled'].includes(String(value.mode)))fail(400,'invalid_model_catalog');
    mode=String(value.mode);ref=mode==='manual'?value.ref:null;
    if(mode==='manual'&&(typeof ref!=='string'||!catalog.snapshot().some(e=>e.ref===ref)))fail(400,'model_catalog_entry_not_found');}
  if(input.capabilities!==undefined){const value=input.capabilities;if(!object(value))return fail(400,'invalid_model_capabilities');fields(value,['context_window','max_output_tokens','reasoning']);
    if(value.context_window!==undefined&&!positive(value.context_window,32000000)||value.max_output_tokens!==undefined&&!positive(value.max_output_tokens,16000000)||value.reasoning!==undefined&&typeof value.reasoning!=='boolean')fail(400,'invalid_model_capabilities');
    capabilities={...value};}
  const identity=store.get('SELECT api_url,model_name FROM models WHERE id=?',modelId)!;
  const entry=mode==='manual'?catalog.snapshot().find(e=>e.ref===ref):mode==='disabled'?undefined:catalog.match(identity as any).entry;
  if((capabilities.max_output_tokens??entry?.capabilities.max_output_tokens??defaults.max_output_tokens)>(capabilities.context_window??entry?.capabilities.context_window??defaults.context_window))fail(400,'invalid_model_capabilities','max_output_tokens');
  store.run(`INSERT INTO model_catalog_overrides(model_id,mode,catalog_ref,capabilities) VALUES(?,?,?,?) ON CONFLICT(model_id) DO UPDATE SET mode=excluded.mode,catalog_ref=excluded.catalog_ref,capabilities=excluded.capabilities`,modelId,mode,ref,JSON.stringify(capabilities));
}
