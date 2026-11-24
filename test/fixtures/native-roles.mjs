// The few service assistant cases that check what only the native loop does run on Native, and go with it in #1257: its
// own image recovery and request fitting (channel-media), admission closing at a stream's finish marker
// (channel-turn-messages) and the Native half of the shared batch budget cases (#333 in management and
// channel-service-bindings). Every other in-process service assistant test runs the scripted test driver
// (scripted-roles.mjs, #1256); a group binding chooses Native by naming it when it is saved.
export function nativeServiceAssistants(store) {
  store.run("UPDATE service_roles SET harness='native' WHERE id='management-assistant'");
}
