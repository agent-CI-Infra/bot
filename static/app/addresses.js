// Every page has an address, so a reload or a shared link opens the same page. Accounts and users live in global settings.
const tabAddresses = { projects: '#/projects', board: '#/board', costs: '#/costs', events: '#/events',
  preferences: '#/preferences', conversations: '#/conversations', more: '#/more', inbox: '#/inbox', external: '#/external', settings: '#/settings', identity: '#/identity', management: '#/management', 'new-task': '#/new-task' }, superTabs = ['settings'];
const retryableStates = ['paused', 'failed', 'waiting_configuration', 'waiting_environment', 'waiting_permission', 'waiting_publication', 'waiting_pr_head', 'retry_wait', 'needs_replan'];
// A task the bot moved out of 待处理 as obsolete (#713) is cancelled but still retried by hand, as the state it left.
const obsoleteTask = task => task.status === 'cancelled' && String(task.error_code || '').startsWith('obsolete_');
const taskRetryable = task => retryableStates.includes(task.status) || obsoleteTask(task);
let messagePage = null;
// #736: a path segment of an address is whatever the browser sends. decodeURIComponent throws a URIError on malformed
// percent-encoding, so an address a reader typed by hand would take a page down instead of reading as an unknown one.
// This answers the decoded segment, or null when the segment is not valid encoding.
const safeDecode = value => { try { return decodeURIComponent(value); } catch { return null; } };
