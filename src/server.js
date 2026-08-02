require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const archiver = require('archiver');
const pool = require('./db');

const app = express();
const port = Number(process.env.PORT || 3000);
const maxAccounts = Number(process.env.MAX_ACCOUNTS || 5);
const maxFileSizeMb = Number(process.env.MAX_FILE_SIZE_MB || 100);
const maxBatchFiles = Number(process.env.MAX_BATCH_FILES || 20);

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

function driveUrl(folderId) {
  return folderId ? `/drive?folder=${encodeURIComponent(folderId)}` : '/drive';
}

async function getFolderAccess(folderId, userId) {
  if (!folderId) return { isOwner: true, folder: null };
  const result = await pool.query(
    `SELECT f.id, f.name, f.owner_id, u.username AS owner_name,
            (f.owner_id = $2) AS is_owner
       FROM image_drive.folders f
       JOIN image_drive.users u ON u.id = f.owner_id
      WHERE f.id = $1
        AND (f.owner_id = $2 OR EXISTS (
          SELECT 1 FROM image_drive.folder_shares s WHERE s.folder_id = f.id AND s.user_id = $2
        ))`,
    [folderId, userId]
  );
  const folder = result.rows[0];
  return folder ? { isOwner: folder.is_owner, folder } : null;
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
    const folderId = req.query.folder ? String(req.query.folder) : null;
    const access = await getFolderAccess(folderId, req.session.user.id);
    if (!access) return res.status(404).send('Folder không tồn tại hoặc chưa được chia sẻ cho bạn.');
    const [imagesResult, foldersResult, sharesResult] = await Promise.all([
      folderId
        ? pool.query('SELECT id, original_name, mime_type, size_bytes, created_at, user_id FROM image_drive.images WHERE folder_id = $1 ORDER BY created_at DESC', [folderId])
        : pool.query('SELECT id, original_name, mime_type, size_bytes, created_at, user_id FROM image_drive.images WHERE user_id = $1 AND folder_id IS NULL ORDER BY created_at DESC', [req.session.user.id]),
      pool.query(
        `SELECT f.id, f.name, f.owner_id, u.username AS owner_name,
                (f.owner_id = $1) AS is_owner,
                COUNT(i.id)::int AS image_count
           FROM image_drive.folders f
           JOIN image_drive.users u ON u.id = f.owner_id
           LEFT JOIN image_drive.images i ON i.folder_id = f.id
          WHERE f.owner_id = $1 OR EXISTS (
            SELECT 1 FROM image_drive.folder_shares s WHERE s.folder_id = f.id AND s.user_id = $1
          )
          GROUP BY f.id, u.username ORDER BY is_owner DESC, f.name`,
        [req.session.user.id]
      ),
      folderId && access.isOwner
        ? pool.query('SELECT u.id, u.username, u.email FROM image_drive.folder_shares s JOIN image_drive.users u ON u.id = s.user_id WHERE s.folder_id = $1 ORDER BY u.username', [folderId])
        : Promise.resolve({ rows: [] })
    ]);
    res.render('drive', {
      user: req.session.user, images: imagesResult.rows, folders: foldersResult.rows,
      currentFolder: access.folder, isOwner: access.isOwner, sharedUsers: sharesResult.rows,
      error: req.session.error || null, success: req.session.success || null,
      maxFileSizeMb, maxBatchFiles
    });
    delete req.session.error; delete req.session.success;
  } catch (error) { console.error(error); res.status(500).send('Không thể tải thư viện ảnh.'); }
});

app.post('/folders', authRequired, async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name || name.length > 100) { req.session.error = 'Tên folder cần từ 1 đến 100 ký tự.'; return res.redirect('/drive'); }
  try {
    await pool.query('INSERT INTO image_drive.folders (id, owner_id, name) VALUES ($1, $2, $3)', [crypto.randomUUID(), req.session.user.id, name]);
    req.session.success = 'Đã tạo folder mới.';
  } catch (error) {
    req.session.error = error.code === '23505' ? 'Bạn đã có folder với tên này.' : 'Không thể tạo folder.';
  }
  res.redirect('/drive');
});

app.post('/folders/:id/delete', authRequired, async (req, res) => {
  const result = await pool.query('DELETE FROM image_drive.folders WHERE id = $1 AND owner_id = $2 RETURNING id', [req.params.id, req.session.user.id]);
  req.session[result.rowCount ? 'success' : 'error'] = result.rowCount ? 'Đã xóa folder và toàn bộ ảnh bên trong.' : 'Bạn không có quyền xóa folder này.';
  res.redirect('/drive');
});

app.post('/folders/:id/share', authRequired, async (req, res) => {
  const identity = String(req.body.identity || '').trim();
  try {
    const folder = await pool.query('SELECT id FROM image_drive.folders WHERE id = $1 AND owner_id = $2', [req.params.id, req.session.user.id]);
    if (!folder.rowCount) throw new Error('NO_PERMISSION');
    const target = await pool.query('SELECT id FROM image_drive.users WHERE (lower(username) = lower($1) OR lower(email) = lower($1)) AND id <> $2', [identity, req.session.user.id]);
    if (!target.rowCount) { req.session.error = 'Không tìm thấy tài khoản để chia sẻ.'; return res.redirect(driveUrl(req.params.id)); }
    await pool.query('INSERT INTO image_drive.folder_shares (folder_id, user_id, shared_by) VALUES ($1, $2, $3) ON CONFLICT (folder_id, user_id) DO NOTHING', [req.params.id, target.rows[0].id, req.session.user.id]);
    req.session.success = 'Đã chia sẻ folder.';
  } catch (error) { req.session.error = error.message === 'NO_PERMISSION' ? 'Bạn không có quyền chia sẻ folder này.' : 'Không thể chia sẻ folder.'; }
  res.redirect(driveUrl(req.params.id));
});

