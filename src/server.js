require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const archiver = require('archiver');
const sharp = require('sharp');
const { version: packageVersion } = require('../package.json');

const { pool, envNumber } = require('./db');
const PgSessionStore = require('./pg-session-store');
const {
  ensureAdminBootstrap,
  isAdminUser,
  validateAccountInput,
  validatePasswordChangeInput,
  normalizeIdentity
} = require('./admin');
const {
  UUID_RE,
  csrfSession,
  csrfProtection,
  sanitizeFilename,
  inspectImage,
  normalizeUuidList,
  Semaphore,
  createRateLimiter,
  requestContext
} = require('./security');

const app = express();
const port = envNumber('PORT', 3000, 1, 65535);
const maxAccounts = envNumber('MAX_ACCOUNTS', 5, 1, 10000);
const maxFileSizeMb = envNumber('MAX_FILE_SIZE_MB', 30, 1, 250);
const maxImagePixels = envNumber('MAX_IMAGE_PIXELS', 80000000, 1000000, 300000000);
const sessionTtlMs = envNumber('SESSION_IDLE_TIMEOUT_MS', 15 * 60 * 1000, 60000, 30 * 24 * 60 * 60 * 1000);
const sessionTouchAfterMs = envNumber('SESSION_TOUCH_AFTER_MS', 60000, 10000, sessionTtlMs);
const thumbnailWidth = envNumber('THUMBNAIL_WIDTH', 520, 120, 1600);
const thumbnailHeight = envNumber('THUMBNAIL_HEIGHT', 390, 120, 1600);
const thumbnailQuality = envNumber('THUMBNAIL_QUALITY', 76, 40, 95);
const maxBatchDownloadMb = envNumber('MAX_BATCH_DOWNLOAD_MB', 500, 10, 5000);
const isProduction = process.env.NODE_ENV === 'production';
const disableFrontendCache = process.env.DISABLE_FRONTEND_CACHE !== 'false';

if (isProduction && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  throw new Error('SESSION_SECRET must be configured and contain at least 32 characters in production.');
}

sharp.cache({ memory: envNumber('SHARP_CACHE_MEMORY_MB', 32, 0, 256), files: 0, items: 100 });
sharp.concurrency(envNumber('SHARP_CONCURRENCY', 2, 1, 8));

const uploadQueue = new Semaphore(
  envNumber('MAX_CONCURRENT_UPLOADS', 2, 1, 20),
  envNumber('MAX_UPLOAD_QUEUE', 25, 0, 1000)
);
const downloadQueue = new Semaphore(
  envNumber('MAX_CONCURRENT_DOWNLOADS', 4, 1, 50),
  envNumber('MAX_DOWNLOAD_QUEUE', 100, 0, 2000)
);

app.disable('x-powered-by');
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.set('query parser', 'simple');
app.locals.assetVersion = process.env.ASSET_VERSION
  || process.env.GIT_SHA
  || process.env.IMAGE_TAG
  || packageVersion;
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);

app.use(requestContext);
const contentSecurityDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'"],
  imgSrc: ["'self'", 'data:', 'blob:'],
  fontSrc: ["'self'", 'data:'],
  connectSrc: ["'self'"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  frameAncestors: ["'none'"],
  formAction: ["'self'"]
};
if (isProduction) contentSecurityDirectives.upgradeInsecureRequests = [];

app.use(helmet({
  contentSecurityPolicy: { directives: contentSecurityDirectives },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  referrerPolicy: { policy: 'no-referrer' },
  hsts: isProduction && process.env.COOKIE_SECURE === 'true'
    ? { maxAge: 31536000, includeSubDomains: true, preload: true }
    : false
}));
app.use(express.urlencoded({ extended: false, limit: '64kb', parameterLimit: 2500 }));
app.use(express.json({ limit: '64kb' }));
// Frontend files are deliberately revalidated on every page load. Image blobs keep
// their own long-lived immutable cache headers further below.
app.use('/assets', express.static(path.join(__dirname, '..', 'public'), {
  etag: !disableFrontendCache,
  maxAge: disableFrontendCache ? 0 : '1y',
  immutable: !disableFrontendCache,
  fallthrough: false,
  setHeaders: (res) => {
    res.set('X-Asset-Version', app.locals.assetVersion);
    if (disableFrontendCache) {
      res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
        Pragma: 'no-cache',
        Expires: '0',
        'Surrogate-Control': 'no-store'
      });
    }
  }
}));

// Never cache HTML/navigation responses. This prevents an old EJS page from
// continuing to reference a previous CSS/JavaScript bundle after deployment.
app.use((req, res, next) => {
  const isFrontendPage = req.method === 'GET'
    && !req.path.startsWith('/images/')
    && req.path !== '/live'
    && req.path !== '/health';
  if (isFrontendPage) {
    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
      'Surrogate-Control': 'no-store',
      'X-Frontend-Version': app.locals.assetVersion
    });
  }
  next();
});

const sessionStore = new PgSessionStore({
  pool,
  ttlMs: sessionTtlMs,
  touchAfterMs: sessionTouchAfterMs
});

// Health probes bypass session/CSRF to avoid creating database sessions.
app.get('/live', (_req, res) => res.json({ status: 'ok' }));
app.get('/health', async (_req, res) => {
  try {
    await sessionStore.ready;
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch {
    res.status(503).json({ status: 'unavailable' });
  }
});

app.use(session({
  name: 'image_drive.sid',
  secret: process.env.SESSION_SECRET || 'development-only-secret-change-before-production',
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  proxy: process.env.TRUST_PROXY === 'true',
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: sessionTtlMs,
    path: '/'
  }
}));
app.use(csrfSession);
app.use(csrfProtection);

const loginLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, limit: 8, keyPrefix: 'login' });
const registerLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, limit: 5, keyPrefix: 'register' });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: maxFileSizeMb * 1024 * 1024,
    files: 1,
    fields: 5,
    fieldSize: 4096,
    parts: 8
  },
  fileFilter: (_req, file, done) => {
    const allowed = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/octet-stream']);
    if (!allowed.has(file.mimetype)) return done(new Error('Chỉ hỗ trợ JPG, PNG, GIF và WebP.'));
    done(null, true);
  }
});

function logError(error, req, context) {
  console.error(JSON.stringify({
    level: 'error',
    requestId: req && req.id,
    context,
    message: error && error.message,
    code: error && error.code,
    stack: isProduction ? undefined : error && error.stack
  }));
}

function setFlash(req, type, message) {
  req.session[type] = message;
}

function clearFlash(req) {
  delete req.session.error;
  delete req.session.success;
}

function driveUrl(folderId) {
  return folderId && UUID_RE.test(String(folderId))
    ? `/drive?folder=${encodeURIComponent(folderId)}`
    : '/drive';
}

function safeReturnPath(req, fallback) {
  const referer = req.get('referer');
  if (!referer) return fallback;
  try {
    const parsed = new URL(referer);
    const currentOrigin = `${req.protocol}://${req.get('host')}`;
    const candidate = `${parsed.pathname}${parsed.search}`;
    if (parsed.origin !== currentOrigin || candidate === req.originalUrl) return fallback;
    if (candidate.startsWith('/assets/') || candidate.startsWith('/images/')) return fallback;
    return candidate;
  } catch {
    return fallback;
  }
}

function redirectWithToast(req, res, message, fallback) {
  try {
    setFlash(req, 'error', message);
  } catch {
    return res.status(500).send(message);
  }
  return res.redirect(303, safeReturnPath(req, fallback));
}

function wantsJson(req) {
  return req.get('x-requested-with') === 'XMLHttpRequest' || req.accepts(['html', 'json']) === 'json';
}

function sendActionResponse(req, res, ok, message, redirectTo = '/drive', extra = {}) {
  if (wantsJson(req)) return res.status(ok ? 200 : 400).json({ ok, message, redirect: redirectTo, ...extra });
  setFlash(req, ok ? 'success' : 'error', message);
  return res.redirect(redirectTo);
}

function authRequired(req, res, next) {
  if (!req.session.user) {
    const message = 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.';
    if (wantsJson(req)) return res.status(401).json({ ok: false, message });
    setFlash(req, 'error', message);
    return res.redirect('/login');
  }
  res.locals.user = req.session.user;
  next();
}

function adminRequired(req, res, next) {
  if (isAdminUser(req.session.user)) return next();
  if (wantsJson(req)) return res.status(403).json({ ok: false, message: 'Bạn không có quyền quản trị.' });
  setFlash(req, 'error', 'Bạn không có quyền quản trị.');
  return res.redirect('/drive');
}

function renderAuth(res, view, values = {}) {
  res.set('Cache-Control', 'no-store');
  res.status(values.status || 200).render(view, {
    error: values.error || null,
    form: values.form || {},
    maxAccounts,
    csrfToken: res.locals.csrfToken,
    assetVersion: app.locals.assetVersion
  });
}

async function establishSession(req, user) {
  await new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
  req.session.user = {
    id: user.id,
    username: user.username,
    email: user.email,
    is_admin: Boolean(user.is_admin)
  };
  req.session.csrfToken = crypto.randomBytes(32).toString('base64url');
}

async function getFolderAccess(folderId, userId, admin = false) {
  if (!folderId) return { isOwner: true, folder: null };
  if (!UUID_RE.test(String(folderId))) return null;
  const result = await pool.query(
    `SELECT f.id, f.name, f.owner_id, u.username AS owner_name,
            (f.owner_id = $2 OR $3) AS is_owner
       FROM image_drive.folders f
       JOIN image_drive.users u ON u.id = f.owner_id
      WHERE f.id = $1
        AND ($3 OR f.owner_id = $2 OR EXISTS (
          SELECT 1 FROM image_drive.folder_shares s
           WHERE s.folder_id = f.id AND s.user_id = $2
        ))`,
    [folderId, userId, admin]
  );
  const folder = result.rows[0];
  return folder ? { isOwner: Boolean(folder.is_owner), folder } : null;
}

function imageAccessWhere() {
  return `i.id = $1 AND ($3 OR i.user_id = $2 OR EXISTS (
    SELECT 1 FROM image_drive.folder_shares s
     WHERE s.folder_id = i.folder_id AND s.user_id = $2
  ))`;
}

app.get('/', (req, res) => res.redirect(req.session.user ? '/drive' : '/login'));

