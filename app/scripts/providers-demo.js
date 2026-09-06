#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { createHistoryProvider } = require('../src/main/providers/history.js');
const { createAccountsProvider } = require('../src/main/providers/accounts.js');
const { createDelegateProvider, queuePath } = require('../src/main/providers/delegate.js');
const { createUsageProvider } = require('../src/main/providers/usage.js');

const WORKSPACE = path.resolve(__dirname, '..', '..');

// The indexer may refresh ~/.cache during normal app operation. The demo is
// explicitly read-only outside app/, so suppress that cache write.
process.env.HARBOR_INDEX_READ_ONLY = '1';

async function main() {
  const history = createHistoryProvider();
  const delegate = createDelegateProvider();
  const usage = createUsageProvider();
  try {
    const sessions = await history.listSessions();
    const tree = await history.projectTree();
    const projectCount = tree.filter((row) => row.type === 'project').length;
    console.log('HISTORY');
    console.log(JSON.stringify({ sessionCount: sessions.length, projectCount, newest: sessions[0] || null }, null, 2));

    const accountResolver = createAccountsProvider({ history });
    console.log('ACCOUNTS');
    console.log(JSON.stringify(sessions[0] ? await accountResolver.resolveSession(sessions[0].id) : null, null, 2));

    const queue = await delegate.getQueue(WORKSPACE);
    const workers = await delegate.getWorkers(WORKSPACE);
    const statuses = {};
    for (const batch of queue.batches || []) statuses[batch.status] = (statuses[batch.status] || 0) + 1;
    console.log('DELEGATE');
    console.log(JSON.stringify({
      workspace: WORKSPACE,
      queuePath: queuePath(WORKSPACE),
      batchCount: (queue.batches || []).length,
      statuses,
      batches: (queue.batches || []).map(({ id, title, sprint, status, worker, last_session_id, last_result_excerpt, last_error, status_note, dispatch_count }) => ({
        id, title, sprint, status, worker, last_session_id, last_result_excerpt, last_error, status_note, dispatch_count,
      })),
      workers,
    }, null, 2));

    console.log('USAGE');
    console.log(JSON.stringify({
      personal: await usage.getUsage('personal'),
      team: await usage.getUsage('team'),
    }, null, 2));
  } finally {
    history.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
