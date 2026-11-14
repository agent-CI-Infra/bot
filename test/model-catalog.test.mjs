import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/storage/database.js';
import {ModelCatalog,parseCatalog,modelCatalog,modelCapabilities,catalogPricing,saveModelMetadata} from '../dist/models/catalog.js';

const card=(id,extra={})=>({id,name:id,attachment:true,reasoning:true,limit:{context:1048576,output:393216},modalities:{input:['text','image'],output:['text']},cost:{input:0.15,output:0.6,cache_read:0.003},...extra});
const data=()=>({deepseek:{name:'DeepSeek',api:'https://api.deepseek.com',doc:'https://api-docs.deepseek.com/quick_start',models:{'deepseek-flash':card('deepseek-flash',{canonical_model_id:'deepseek/deepseek-flash'})}},
  anthropic:{name:'Anthropic',doc:'https://docs.anthropic.com/models',models:{'claude-sonnet-4-5':card('claude-sonnet-4-5',{canonical_model_id:'anthropic/claude-sonnet-4-5'})}},
  proxy:{api:'https://proxy.example/v1',models:{'deepseek/deepseek-flash':card('deepseek/deepseek-flash',{canonical_model_id:'deepseek/deepseek-flash',cost:{input:1,output:2}})}}});
const storeFor=t=>{const store=new Store(':memory:',Buffer.alloc(32,3));t.after(()=>store.close());store.run("INSERT INTO models VALUES('m',NULL,'https://relay.example/v1','deepseek-flash',NULL,1,'now')");return store;};
const install=async(store,payload=data())=>{const catalog=new ModelCatalog(store,async()=>new Response(JSON.stringify(payload)));await catalog.refresh();return catalog;};

test('catalog validation drops malformed entries independently, retains zero prices and skips non-chat models',()=>{
  const input=data();input.deepseek.models.free=card('free',{cost:{input:0,output:0}});
  input.deepseek.models.embedding=card('embedding',{type:'embedding'});
  for(const [i,bad] of [{limit:{context:-1,output:2}},{limit:{context:Infinity,output:2}},{limit:{context:1e15,output:2}},{reasoning:'yes'},{cost:{input:-1,output:1}},{cost:{input:1,output:'1'}},{modalities:{input:'text',output:['text']}},{limit:{context:1}}].entries())input.deepseek.models['bad'+i]=card('bad'+i,bad);
  const parsed=parseCatalog(input);assert.equal(parsed.rejected,8);assert.equal(parsed.skipped,1);assert.equal(parsed.entries.length,4);
  assert.deepEqual(parsed.entries.find(e=>e.model==='free').cost,{input:0,output:0});assert.throws(()=>parseCatalog({}),/catalog_empty/);
});

test('known provider hosts use their prices; unknown relays match official names including prefixes and dot aliases',async t=>{
  const store=storeFor(t),catalog=await install(store);
  const relay=catalog.match({api_url:'https://relay.example/v1',model_name:'DeepSeek-Flash'});assert.equal(relay.entry.ref,'deepseek/deepseek-flash');
  assert.equal(catalog.match({api_url:'https://proxy.example/v1',model_name:'deepseek-flash'}).entry.cost.input,1);
  assert.equal(catalog.match({api_url:'https://api.anthropic.com/v1',model_name:'claude-sonnet-4.5'}).entry.provider,'anthropic');
  assert.equal(catalog.match({api_url:'https://relay.example/v1',model_name:'anthropic/CLAUDE-SONNET-4.5'}).entry.ref,'anthropic/claude-sonnet-4-5');
  assert.equal(catalog.match({api_url:'https://api.deepseek.com.attacker.example/v1',model_name:'unlisted'}).state,'unmatched');
});

test('failed refresh preserves the prior snapshot, records its error and survives a new catalog instance',async t=>{
  const store=storeFor(t),catalog=await install(store),previous=catalog.status();
  const offline=new ModelCatalog(store,async()=>{throw new Error('private upstream body must never be persisted');});
  const failed=await offline.refresh();assert.equal(failed.fetched_at,previous.fetched_at);assert.equal(failed.revision,previous.revision);assert.equal(failed.last_error,'catalog_refresh_failed');assert.ok(failed.last_attempt_at);
  assert.equal(new ModelCatalog(store).match({api_url:'https://relay.example/v1',model_name:'deepseek-flash'}).entry.cost.output,0.6);
  const invalid=new ModelCatalog(store,async()=>new Response('{}'));await invalid.refresh();assert.equal(invalid.status().last_error,'catalog_empty');assert.equal(invalid.status().entries,3);
});