app.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/drive');
  const error = req.session.error || null;
  clearFlash(req);
  return renderAuth(res, 'register', { error });
});
app.post('/register', registerLimiter, async (req, res) => {
  const form = {
    username: String(req.body.username || '').trim(),
    email: normalizeIdentity(req.body.email)
  };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('image_drive_account_limit_v2'))");
    const countResult = await client.query('SELECT COUNT(*)::int AS total FROM image_drive.users');
    const validation = validateAccountInput(req.body, {
      maxAccounts,
      currentCount: countResult.rows[0].total,
      isAdmin: false
    });
    if (!validation.ok) {
      await client.query('ROLLBACK');
      if (wantsJson(req)) return res.status(400).json({ ok: false, message: validation.error });
      return renderAuth(res, 'register', { status: 400, error: validation.error, form });
    }
    const passwordHash = await bcrypt.hash(String(req.body.password), 12);
    const result = await client.query(
      `INSERT INTO image_drive.users (username, email, password_hash, is_admin)
       VALUES ($1, $2, $3, FALSE)
       RETURNING id, username, email, is_admin`,
      [form.username, form.email, passwordHash]
    );
    await client.query('COMMIT');
    await establishSession(req, result.rows[0]);
    if (wantsJson(req)) return res.json({ ok: true, message: 'Tạo tài khoản thành công.', redirect: '/drive' });
    res.redirect('/drive');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') {
      if (wantsJson(req)) return res.status(409).json({ ok: false, message: 'Tên tài khoản hoặc email đã được sử dụng.' });
      return renderAuth(res, 'register', { status: 409, error: 'Tên tài khoản hoặc email đã được sử dụng.', form });
    }
    logError(error, req, 'register');
    if (wantsJson(req)) return res.status(500).json({ ok: false, message: 'Không thể tạo tài khoản lúc này.' });
    return renderAuth(res, 'register', { status: 500, error: 'Không thể tạo tài khoản lúc này.', form });
  } finally {
    client.release();
  }
});

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/drive');
  const error = req.session.error || null;
  clearFlash(req);
  return renderAuth(res, 'login', { error });
});
app.post('/login', loginLimiter, async (req, res) => {
  const identity = String(req.body.identity || '').trim();
  const password = String(req.body.password || '');
  try {
    const result = await pool.query(
      `SELECT id, username, email, password_hash, is_admin
         FROM image_drive.users
        WHERE lower(email) = lower($1) OR lower(username) = lower($1)
        LIMIT 1`,
      [identity]
    );
    const user = result.rows[0];
    const valid = user ? await bcrypt.compare(password, user.password_hash) : await bcrypt.compare(password, '$2b$12$Jq7lHfXlL7V5PzPX7Wd0XuB2W6JsT3EboVdVkVb4VfMZLJTLJ4TAi');
    if (!user || !valid) {
      if (wantsJson(req)) return res.status(401).json({ ok: false, message: 'Thông tin đăng nhập không đúng.' });
      return renderAuth(res, 'login', { status: 401, error: 'Thông tin đăng nhập không đúng.', form: { identity } });
    }
    await establishSession(req, user);
    if (wantsJson(req)) return res.json({ ok: true, message: 'Đăng nhập thành công.', redirect: '/drive' });
    res.redirect('/drive');
  } catch (error) {
    logError(error, req, 'login');
    if (wantsJson(req)) return res.status(500).json({ ok: false, message: 'Không thể đăng nhập lúc này.' });
    renderAuth(res, 'login', { status: 500, error: 'Không thể đăng nhập lúc này.', form: { identity } });
  }
});

app.post('/logout', authRequired, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('image_drive.sid', { path: '/' });
    res.redirect('/login');
  });
});

app.get('/admin/users', authRequired, adminRequired, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, email, is_admin, created_at FROM image_drive.users ORDER BY is_admin DESC, username'
    );
    res.set('Cache-Control', 'no-store');
    res.render('admin-users', {
      user: req.session.user,
      users: result.rows,
      error: req.session.error || null,
      success: req.session.success || null,
      maxAccounts,
      csrfToken: res.locals.csrfToken,
      assetVersion: app.locals.assetVersion
    });
    clearFlash(req);
  } catch (error) {
    logError(error, req, 'admin-users-list');
    res.status(500).send('Không thể tải danh sách tài khoản.');
  }
});

app.post('/admin/users', authRequired, adminRequired, async (req, res) => {
  try {
    const currentCount = await pool.query('SELECT COUNT(*)::int AS total FROM image_drive.users');
    const validation = validateAccountInput(req.body, {
      maxAccounts,
      currentCount: currentCount.rows[0].total,
      isAdmin: true
    });
    if (!validation.ok) {
      return sendActionResponse(req, res, false, validation.error, '/admin/users');
    }
    const passwordHash = await bcrypt.hash(String(req.body.password), 12);
    await pool.query(
      `INSERT INTO image_drive.users (username, email, password_hash, is_admin)
       VALUES ($1, $2, $3, FALSE)`,
      [String(req.body.username).trim(), normalizeIdentity(req.body.email), passwordHash]
    );
    return sendActionResponse(req, res, true, `Đã tạo tài khoản ${String(req.body.username).trim()}.`, '/admin/users');
  } catch (error) {
    logError(error, req, 'admin-user-create');
    return sendActionResponse(req, res, false, error.code === '23505' ? 'Tên tài khoản hoặc email đã được sử dụng.' : 'Không thể tạo tài khoản.', '/admin/users');
  }
});

