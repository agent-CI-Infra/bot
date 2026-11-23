// The service assistants since #1255: the management assistant starts on Pi, which needs an assistant computer; tests
// of conversation mechanics that drive a fake model in process run it on Native, as before (management-fixture.mjs). Group
// bindings name their backend when they are saved (channel-fixture.mjs boundGroup). Tests of Pi service assistants choose
// Pi themselves. Project roles use the scripted test driver instead (scripted-roles.mjs, #1256).
export function nativeServiceAssistants(store) {
  store.run("UPDATE service_roles SET harness='native' WHERE id='management-assistant'");
}
