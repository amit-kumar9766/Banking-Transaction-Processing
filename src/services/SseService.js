// Stores all open SSE connections, keyed by account_id.
// One account can have multiple open connections (e.g. two browser tabs).
const connections = new Map();

// Called when a client opens GET /sse/:account_id
function addConnection(accountId, res) {
  if (!connections.has(accountId)) {
    connections.set(accountId, new Set());
  }
  connections.get(accountId).add(res);
  console.log(`[SSE] Client connected for account=${accountId} | total=${connections.get(accountId).size}`);
}

// Called when client disconnects (tab closed, network drop etc.)
function removeConnection(accountId, res) {
  const clients = connections.get(accountId);
  if (clients) {
    clients.delete(res);
  }
  console.log(`[SSE] Client disconnected for account=${accountId}`);
}

// Push an event to ALL open connections for a given account_id.
// If nobody is listening, this is a no-op — events are not queued.
function pushToAccount(accountId, event) {
  const clients = connections.get(accountId);
  if (!clients || clients.size === 0) return;

  // SSE format:
  //   data: {...json...}\n\n
  const payload = `data: ${JSON.stringify(event)}\n\n`;

  for (const res of clients) {
    res.write(payload);
  }

  console.log(`[SSE] Pushed event to account=${accountId} | clients=${clients.size}`);
}

module.exports = {
  addConnection,
  removeConnection,
  pushToAccount,
};