app.post('/admin/users/:id/delete', authRequired, adminRequired, async (req, res) => {
  if (String(req.params.id) === String(req.session.user.id)) {
    return sendActionResponse(req, res, false, 'Bạn không thể tự xóa tài khoản của chính mình.', '/admin/users');
  }
  try {
    await pool.query("DELETE FROM image_drive.sessions WHERE sess #>> '{user,id}' = $1", [String(req.params.id)]);
    const result = await pool.query('DELETE FROM image_drive.users WHERE id = $1 RETURNING id', [req.params.id]);
    return sendActionResponse(req, res, Boolean(result.rowCount), result.rowCount ? 'Đã xóa tài khoản.' : 'Không tìm thấy tài khoản.', '/admin/users');
  } catch (error) {
    logError(error, req, 'admin-user-delete');
    return sendActionResponse(req, res, false, 'Không thể xóa tài khoản.', '/admin/users');
  }
});

app.post('/admin/users/:id/reset-password', authRequired, adminRequired, async (req, res) => {
  const validation = validatePasswordChangeInput(req.body);
  if (!validation.ok) {
    return sendActionResponse(req, res, false, validation.error, '/admin/users');
  }
  try {
    const passwordHash = await bcrypt.hash(String(req.body.newPassword), 12);
    const result = await pool.query('UPDATE image_drive.users SET password_hash = $1 WHERE id = $2 RETURNING id', [passwordHash, req.params.id]);
    if (!result.rowCount) return sendActionResponse(req, res, false, 'Không tìm thấy tài khoản.', '/admin/users');
    await pool.query("DELETE FROM image_drive.sessions WHERE sess #>> '{user,id}' = $1", [String(req.params.id)]);
    return sendActionResponse(req, res, true, 'Đã đổi mật khẩu và đăng xuất các phiên cũ của tài khoản.', '/admin/users');
  } catch (error) {
    logError(error, req, 'admin-password-reset');
    return sendActionResponse(req, res, false, 'Không thể đổi mật khẩu.', '/admin/users');
  }
});

app.get('/drive', authRequired, async (req, res) => {
  try {
    const admin = isAdminUser(req.session.user);
    const folderId = req.query.folder ? String(req.query.folder) : null;
    const access = await getFolderAccess(folderId, req.session.user.id, admin);
    if (!access) {
      if (wantsJson(req)) return res.status(403).json({ ok: false, message: 'Folder không tồn tại hoặc bạn không được phép truy cập.' });
      setFlash(req, 'error', 'Folder không tồn tại hoặc bạn không được phép truy cập.');
      return res.redirect('/drive');
    }

    const imagesPromise = folderId
      ? pool.query(
          `SELECT id, original_name, mime_type, size_bytes, width, height, created_at, user_id
             FROM image_drive.images
            WHERE folder_id = $1
            ORDER BY created_at DESC`,
          [folderId]
        )
      : pool.query(
          admin
            ? `SELECT id, original_name, mime_type, size_bytes, width, height, created_at, user_id
                 FROM image_drive.images WHERE folder_id IS NULL ORDER BY created_at DESC`
            : `SELECT id, original_name, mime_type, size_bytes, width, height, created_at, user_id
                 FROM image_drive.images WHERE user_id = $1 AND folder_id IS NULL ORDER BY created_at DESC`,
          admin ? [] : [req.session.user.id]
        );

    const foldersPromise = pool.query(
      admin
        ? `SELECT f.id, f.name, f.owner_id, u.username AS owner_name, TRUE AS is_owner,
                  (SELECT COUNT(*)::int FROM image_drive.images i WHERE i.folder_id = f.id) AS image_count
             FROM image_drive.folders f
             JOIN image_drive.users u ON u.id = f.owner_id
            ORDER BY lower(f.name), f.created_at DESC`
        : `SELECT f.id, f.name, f.owner_id, u.username AS owner_name,
                  (f.owner_id = $1) AS is_owner,
                  (SELECT COUNT(*)::int FROM image_drive.images i WHERE i.folder_id = f.id) AS image_count
             FROM image_drive.folders f
             JOIN image_drive.users u ON u.id = f.owner_id
            WHERE f.owner_id = $1 OR EXISTS (
              SELECT 1 FROM image_drive.folder_shares s WHERE s.folder_id = f.id AND s.user_id = $1
            )
            ORDER BY is_owner DESC, lower(f.name), f.created_at DESC`,
      admin ? [] : [req.session.user.id]
    );

    const sharesPromise = folderId && access.isOwner
      ? pool.query(
          `SELECT u.id, u.username, u.email
             FROM image_drive.folder_shares s
             JOIN image_drive.users u ON u.id = s.user_id
            WHERE s.folder_id = $1 ORDER BY lower(u.username)`,
          [folderId]
        )
      : Promise.resolve({ rows: [] });

    const [imagesResult, foldersResult, sharesResult] = await Promise.all([imagesPromise, foldersPromise, sharesPromise]);
    res.set('Cache-Control', 'private, no-store');
    res.render('drive', {
      user: req.session.user,
      images: imagesResult.rows,
      folders: foldersResult.rows,
      currentFolder: access.folder,
      isOwner: access.isOwner,
      sharedUsers: sharesResult.rows,
      error: req.session.error || null,
      success: req.session.success || null,
      maxFileSizeMb,
      isAdmin: admin,
      csrfToken: res.locals.csrfToken,
      assetVersion: app.locals.assetVersion
    });
    clearFlash(req);
  } catch (error) {
    logError(error, req, 'drive');
    res.status(500).send('Không thể tải thư viện ảnh.');
  }
});

