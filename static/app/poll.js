// #739: a read that answered 401/403/404 will answer the same way however often it is asked, so a poll built on it stops
// and leaves the next read to the person; anything else may clear on its own, so it keeps retrying with a delay that
// doubles up to half a minute.
const terminalReadStatuses = [401, 403, 404];
function pollAfterError(error, previousDelay = 0) {
  if (terminalReadStatuses.includes(error?.status)) return { terminal: true, delay: 0 };
  return { terminal: false, delay: previousDelay ? Math.min(previousDelay * 2, 30000) : 5000 };
}
