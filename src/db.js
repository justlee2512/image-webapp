const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 5),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS || 120000),
  application_name: 'richard_le_image_drive'
});

pool.on('error', (error) => {
  console.error('PostgreSQL pool error:', error);
});

module.exports = pool;