test('manual selection, disabling and partial capability overrides keep model identity and can fall back to the catalog',async t=>{
  const store=storeFor(t);await install(store);
  const model=store.get("SELECT * FROM models WHERE id='m'");assert.equal(modelCapabilities(store,model).max_output_tokens,393216);assert.equal(catalogPricing(store,model).input_per_million,0.15);
  saveModelMetadata(store,'m',{capabilities:{reasoning:false,max_output_tokens:12000}});assert.equal(modelCapabilities(store,model).context_window,1048576);assert.equal(modelCapabilities(store,model).reasoning,false);
  saveModelMetadata(store,'m',{catalog:{mode:'manual',ref:'proxy/deepseek/deepseek-flash'}});assert.equal(catalogPricing(store,model).input_per_million,1);
  saveModelMetadata(store,'m',{catalog:{mode:'disabled'},capabilities:{}});assert.equal(modelCapabilities(store,model).max_output_tokens,8192);assert.equal(catalogPricing(store,model),null);
  saveModelMetadata(store,'m',{catalog:{mode:'auto'}});assert.equal(modelCapabilities(store,model).reasoning,true);assert.equal(store.get("SELECT version FROM models WHERE id='m'").version,1);
  assert.throws(()=>saveModelMetadata(store,'m',{capabilities:{context_window:1000,max_output_tokens:2000}}),{code:'invalid_model_capabilities'});
  assert.throws(()=>saveModelMetadata(store,'m',{capabilities:{context_window:-1}}),{code:'invalid_model_capabilities'});
  assert.throws(()=>saveModelMetadata(store,'m',{catalog:{mode:'manual',ref:'unknown'}}),{code:'model_catalog_entry_not_found'});
});

test('simultaneous refresh requests share one fetch and close waits for cancellation before SQLite closes',async t=>{
  const store=storeFor(t);let fetches=0,started;
  const begun=new Promise(resolve=>{started=resolve;});
  const catalog=new ModelCatalog(store,async(_url,{signal})=>{fetches++;started();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));});
  const a=catalog.refresh(),b=catalog.refresh();assert.equal(a,b);await begun;await catalog.close();await a;assert.equal(fetches,1);assert.equal(catalog.status().entries,0);
  assert.equal(modelCatalog(store),modelCatalog(store));
});

import {pricingFor,savePricing,validatePricing,beginModelRequest,finishModelRequest} from '../dist/metrics/accounting.js';
test('manual price fields override catalog fields independently, currencies never mix and clearing overrides restores catalog billing',async t=>{
  const store=storeFor(t);await install(store);
  assert.deepEqual(pricingFor(store,'m'),{currency:'USD',input_per_million:0.15,output_per_million:0.6,cache_per_million:0.003});
  savePricing(store,'m',validatePricing({currency:'USD',input_per_million:2}));assert.deepEqual(pricingFor(store,'m'),{currency:'USD',input_per_million:2,output_per_million:0.6,cache_per_million:0.003});
  savePricing(store,'m',validatePricing({currency:'CNY',input_per_million:1}));assert.equal(pricingFor(store,'m'),null);
  savePricing(store,'m',validatePricing({currency:'CNY',input_per_million:1,output_per_million:2,cache_per_million:0.1}));assert.equal(pricingFor(store,'m').currency,'CNY');
  savePricing(store,'m',null);assert.equal(pricingFor(store,'m').input_per_million,0.15);
  const request=beginModelRequest(store,{id:null,service_role_id:'catalog-test'},'request',{id:'m',model:'deepseek-flash',pricing:pricingFor(store,'m')});
  finishModelRequest(store,request,{prompt_tokens:1000,completion_tokens:500,prompt_tokens_details:{cached_tokens:100}},200);
  const row=store.get('SELECT currency,cost FROM model_requests WHERE id=?',request);assert.equal(row.currency,'USD');assert.ok(Math.abs(row.cost-0.0004353)<1e-12);
});

