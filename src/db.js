const { Pool } = require('pg');

function envNumber(name, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: envNumber('DB_POOL_MAX', 5, 1, 50),
  idleTimeoutMillis: envNumber('DB_IDLE_TIMEOUT_MS', 30000, 1000),
  connectionTimeoutMillis: envNumber('DB_CONNECTION_TIMEOUT_MS', 10000, 1000),
  statement_timeout: envNumber('DB_STATEMENT_TIMEOUT_MS', 60000, 1000),
  query_timeout: envNumber('DB_QUERY_TIMEOUT_MS', 65000, 1000),
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  application_name: 'richard_le_image_drive_v2'
});

pool.on('connect', (client) => {
  client.query("SET TIME ZONE 'UTC'").catch((error) => {
    console.error('Unable to set PostgreSQL timezone:', error.message);
  });
});

pool.on('error', (error) => {
  console.error('Unexpected PostgreSQL pool error:', error);
});

module.exports = { pool, envNumber };
