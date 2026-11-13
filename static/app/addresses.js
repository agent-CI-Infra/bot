// Every page has an address, so a reload or a shared link opens the same page. Accounts and users live in global settings.
const tabAddresses = { projects: '#/projects', board: '#/board', costs: '#/costs', events: '#/events',
  preferences: '#/preferences', conversations: '#/conversations', more: '#/more', inbox: '#/inbox', external: '#/external', settings: '#/settings', identity: '#/identity', management: '#/management', 'new-task': '#/new-task' }, superTabs = ['settings'];
const retryableStates = ['paused', 'failed', 'waiting_configuration', 'waiting_environment', 'waiting_permission', 'waiting_publication', 'waiting_pr_head', 'retry_wait', 'needs_replan'];
let messagePage = null;