app.post('/folders/:id/unshare', authRequired, async (req, res) => {
  await pool.query(
    'DELETE FROM image_drive.folder_shares s USING image_drive.folders f WHERE s.folder_id = f.id AND s.folder_id = $1 AND s.user_id = $2 AND f.owner_id = $3',
    [req.params.id, req.body.userId, req.session.user.id]
  );
  req.session.success = 'Đã thu hồi quyền chia sẻ.';
  res.redirect(driveUrl(req.params.id));
});

app.post('/images', authRequired, (req, res) => {
  upload.array('images', maxBatchFiles)(req, res, async (error) => {
    const folderId = req.body && req.body.folderId ? String(req.body.folderId) : null;
    const redirectTo = driveUrl(folderId);
    if (error) { req.session.error = error.code === 'LIMIT_FILE_SIZE' ? `Mỗi ảnh không được lớn hơn ${maxFileSizeMb} MB.` : error.message; return res.redirect(redirectTo); }
    if (!req.files || !req.files.length) { req.session.error = 'Vui lòng chọn ít nhất một ảnh.'; return res.redirect(redirectTo); }
    try {
      const access = await getFolderAccess(folderId, req.session.user.id);
      if (!access || !access.isOwner) { req.session.error = 'Bạn không có quyền tải ảnh vào folder này.'; return res.redirect(redirectTo); }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const file of req.files) {
          await client.query('INSERT INTO image_drive.images (id, user_id, folder_id, original_name, mime_type, size_bytes, image_data) VALUES ($1, $2, $3, $4, $5, $6, $7)', [crypto.randomUUID(), req.session.user.id, folderId, file.originalname.slice(0, 255), file.mimetype, file.size, file.buffer]);
        }
        await client.query('COMMIT');
      } catch (dbError) { await client.query('ROLLBACK'); throw dbError; } finally { client.release(); }
      req.session.success = `Đã tải lên ${req.files.length} ảnh.`;
    } catch (dbError) { console.error(dbError); req.session.error = 'Không thể lưu ảnh.'; }
    res.redirect(redirectTo);
  });
});

app.get('/images/:id', authRequired, async (req, res) => {
  const result = await pool.query(`SELECT i.original_name, i.mime_type, i.image_data FROM image_drive.images i WHERE i.id = $1 AND (i.user_id = $2 OR EXISTS (SELECT 1 FROM image_drive.folder_shares s WHERE s.folder_id = i.folder_id AND s.user_id = $2))`, [req.params.id, req.session.user.id]);
  if (!result.rows[0]) return res.sendStatus(404);
  res.set({ 'Content-Type': result.rows[0].mime_type, 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(result.rows[0].original_name)}`, 'Cache-Control': 'private, max-age=3600' });
  res.send(result.rows[0].image_data);
});

app.get('/images/:id/download', authRequired, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT i.original_name, i.mime_type, i.size_bytes, i.image_data FROM image_drive.images i WHERE i.id = $1 AND (i.user_id = $2 OR EXISTS (SELECT 1 FROM image_drive.folder_shares s WHERE s.folder_id = i.folder_id AND s.user_id = $2))`,
      [req.params.id, req.session.user.id]
    );
    const image = result.rows[0];
    if (!image) return res.sendStatus(404);
    res.set({
      'Content-Type': image.mime_type,
      'Content-Length': image.size_bytes,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(image.original_name)}`,
      'Cache-Control': 'private, no-store'
    });
    res.send(image.image_data);
  } catch (error) {
    console.error(error);
    res.status(500).send('Không thể tải ảnh xuống.');
  }
});

app.post('/images/download-batch', authRequired, async (req, res) => {
  const ids = Array.isArray(req.body.imageIds) ? req.body.imageIds : req.body.imageIds ? [req.body.imageIds] : [];
  if (!ids.length || ids.length > 100) return res.status(400).send('Vui lòng chọn từ 1 đến 100 ảnh.');
  try {
    const result = await pool.query(
      `SELECT i.original_name, i.image_data FROM image_drive.images i
        WHERE i.id = ANY($1::uuid[]) AND (i.user_id = $2 OR EXISTS (
          SELECT 1 FROM image_drive.folder_shares s WHERE s.folder_id = i.folder_id AND s.user_id = $2
        ))`,
      [ids, req.session.user.id]
    );
    if (!result.rowCount) return res.status(404).send('Không tìm thấy ảnh có quyền tải.');
    res.attachment(`lumina-images-${Date.now()}.zip`);
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (error) => res.destroy(error));
    archive.pipe(res);
    const usedNames = new Map();
    for (const image of result.rows) {
      const safeName = path.basename(image.original_name).replace(/[\\/\0]/g, '_');
      const count = usedNames.get(safeName) || 0;
      usedNames.set(safeName, count + 1);
      const name = count ? `${count}-${safeName}` : safeName;
      archive.append(image.image_data, { name });
    }
    await archive.finalize();
  } catch (error) { console.error(error); if (!res.headersSent) res.status(500).send('Không thể tạo file ZIP.'); }
});

app.post('/images/:id/delete', authRequired, async (req, res) => {
  const result = await pool.query('DELETE FROM image_drive.images WHERE id = $1 AND user_id = $2 RETURNING folder_id', [req.params.id, req.session.user.id]);
  req.session.success = 'Ảnh đã được xóa.';
  res.redirect(driveUrl(result.rows[0] && result.rows[0].folder_id));
});

app.use((_req, res) => res.status(404).send('Không tìm thấy trang.'));

app.listen(port, '0.0.0.0', () => console.log(`Image Drive running at http://localhost:${port}`));
