const crypto = require('crypto');

function positiveInteger(value, fallback, name) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number < 1 || number > Number.MAX_SAFE_INTEGER / (1024 * 1024)) {
    throw new Error(`${name} phải là số nguyên dương hợp lệ.`);
  }
  return number;
}

async function ensureRateLimitSchema(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('image_drive_rate_limit_schema'))");
    await client.query(`CREATE TABLE IF NOT EXISTS image_drive.rate_limits (
      key VARCHAR(64) PRIMARY KEY,
      attempts INTEGER NOT NULL,
      reset_at TIMESTAMPTZ NOT NULL
    )`);
    await client.query('CREATE INDEX IF NOT EXISTS rate_limits_reset_idx ON image_drive.rate_limits (reset_at)');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

class PgRateLimiter {
  constructor({ pool, scope, windowMs, maxAttempts, ipMaxAttempts = maxAttempts, maxEntries = 10000 }) {
    this.pool = pool;
    this.scope = scope;
    this.windowMs = positiveInteger(windowMs, 900000, 'rate limit window');
    this.maxAttempts = positiveInteger(maxAttempts, 10, 'rate limit attempts');
    this.ipMaxAttempts = positiveInteger(ipMaxAttempts, this.maxAttempts, 'rate limit IP attempts');
    this.maxEntries = positiveInteger(maxEntries, 10000, 'rate limit entries');
  }

  async consume(req, identity) {
    const buckets = [{ value: `ip:${req.ip}`, limit: this.ipMaxAttempts }];
    if (identity !== undefined) {
      buckets.push({ value: `identity:${String(identity).trim().toLowerCase()}`, limit: this.maxAttempts });
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Keep the table bounded even when attackers rotate IPs and identities.
      // Counting and consuming are atomic across all application replicas.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('image_drive_rate_limits'))");
      await client.query('DELETE FROM image_drive.rate_limits WHERE reset_at <= clock_timestamp()');
      const keys = buckets.map(({ value }) => crypto.createHash('sha256').update(`${this.scope}:${value}`).digest('hex'));
      const existing = await client.query('SELECT key FROM image_drive.rate_limits WHERE key = ANY($1::text[])', [keys]);
      const count = await client.query('SELECT COUNT(*)::int AS total FROM image_drive.rate_limits');
      let total = count.rows[0].total;
      const existingKeys = new Set(existing.rows.map((row) => row.key));
      for (let i = 0; i < buckets.length; i += 1) {
        if (!existingKeys.has(keys[i])) {
          if (total >= this.maxEntries) {
            await client.query('COMMIT');
            return { allowed: false, retryAfterSeconds: Math.ceil(this.windowMs / 1000) };
          }
          total += 1;
        }
        const result = await client.query(
          `INSERT INTO image_drive.rate_limits (key, attempts, reset_at)
           VALUES ($1, 1, clock_timestamp() + $2 * INTERVAL '1 millisecond')
           ON CONFLICT (key) DO UPDATE
             SET attempts = LEAST(image_drive.rate_limits.attempts + 1, $3 + 1)
           RETURNING attempts, GREATEST(1, CEIL(EXTRACT(EPOCH FROM (reset_at - clock_timestamp()))))::int AS retry_after`,
          [keys[i], this.windowMs, buckets[i].limit]
        );
        if (result.rows[0].attempts > buckets[i].limit) {
          // Reject an exhausted IP before allocating any new identity buckets.
          await client.query('COMMIT');
          return { allowed: false, retryAfterSeconds: result.rows[0].retry_after };
        }
      }
      await client.query('COMMIT');
      return { allowed: true, retryAfterSeconds: 0 };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
}

module.exports = { positiveInteger, ensureRateLimitSchema, PgRateLimiter };
