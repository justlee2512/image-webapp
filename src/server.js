require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const pool = require('./db');

const app = express();
const port = Number(process.env.PORT || 3000);
const maxAccounts = Number(process.env.MAX_ACCOUNTS || 5);
const maxFileSizeMb = Number(process.env.MAX_FILE_SIZE_MB || 10);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'development-only-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE === 'true', maxAge: 1000 * 60 * 60 * 24 }
}));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxFileSizeMb * 1024 * 1024 },
  fileFilter: (_req, file, done) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    done(allowed.includes(file.mimetype) ? null : new Error('Chỉ hỗ trợ JPG, PNG, GIF và WebP.'), allowed.includes(file.mimetype));
  }
});

function authRequired(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function renderAuth(res, view, values = {}) {
  res.status(values.status || 200).render(view, { error: values.error || null, form: values.form || {}, maxAccounts });
}

app.get('/', (req, res) => res.redirect(req.session.user ? '/drive' : '/login'));
app.get('/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'ok' }); }
  catch { res.status(503).json({ status: 'unavailable' }); }
});

app.get('/register', (_req, res) => renderAuth(res, 'register'));
app.post('/register', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const form = { username, email };
  if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) return renderAuth(res, 'register', { status: 400, error: 'Tên tài khoản cần 3–30 ký tự, chỉ gồm chữ, số và dấu gạch dưới.', form });
  if (!/^\S+@\S+\.\S+$/.test(email)) return renderAuth(res, 'register', { status: 400, error: 'Email không hợp lệ.', form });
  if (password.length < 8) return renderAuth(res, 'register', { status: 400, error: 'Mật khẩu cần ít nhất 8 ký tự.', form });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('image_drive_account_limit'))");
    const count = await client.query('SELECT COUNT(*)::int AS total FROM image_drive.users');
    if (count.rows[0].total >= maxAccounts) {
      await client.query('ROLLBACK');
      return renderAuth(res, 'register', { status: 403, error: `Hệ thống đã đủ ${maxAccounts} tài khoản.`, form });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await client.query(
      'INSERT INTO image_drive.users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email',
      [username, email, passwordHash]
    );
    await client.query('COMMIT');
    req.session.user = result.rows[0];
    res.redirect('/drive');
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return renderAuth(res, 'register', { status: 409, error: 'Tên tài khoản hoặc email đã được sử dụng.', form });
    console.error(error);
    renderAuth(res, 'register', { status: 500, error: 'Không thể tạo tài khoản lúc này.', form });
  } finally { client.release(); }
});

app.get('/login', (_req, res) => renderAuth(res, 'login'));
app.post('/login', async (req, res) => {
  const identity = String(req.body.identity || '').trim();
  const password = String(req.body.password || '');
  try {
    const result = await pool.query('SELECT id, username, email, password_hash FROM image_drive.users WHERE lower(email) = lower($1) OR lower(username) = lower($1)', [identity]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) return renderAuth(res, 'login', { status: 401, error: 'Thông tin đăng nhập không đúng.', form: { identity } });
    req.session.user = { id: user.id, username: user.username, email: user.email };
    res.redirect('/drive');
  } catch (error) { console.error(error); renderAuth(res, 'login', { status: 500, error: 'Không thể đăng nhập lúc này.' }); }
});

app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

app.get('/drive', authRequired, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, original_name, mime_type, size_bytes, created_at FROM image_drive.images WHERE user_id = $1 ORDER BY created_at DESC', [req.session.user.id]);
    res.render('drive', { user: req.session.user, images: result.rows, error: req.session.error || null, success: req.session.success || null, maxFileSizeMb });
    delete req.session.error; delete req.session.success;
  } catch (error) { console.error(error); res.status(500).send('Không thể tải thư viện ảnh.'); }
});

app.post('/images', authRequired, (req, res) => {
  upload.single('image')(req, res, async (error) => {
    if (error) { req.session.error = error.code === 'LIMIT_FILE_SIZE' ? `Ảnh không được lớn hơn ${maxFileSizeMb} MB.` : error.message; return res.redirect('/drive'); }
    if (!req.file) { req.session.error = 'Vui lòng chọn một ảnh.'; return res.redirect('/drive'); }
    try {
      await pool.query('INSERT INTO image_drive.images (id, user_id, original_name, mime_type, size_bytes, image_data) VALUES ($1, $2, $3, $4, $5, $6)', [crypto.randomUUID(), req.session.user.id, req.file.originalname.slice(0, 255), req.file.mimetype, req.file.size, req.file.buffer]);
      req.session.success = 'Ảnh đã được tải lên thành công.';
    } catch (dbError) { console.error(dbError); req.session.error = 'Không thể lưu ảnh.'; }
    res.redirect('/drive');
  });
});

app.get('/images/:id', authRequired, async (req, res) => {
  const result = await pool.query('SELECT original_name, mime_type, image_data FROM image_drive.images WHERE id = $1 AND user_id = $2', [req.params.id, req.session.user.id]);
  if (!result.rows[0]) return res.sendStatus(404);
  res.set({ 'Content-Type': result.rows[0].mime_type, 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(result.rows[0].original_name)}`, 'Cache-Control': 'private, max-age=3600' });
  res.send(result.rows[0].image_data);
});

app.post('/images/:id/delete', authRequired, async (req, res) => {
  await pool.query('DELETE FROM image_drive.images WHERE id = $1 AND user_id = $2', [req.params.id, req.session.user.id]);
  req.session.success = 'Ảnh đã được xóa.';
  res.redirect('/drive');
});

app.use((_req, res) => res.status(404).send('Không tìm thấy trang.'));

app.listen(port, '0.0.0.0', () => console.log(`Image Drive running at http://localhost:${port}`));