app.post('/folders', authRequired, async (req, res) => {
  const name = String(req.body.name || '').trim().normalize('NFKC');
  if (!name || name.length > 100) return sendActionResponse(req, res, false, 'Tên folder cần từ 1 đến 100 ký tự.');
  try {
    await pool.query(
      'INSERT INTO image_drive.folders (id, owner_id, name) VALUES ($1, $2, $3)',
      [crypto.randomUUID(), req.session.user.id, name]
    );
    return sendActionResponse(req, res, true, 'Đã tạo folder mới.');
  } catch (error) {
    logError(error, req, 'folder-create');
    return sendActionResponse(req, res, false, error.code === '23505' ? 'Bạn đã có folder với tên này.' : 'Không thể tạo folder.');
  }
});

app.post('/folders/:id/delete', authRequired, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return sendActionResponse(req, res, false, 'Folder không hợp lệ.');
  try {
    const admin = isAdminUser(req.session.user);
    const result = await pool.query(
      'DELETE FROM image_drive.folders WHERE id = $1 AND ($2 OR owner_id = $3) RETURNING id',
      [req.params.id, admin, req.session.user.id]
    );
    return sendActionResponse(req, res, result.rowCount > 0, result.rowCount ? 'Đã xóa folder và toàn bộ ảnh bên trong.' : 'Bạn không có quyền xóa folder này.');
  } catch (error) {
    logError(error, req, 'folder-delete');
    return sendActionResponse(req, res, false, 'Không thể xóa folder.');
  }
});

app.post('/folders/:id/share', authRequired, async (req, res) => {
  const identity = String(req.body.identity || '').trim();
  if (!UUID_RE.test(req.params.id) || !identity) return sendActionResponse(req, res, false, 'Thông tin chia sẻ không hợp lệ.', driveUrl(req.params.id));
  const admin = isAdminUser(req.session.user);
  try {
    const folder = await pool.query('SELECT id, owner_id FROM image_drive.folders WHERE id = $1 AND ($2 OR owner_id = $3)', [req.params.id, admin, req.session.user.id]);
    if (!folder.rowCount) return sendActionResponse(req, res, false, 'Bạn không có quyền chia sẻ folder này.', driveUrl(req.params.id));
    const target = await pool.query(
      `SELECT id FROM image_drive.users
        WHERE (lower(username) = lower($1) OR lower(email) = lower($1))
          AND id <> $2 AND id <> $3
        LIMIT 1`,
      [identity, req.session.user.id, folder.rows[0].owner_id]
    );
    if (!target.rowCount) return sendActionResponse(req, res, false, 'Không tìm thấy tài khoản phù hợp để chia sẻ.', driveUrl(req.params.id));
    await pool.query(
      `INSERT INTO image_drive.folder_shares (folder_id, user_id, shared_by)
       VALUES ($1, $2, $3) ON CONFLICT (folder_id, user_id) DO NOTHING`,
      [req.params.id, target.rows[0].id, req.session.user.id]
    );
    return sendActionResponse(req, res, true, 'Đã chia sẻ folder.', driveUrl(req.params.id));
  } catch (error) {
    logError(error, req, 'folder-share');
    return sendActionResponse(req, res, false, 'Không thể chia sẻ folder.', driveUrl(req.params.id));
  }
});

app.post('/folders/:id/unshare', authRequired, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return sendActionResponse(req, res, false, 'Folder không hợp lệ.');
  const admin = isAdminUser(req.session.user);
  try {
    await pool.query(
      `DELETE FROM image_drive.folder_shares s USING image_drive.folders f
        WHERE s.folder_id = f.id AND s.folder_id = $1 AND s.user_id = $2
          AND ($3 OR f.owner_id = $4)`,
      [req.params.id, req.body.userId, admin, req.session.user.id]
    );
    return sendActionResponse(req, res, true, 'Đã thu hồi quyền chia sẻ.', driveUrl(req.params.id));
  } catch (error) {
    logError(error, req, 'folder-unshare');
    return sendActionResponse(req, res, false, 'Không thể thu hồi quyền chia sẻ.', driveUrl(req.params.id));
  }
});

app.post('/images/move', authRequired, async (req, res) => {
  const ids = normalizeUuidList(req.body.imageIds, 1000);
  const targetFolderId = req.body.targetFolderId ? String(req.body.targetFolderId) : null;
  const currentFolderId = req.body.currentFolderId ? String(req.body.currentFolderId) : null;
  if (!ids.length) return sendActionResponse(req, res, false, 'Vui lòng chọn ảnh cần di chuyển.', driveUrl(currentFolderId));
  if (targetFolderId && !UUID_RE.test(targetFolderId)) return sendActionResponse(req, res, false, 'Folder đích không hợp lệ.', driveUrl(currentFolderId));
  const admin = isAdminUser(req.session.user);
  try {
    if (targetFolderId) {
      const folder = await pool.query('SELECT id FROM image_drive.folders WHERE id = $1 AND ($2 OR owner_id = $3)', [targetFolderId, admin, req.session.user.id]);
      if (!folder.rowCount) return sendActionResponse(req, res, false, 'Bạn không có quyền chuyển ảnh vào folder này.', driveUrl(currentFolderId));
    }
    const result = await pool.query(
      'UPDATE image_drive.images SET folder_id = $1 WHERE id = ANY($2::uuid[]) AND ($3 OR user_id = $4) RETURNING id',
      [targetFolderId, ids, admin, req.session.user.id]
    );
    return sendActionResponse(req, res, true, `Đã chuyển ${result.rowCount} ảnh.`, driveUrl(currentFolderId), { moved: result.rowCount });
  } catch (error) {
    logError(error, req, 'images-move');
    return sendActionResponse(req, res, false, 'Không thể di chuyển ảnh.', driveUrl(currentFolderId));
  }
});

