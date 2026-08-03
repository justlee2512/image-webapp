const session = require('express-session');

class PgSessionStore extends session.Store {
  constructor(options) {
    super();
    this.pool = options.pool;
    this.ttlMs = options.ttlMs;
    this.ready = this.createTable();

    const pruneIntervalMs = options.pruneIntervalMs || 15 * 60 * 1000;
    this.pruneTimer = setInterval(() => {
      this.prune().catch((error) => this.emit('disconnect', error));
    }, pruneIntervalMs);
    this.pruneTimer.unref();
  }

  async createTable() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('image_drive_session_schema'))");
      await client.query(`
        CREATE TABLE IF NOT EXISTS image_drive.sessions (
          sid VARCHAR(128) PRIMARY KEY,
          sess JSONB NOT NULL,
          expire TIMESTAMP WITH TIME ZONE NOT NULL
        )
      `);
      await client.query('CREATE INDEX IF NOT EXISTS sessions_expire_idx ON image_drive.sessions (expire)');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  expiration(sess) {
    const cookieExpiration = sess.cookie && sess.cookie.expires;
    const date = cookieExpiration ? new Date(cookieExpiration) : new Date(Date.now() + this.ttlMs);
    return Number.isNaN(date.getTime()) ? new Date(Date.now() + this.ttlMs) : date;
  }

  get(sid, callback) {
    this.ready
      .then(() => this.pool.query(
        'SELECT sess FROM image_drive.sessions WHERE sid = $1 AND expire > CURRENT_TIMESTAMP',
        [sid]
      ))
      .then((result) => callback(null, result.rows[0] ? result.rows[0].sess : null))
      .catch(callback);
  }

  set(sid, sess, callback = () => {}) {
    this.ready
      .then(() => this.pool.query(
        `INSERT INTO image_drive.sessions (sid, sess, expire)
         VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire`,
        [sid, JSON.stringify(sess), this.expiration(sess)]
      ))
      .then(() => callback())
      .catch(callback);
  }

  touch(sid, sess, callback = () => {}) {
    this.ready
      .then(() => this.pool.query(
        'UPDATE image_drive.sessions SET expire = $2 WHERE sid = $1',
        [sid, this.expiration(sess)]
      ))
      .then(() => callback())
      .catch(callback);
  }

  destroy(sid, callback = () => {}) {
    this.ready
      .then(() => this.pool.query('DELETE FROM image_drive.sessions WHERE sid = $1', [sid]))
      .then(() => callback())
      .catch(callback);
  }

  async prune() {
    await this.ready;
    await this.pool.query('DELETE FROM image_drive.sessions WHERE expire <= CURRENT_TIMESTAMP');
  }
}

module.exports = PgSessionStore;