import {harness,setup,account,repository,testPassword} from './helpers.mjs';
test('catalog API exposes snapshot health, authorizes refresh and keeps metadata independent of model identity',async t=>{
  const h=await harness(t),{admin}=await setup(h),a=await account(admin);await repository(admin,a.id,'101');
  const catalog=modelCatalog(h.store);catalog.fetcher=async()=>new Response(JSON.stringify(data()));
  let response=await admin('/api/models/catalog/refresh','POST',{});assert.equal(response.status,201);assert.equal(response.value.catalog.entries,3);
  const shared=(await admin('/api/models','POST',{api_url:'https://relay.example/v1',api_key:testPassword(),model_name:'deepseek-flash'})).value.model;
  assert.equal(shared.capabilities.catalog.entry.ref,'deepseek/deepseek-flash');assert.equal(shared.pricing_source,'catalog');assert.equal(shared.pricing.currency,'USD');
  response=await admin('/api/models/'+shared.id,'PATCH',{version:1,capabilities:{max_output_tokens:12000},pricing:{currency:'USD',input_per_million:2}});
  assert.equal(response.status,200);assert.equal(response.value.model.version,1);assert.equal(response.value.model.capabilities.max_output_tokens,12000);assert.equal(response.value.model.pricing.output_per_million,0.6);
  assert.equal((await admin('/api/models/catalog?q=claude&limit=1')).value.total,1);
  const password=testPassword();await admin('/api/users','POST',{username:'catalog-member',password,repository_ids:['101']});const member=h.client();await member('/api/auth/login','POST',{username:'catalog-member',password});
  assert.equal((await member('/api/models/catalog')).status,200);assert.equal((await member('/api/models/catalog/refresh','POST',{})).status,403);
  assert.equal((await member('/api/models/'+shared.id,'PATCH',{version:1,capabilities:{reasoning:false}})).status,404);
  const own=(await member('/api/models','POST',{repository_id:'101',api_url:'https://relay.example/v1',api_key:testPassword(),model_name:'anthropic/claude-sonnet-4.5'})).value.model;
  assert.equal((await member('/api/models/'+own.id,'PATCH',{version:1,catalog:{mode:'manual',ref:'deepseek/deepseek-flash'},capabilities:{reasoning:false}})).status,200);
  catalog.fetcher=async()=>{throw new Error('offline');};response=await admin('/api/models/catalog/refresh','POST',{});
  assert.equal(response.value.catalog.last_error,'catalog_refresh_failed');assert.equal(response.value.catalog.entries,3);
  response=await admin('/api/models/'+shared.id,'PATCH',{version:1,pricing:null,capabilities:{}});assert.equal(response.value.model.capabilities.max_output_tokens,393216);assert.equal(response.value.model.pricing.input_per_million,0.15);
});

import {externalModelPricing,recordExternalModelRequest} from '../dist/metrics/accounting.js';
test('external harness receipts use official catalog prices without a configured model, then prefer visible manual prices without double counting',async t=>{
  const store=storeFor(t);await install(store);
  store.run("INSERT INTO accounts VALUES('a','a','github_app','1','{}','now')");store.run("INSERT INTO repositories VALUES('101','fixture/catalog','o','a')");
  const task={id:null,repository_id:'101'};assert.equal(externalModelPricing(store,task,'DeepSeek-Flash').input_per_million,0.15);
  const receipt={key:'receipt',source:'codex_events',model:'deepseek-flash',started_at:new Date().toISOString(),input_tokens:1000,output_tokens:500,cached_input_tokens:100,finished:true};
  const id=recordExternalModelRequest(store,task,'catalog-run',receipt);recordExternalModelRequest(store,task,'catalog-run',receipt);
  assert.equal(store.get('SELECT count(*) n FROM model_requests').n,1);assert.ok(Math.abs(store.get('SELECT cost FROM model_requests WHERE id=?',id).cost-0.0004353)<1e-12);
  store.run("INSERT INTO model_projects VALUES('m','101')");savePricing(store,'m',{currency:'CNY',input_per_million:1,output_per_million:2,cache_per_million:0.1});
  assert.equal(externalModelPricing(store,task,'deepseek/deepseek-flash').currency,'CNY');assert.equal(store.get('SELECT currency FROM model_requests WHERE id=?',id).currency,'USD');
  savePricing(store,'m',null);saveModelMetadata(store,'m',{catalog:{mode:'disabled'}});assert.equal(externalModelPricing(store,task,'deepseek-flash'),null);
});

test('an ambiguous relay identity remains unpriced until the administrator chooses a catalog entry',async t=>{
  const store=storeFor(t),input=data();input.alternate={api:'https://alternate.example',models:{'deepseek-flash':card('deepseek-flash',{canonical_model_id:'alternate/deepseek-flash',cost:{input:1,output:3}})}};
  const catalog=await install(store,input),model=store.get("SELECT * FROM models WHERE id='m'");
  const match=catalog.match(model);assert.equal(match.state,'ambiguous');assert.deepEqual(match.candidates,['deepseek/deepseek-flash','alternate/deepseek-flash']);assert.equal(catalogPricing(store,model),null);
  saveModelMetadata(store,'m',{catalog:{mode:'manual',ref:'alternate/deepseek-flash'}});assert.equal(catalogPricing(store,model).input_per_million,1);
});