app.post('/images', authRequired, async (req, res, next) => {
  let releaseUpload;
  try {
    releaseUpload = await uploadQueue.acquire();
  } catch (error) {
    return res.status(error.status || 503).json({ ok: false, message: error.message });
  }

  upload.fields([{ name: 'image', maxCount: 1 }, { name: 'images', maxCount: 1 }])(req, res, async (uploadError) => {
    const finish = (status, payload) => {
      releaseUpload();
      if (req.get('x-upload-queue') === 'sequential' || wantsJson(req)) return res.status(status).json(payload);
      setFlash(req, payload.ok ? 'success' : 'error', payload.message);
      return res.redirect(driveUrl(req.body && req.body.folderId));
    };

    if (uploadError) {
      const message = uploadError.code === 'LIMIT_FILE_SIZE'
        ? `Mỗi ảnh không được lớn hơn ${maxFileSizeMb} MB.`
        : uploadError.message || 'Không thể nhận tệp tải lên.';
      return finish(400, { ok: false, message });
    }

    const uploadedFile = req.files && ((req.files.image && req.files.image[0]) || (req.files.images && req.files.images[0]));
    const folderId = req.body && req.body.folderId ? String(req.body.folderId) : null;
    if (!uploadedFile) return finish(400, { ok: false, message: 'Server không nhận được dữ liệu ảnh.' });
    if (folderId && !UUID_RE.test(folderId)) return finish(400, { ok: false, message: 'Folder không hợp lệ.' });

    try {
      const admin = isAdminUser(req.session.user);
      const access = await getFolderAccess(folderId, req.session.user.id, admin);
      if (!access || (!access.isOwner && !admin)) return finish(403, { ok: false, message: 'Bạn không có quyền tải ảnh vào folder này.' });

      const inspection = await inspectImage(uploadedFile.buffer, maxImagePixels);
      const [thumbnail, hash] = await Promise.all([
        sharp(uploadedFile.buffer, { failOn: 'error', animated: false, limitInputPixels: maxImagePixels })
          .rotate()
          .resize({ width: thumbnailWidth, height: thumbnailHeight, fit: 'cover', position: 'attention', withoutEnlargement: true })
          .webp({ quality: thumbnailQuality, effort: 4 })
          .toBuffer(),
        Promise.resolve(crypto.createHash('sha256').update(uploadedFile.buffer).digest('hex'))
      ]);

      const id = crypto.randomUUID();
      await pool.query(
        `INSERT INTO image_drive.images
          (id, user_id, folder_id, original_name, mime_type, size_bytes, width, height, content_sha256, image_data, thumbnail_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          id,
          req.session.user.id,
          folderId,
          sanitizeFilename(uploadedFile.originalname),
          inspection.mime,
          uploadedFile.size,
          inspection.width,
          inspection.height,
          hash,
          uploadedFile.buffer,
          thumbnail
        ]
      );
      return finish(201, { ok: true, message: 'Đã tải lên 1 ảnh.', imageId: id });
    } catch (error) {
      logError(error, req, 'image-upload');
      const safeMessage = /ảnh|tệp|định dạng|kích thước|độ phân giải/i.test(error.message)
        ? error.message
        : 'Không thể xử lý hoặc lưu ảnh.';
      return finish(400, { ok: false, message: safeMessage });
    }
  });
});

app.get('/images/:id/thumbnail', authRequired, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.sendStatus(404);
  let release;
  try {
    release = await downloadQueue.acquire();
    const admin = isAdminUser(req.session.user);
    let result = await pool.query(
      `SELECT i.thumbnail_data FROM image_drive.images i WHERE ${imageAccessWhere()}`,
      [req.params.id, req.session.user.id, admin]
    );
    const image = result.rows[0];
    if (!image) return res.sendStatus(404);
    let thumbnail = image.thumbnail_data;
    if (!thumbnail) {
      result = await pool.query(
        `SELECT i.image_data FROM image_drive.images i WHERE ${imageAccessWhere()}`,
        [req.params.id, req.session.user.id, admin]
      );
      if (!result.rows[0]) return res.sendStatus(404);
      thumbnail = await sharp(result.rows[0].image_data, { failOn: 'error', animated: false, limitInputPixels: maxImagePixels })
        .rotate()
        .resize({ width: thumbnailWidth, height: thumbnailHeight, fit: 'cover', position: 'attention', withoutEnlargement: true })
        .webp({ quality: thumbnailQuality, effort: 4 })
        .toBuffer();
      await pool.query('UPDATE image_drive.images SET thumbnail_data = $1 WHERE id = $2 AND thumbnail_data IS NULL', [thumbnail, req.params.id]);
    }
    const etag = `"thumb-${req.params.id}"`;
    if (req.get('if-none-match') === etag) return res.status(304).end();
    res.set({
      'Content-Type': 'image/webp',
      'Content-Length': String(thumbnail.length),
      'Cache-Control': 'private, max-age=31536000, immutable',
      ETag: etag,
      'X-Content-Type-Options': 'nosniff'
    });
    res.send(thumbnail);
  } catch (error) {
    logError(error, req, 'image-thumbnail');
    if (!res.headersSent) res.sendStatus(error.status || 500);
  } finally {
    if (release) release();
  }
});

async function sendImage(req, res, disposition) {
  if (!UUID_RE.test(req.params.id)) {
    if (wantsJson(req)) return res.status(404).json({ ok: false, message: 'Ảnh không hợp lệ.' });
    return res.sendStatus(404);
  }
  let release;
  try {
    release = await downloadQueue.acquire();
    const admin = isAdminUser(req.session.user);
    const result = await pool.query(
      `SELECT i.original_name, i.mime_type, i.size_bytes, i.content_sha256, i.image_data
         FROM image_drive.images i WHERE ${imageAccessWhere()}`,
      [req.params.id, req.session.user.id, admin]
    );
    const image = result.rows[0];
    if (!image) {
      if (wantsJson(req)) return res.status(404).json({ ok: false, message: 'Không tìm thấy ảnh hoặc bạn không có quyền tải.' });
      return res.sendStatus(404);
    }
    const hash = image.content_sha256 || crypto.createHash('sha256').update(image.image_data).digest('hex');
    if (!image.content_sha256) pool.query('UPDATE image_drive.images SET content_sha256 = $1 WHERE id = $2 AND content_sha256 IS NULL', [hash, req.params.id]).catch(() => {});
    const etag = `"sha256-${hash}"`;
    if (req.get('if-none-match') === etag && disposition === 'inline') return res.status(304).end();
    res.set({
      'Content-Type': image.mime_type,
      'Content-Length': String(image.size_bytes),
      'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(sanitizeFilename(image.original_name))}`,
      'Cache-Control': disposition === 'inline' ? 'private, max-age=31536000, immutable' : 'private, no-store',
      ETag: etag,
      'X-Content-Type-Options': 'nosniff'
    });
    res.send(image.image_data);
  } catch (error) {
    logError(error, req, `image-${disposition}`);
    if (!res.headersSent) {
      if (wantsJson(req)) return res.status(error.status || 500).json({ ok: false, message: 'Không thể tải ảnh.' });
      res.status(error.status || 500).send('Không thể tải ảnh.');
    }
  } finally {
    if (release) release();
  }
}

app.get('/images/:id', authRequired, (req, res) => sendImage(req, res, 'inline'));
app.get('/images/:id/download', authRequired, (req, res) => sendImage(req, res, 'attachment'));

app.post('/images/download-batch', authRequired, async (req, res) => {
  const ids = normalizeUuidList(req.body.imageIds, 100);
  if (!ids.length) {
    if (wantsJson(req)) return res.status(400).json({ ok: false, message: 'Vui lòng chọn từ 1 đến 100 ảnh.' });
    return res.status(400).send('Vui lòng chọn từ 1 đến 100 ảnh.');
  }
  let release;
  try {
    release = await downloadQueue.acquire();
    const admin = isAdminUser(req.session.user);
    const result = await pool.query(
      `SELECT i.id, i.original_name, i.size_bytes
         FROM image_drive.images i
        WHERE i.id = ANY($1::uuid[]) AND ($3 OR i.user_id = $2 OR EXISTS (
          SELECT 1 FROM image_drive.folder_shares s WHERE s.folder_id = i.folder_id AND s.user_id = $2
        ))
        ORDER BY i.created_at`,
      [ids, req.session.user.id, admin]
    );
    if (!result.rowCount) {
      if (wantsJson(req)) return res.status(404).json({ ok: false, message: 'Không tìm thấy ảnh hoặc bạn không có quyền tải.' });
      return res.status(404).send('Không tìm thấy ảnh có quyền tải.');
    }
    const totalBytes = result.rows.reduce((sum, image) => sum + Number(image.size_bytes || 0), 0);
    if (totalBytes > maxBatchDownloadMb * 1024 * 1024) {
      const message = `Tổng dung lượng vượt quá ${maxBatchDownloadMb} MB. Hãy chọn ít ảnh hơn.`;
      if (wantsJson(req)) return res.status(413).json({ ok: false, message });
      return res.status(413).send(message);
    }

    res.set('Cache-Control', 'private, no-store');
    res.attachment(`richard-le-images-${Date.now()}.zip`);
    const archive = archiver('zip', { zlib: { level: 4 } });
    archive.on('warning', (error) => logError(error, req, 'zip-warning'));
    archive.on('error', (error) => res.destroy(error));
    archive.pipe(res);

    const usedNames = new Map();
    for (const image of result.rows) {
      const safeName = sanitizeFilename(image.original_name);
      const count = usedNames.get(safeName) || 0;
      usedNames.set(safeName, count + 1);
      const zipName = count ? `${count + 1}-${safeName}` : safeName;
      const blob = await pool.query('SELECT image_data FROM image_drive.images WHERE id = $1', [image.id]);
      if (blob.rows[0]) {
        await new Promise((resolve, reject) => {
          const onEntry = () => {
            archive.off('error', onError);
            resolve();
          };
          const onError = (archiveError) => {
            archive.off('entry', onEntry);
            reject(archiveError);
          };
          archive.once('entry', onEntry);
          archive.once('error', onError);
          archive.append(blob.rows[0].image_data, { name: zipName, store: false });
        });
      }
    }
    await archive.finalize();
  } catch (error) {
    logError(error, req, 'download-batch');
    if (!res.headersSent) {
      if (wantsJson(req)) return res.status(error.status || 500).json({ ok: false, message: 'Không thể tạo file ZIP.' });
      res.status(error.status || 500).send('Không thể tạo file ZIP.');
    }
  } finally {
    if (release) release();
  }
});

app.post('/images/delete-batch', authRequired, async (req, res) => {
  const ids = normalizeUuidList(req.body.imageIds, 1000);
  const folderId = req.body.folderId ? String(req.body.folderId) : null;
  if (!ids.length) return sendActionResponse(req, res, false, 'Vui lòng chọn ít nhất một ảnh để xóa.', driveUrl(folderId));
  try {
    const admin = isAdminUser(req.session.user);
    const result = await pool.query(
      'DELETE FROM image_drive.images WHERE id = ANY($1::uuid[]) AND ($3 OR user_id = $2) RETURNING id',
      [ids, req.session.user.id, admin]
    );
    return sendActionResponse(req, res, true, `Đã xóa ${result.rowCount} ảnh.`, driveUrl(folderId), { deleted: result.rowCount });
  } catch (error) {
    logError(error, req, 'delete-batch');
    return sendActionResponse(req, res, false, 'Không thể xóa các ảnh đã chọn.', driveUrl(folderId));
  }
});

app.post('/images/delete-all', authRequired, async (req, res) => {
  const folderId = req.body.folderId ? String(req.body.folderId) : null;
  const admin = isAdminUser(req.session.user);
  try {
    if (folderId) {
      const access = await getFolderAccess(folderId, req.session.user.id, admin);
      if (!access || (!access.isOwner && !admin)) {
        return sendActionResponse(req, res, false, 'Bạn không có quyền xóa ảnh trong folder này.', driveUrl(folderId));
      }
    }
    const result = folderId
      ? await pool.query('DELETE FROM image_drive.images WHERE ($2 OR user_id = $1) AND folder_id = $3 RETURNING id', [req.session.user.id, admin, folderId])
      : await pool.query('DELETE FROM image_drive.images WHERE ($2 OR user_id = $1) AND folder_id IS NULL RETURNING id', [req.session.user.id, admin]);
    return sendActionResponse(req, res, true, `Đã xóa toàn bộ ${result.rowCount} ảnh trong thư mục hiện tại.`, driveUrl(folderId));
  } catch (error) {
    logError(error, req, 'delete-all');
    return sendActionResponse(req, res, false, 'Không thể xóa toàn bộ ảnh.', driveUrl(folderId));
  }
});

app.post('/images/:id/delete', authRequired, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return sendActionResponse(req, res, false, 'Ảnh không hợp lệ.');
  try {
    const admin = isAdminUser(req.session.user);
    const result = await pool.query(
      'DELETE FROM image_drive.images WHERE id = $1 AND ($3 OR user_id = $2) RETURNING folder_id',
      [req.params.id, req.session.user.id, admin]
    );
    if (!result.rowCount) return sendActionResponse(req, res, false, 'Không tìm thấy ảnh hoặc bạn không có quyền xóa.');
    return sendActionResponse(req, res, true, 'Ảnh đã được xóa.', driveUrl(result.rows[0].folder_id));
  } catch (error) {
    logError(error, req, 'image-delete');
    return sendActionResponse(req, res, false, 'Không thể xóa ảnh.');
  }
});

app.use((req, res) => {
  if (req.path.startsWith('/assets/')) return res.sendStatus(404);
  const message = 'Không tìm thấy nội dung yêu cầu.';
  if (wantsJson(req)) return res.status(404).json({ ok: false, message });
  return redirectWithToast(req, res, message, req.session && req.session.user ? '/drive' : '/login');
});

app.use((error, req, res, _next) => {
  logError(error, req, 'unhandled');
  if (res.headersSent) return res.end();
  const status = Number(error.status) >= 400 && Number(error.status) < 600 ? Number(error.status) : 500;
  const message = status === 500
    ? `Đã xảy ra lỗi hệ thống. Mã yêu cầu: ${req.id}`
    : (error.message || 'Không thể hoàn thành yêu cầu.');
  if (wantsJson(req)) return res.status(status).json({ ok: false, message, requestId: req.id });
  if (req.path.startsWith('/assets/') || req.path.startsWith('/images/')) return res.status(status).send(message);
  return redirectWithToast(req, res, message, req.session && req.session.user ? '/drive' : '/login');
});

let server;
async function start() {
  await sessionStore.ready;
  const admin = await ensureAdminBootstrap(pool);
  console.log(`Admin bootstrap ready: ${admin.username} (${admin.email})`);
  server = app.listen(port, '0.0.0.0', () => console.log(`Image Drive v2 running on port ${port}`));
  server.requestTimeout = envNumber('HTTP_REQUEST_TIMEOUT_MS', 180000, 10000, 600000);
  server.headersTimeout = envNumber('HTTP_HEADERS_TIMEOUT_MS', 65000, 10000, 120000);
  server.keepAliveTimeout = envNumber('HTTP_KEEPALIVE_TIMEOUT_MS', 5000, 1000, 60000);
}

async function shutdown(signal) {
  console.log(`${signal} received, shutting down.`);
  const forceTimer = setTimeout(() => process.exit(1), 15000);
  forceTimer.unref();
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
  clearTimeout(forceTimer);
}

if (require.main === module) {
  start().catch((error) => {
    console.error('Application startup failed:', error);
    process.exitCode = 1;
  });
  process.once('SIGTERM', () => shutdown('SIGTERM').catch(() => process.exit(1)));
  process.once('SIGINT', () => shutdown('SIGINT').catch(() => process.exit(1)));
}

module.exports = { app, start, shutdown };
