import test from 'node:test';
import assert from 'node:assert/strict';
import {modelTransport,nativeModelConnection} from '../dist/harness/model-connection.js';

test('model connections default to direct; gateway requires explicit configuration',t=>{
 const old=process.env.BOT_HARNESS_MODEL_TRANSPORT;delete process.env.BOT_HARNESS_MODEL_TRANSPORT;
 t.after(()=>{if(old===undefined)delete process.env.BOT_HARNESS_MODEL_TRANSPORT;else process.env.BOT_HARNESS_MODEL_TRANSPORT=old;});
 assert.equal(modelTransport(),'direct');assert.equal(modelTransport('gateway'),'gateway');
 process.env.BOT_HARNESS_MODEL_TRANSPORT='gateway';assert.equal(modelTransport(),'gateway');assert.equal(modelTransport('direct'),'direct');
 assert.throws(()=>modelTransport('implicit-fallback'),{code:'harness_model_transport_invalid'});
});

test('direct provider URLs are native SDK bases and missing configuration means native login',()=>{
 assert.equal(nativeModelConnection(),undefined);
 for(const [interfaceType,url,base] of [['openai-responses','https://api.example/v1/responses','https://api.example/v1'],['anthropic-messages','https://api.example/v1/messages','https://api.example'],['openai-chat-completions','https://api.example/v1/chat/completions','https://api.example/v1']]){
  const c=nativeModelConnection({url,key:'configured-key',protocol:{interface_type:interfaceType}});assert.equal(c.baseUrl,base);assert.equal(c.key,'configured-key');assert.equal(c.interfaceType,interfaceType);
 }
});
