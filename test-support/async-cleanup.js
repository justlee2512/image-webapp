// Promise.all rejects before sibling operations finish. Tests must drain the
// whole batch before a failed assertion can start database teardown.
async function settleAll(operations) {
  const results = await Promise.allSettled(operations);
  const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
  if (errors.length) throw new AggregateError(errors, 'Concurrent test operations failed');
  return results.map((result) => result.value);
}

function trackPoolShutdown(pool) {
  const closingClients = new Set();
  const errors = [];
  const onError = (error) => errors.push(error);
  const onConnect = (client) => {
    let resolve;
    const closed = new Promise((done) => { resolve = done; });
    closingClients.add(closed);
    client.once('end', () => {
      closingClients.delete(closed);
      resolve();
    });
  };
  // Attach before the pool's first connection, including application pools.
  pool.on('connect', onConnect);
  pool.on('error', onError);
  return async () => {
    try {
      await pool.end();
      // Some pg-pool versions resolve end() while client sockets are closing.
      await Promise.all([...closingClients]);
      if (errors.length) throw new AggregateError(errors, 'Unexpected PostgreSQL pool errors');
    } finally {
      pool.off('connect', onConnect);
      pool.off('error', onError);
    }
  };
}

module.exports = { settleAll, trackPoolShutdown };
