# Richard Le Image Drive — optimized v2

Ứng dụng Node.js/Express lưu ảnh và metadata trong PostgreSQL. Bản v2 giữ các chức năng cũ: đăng ký/đăng nhập, quản lý tài khoản, folder, chia sẻ chỉ đọc, upload nhiều ảnh, di chuyển, xóa hàng loạt và tải ZIP; đồng thời tăng bảo mật, hiệu suất và độ mượt.

## Nâng cấp từ repository hiện tại

1. Sao lưu database trước khi cập nhật.
2. Thay source code bằng nội dung trong package này.
3. Cập nhật biến môi trường theo `.env.example`.
4. Chạy migration an toàn:

```bash
psql "$DATABASE_URL" -f db/init.sql
```

5. Build và rollout lại ứng dụng.

Database cũ được giữ nguyên. Script chỉ thêm các cột/index còn thiếu. Tài khoản trùng với `ADMIN_USERNAME` hoặc `ADMIN_EMAIL` được đánh dấu `is_admin=true`; mật khẩu hiện có không bị ghi đè.

## Chạy nhanh bằng Docker Compose

Tạo `.env` tối thiểu:

```env
POSTGRES_PASSWORD=replace-with-strong-db-password
SESSION_SECRET=replace-with-random-secret-at-least-32-characters
ADMIN_PASSWORD=replace-with-strong-admin-password
COOKIE_SECURE=false
TRUST_PROXY=false
```

Sau đó:

```bash
docker compose up --build -d
docker compose logs -f app
```

Mở `http://localhost:3000`.

## PostgreSQL bên ngoài

```bash
cp .env.example .env
# sửa DATABASE_URL và các secret
psql "$DATABASE_URL" -f db/init.sql
docker compose -f docker-compose.external-db.yml --env-file .env up --build -d
```

## Kubernetes

Các replica phải dùng chung `DATABASE_URL`, `SESSION_SECRET`, `SESSION_IDLE_TIMEOUT_MS` và cấu hình cookie. Ví dụ quan trọng:

```yaml
env:
  - name: NODE_ENV
    value: production
  - name: TRUST_PROXY
    value: "true"
  - name: COOKIE_SECURE
    value: "true"
  - name: SESSION_IDLE_TIMEOUT_MS
    value: "900000"
readinessProbe:
  httpGet:
    path: /health
    port: 3000
livenessProbe:
  httpGet:
    path: /live
    port: 3000
```

`/live` chỉ kiểm tra tiến trình Node.js. `/health` kiểm tra cả PostgreSQL và session store.

## Những thay đổi chính

- **Upload an toàn hơn:** không tin `Content-Type` do trình duyệt gửi; kiểm tra magic bytes, Sharp metadata, MIME thật và giới hạn số pixel.
- **Session an toàn hơn:** PostgreSQL session store, cookie `HttpOnly`, `SameSite=Lax`, regenerate sau đăng nhập và tự hết hạn theo thời gian không hoạt động.
- **Chống request giả mạo:** token CSRF cho form, AJAX và multipart upload.
- **Chống brute-force cơ bản:** giới hạn login/register theo IP và identity trên từng pod.
- **Ảnh tải nhanh hơn:** thumbnail WebP, lazy loading, ETag và cache private dài hạn vì ID ảnh bất biến.
- **Database nhẹ hơn:** trang thư viện không lấy cột BYTEA; index riêng cho root/folder/share/session.
- **Bảo vệ tài nguyên:** semaphore có giới hạn hàng đợi, giới hạn ZIP và timeout HTTP/PostgreSQL.
- **Container cứng hóa:** non-root, read-only root filesystem, `no-new-privileges`, drop all capabilities.

## Kiểm tra

```bash
npm install
npm run check
npm test
```

## Lưu ý vận hành

Rate-limit hiện dùng bộ nhớ trong từng pod, phù hợp cho ứng dụng nhỏ. Khi mở rộng nhiều người dùng hoặc public Internet, nên đặt rate-limit tập trung tại Cloudflare, NGINX Ingress, API Gateway hoặc Redis.

Ảnh vẫn lưu trong PostgreSQL `BYTEA` để tương thích dữ liệu hiện tại. Khi dung lượng tăng lên hàng chục/hàng trăm GB, nên chuyển blob sang S3/MinIO và chỉ giữ metadata trong PostgreSQL.

## Toast lỗi và làm mới frontend

- Các thao tác giao diện gửi AJAX; lỗi, `401`, `403` và lỗi hệ thống sẽ hiện toast đỏ rồi tự mờ, không mở trang lỗi riêng.
- HTML, CSS và JavaScript mặc định có `Cache-Control: no-store`; ảnh/thumbnail vẫn được cache dài hạn.
- Đặt `ASSET_VERSION` bằng Git SHA hoặc image tag trong CI/CD để xác định đúng frontend đang chạy.
- Có thể bật lại cache frontend bằng `DISABLE_FRONTEND_CACHE=false`, nhưng không khuyến nghị khi đang triển khai thường xuyên.
