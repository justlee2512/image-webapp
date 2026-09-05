# Richard Le Image Drive

Web app Node.js lưu trữ ảnh theo tài khoản. Ảnh và metadata được lưu trực tiếp trong PostgreSQL (`BYTEA`). Hệ thống giới hạn tối đa 5 tài khoản, hỗ trợ upload tuần tự, kéo hoặc chọn nhiều ảnh để chuyển folder, chọn/xóa nhiều ảnh, tải ZIP và chia sẻ folder chỉ đọc.

## Chạy bằng Docker

Tạo `.env` từ `.env.example`, thay `ADMIN_PASSWORD` bằng mật khẩu riêng (12 ký tự trở lên, tối đa 72 byte) và `SESSION_SECRET` bằng chuỗi ngẫu nhiên ít nhất 32 ký tự. Có thể tạo secret bằng `openssl rand -hex 32`. App từ chối mật khẩu admin mặc định hoặc giá trị mẫu.

```bash
cp .env.example .env
# Điền mật khẩu và secret riêng trước khi chạy.
docker compose up --build
```

Mở [http://localhost:3000](http://localhost:3000). PostgreSQL tự tạo database `webapp`, schema `image_drive` và các bảng bằng `db/init.sql`.

Tắt app:

```bash
docker compose down
```

Xóa cả dữ liệu để thử lại từ đầu:

```bash
docker compose down -v
```

## Chạy local

Yêu cầu Node.js 22.12+ và PostgreSQL. Tạo DB `webapp`, chạy `db/init.sql`, sau đó:

```bash
cp .env.example .env
# Điền DATABASE_URL, ADMIN_PASSWORD và SESSION_SECRET riêng.
npm ci
npm start
```

Mặc định hỗ trợ JPG, PNG, GIF, WebP, tối đa 30 MB mỗi ảnh và không giới hạn số ảnh được chọn. Ảnh được upload tuần tự, mỗi request chỉ chứa một ảnh. Có thể đổi giới hạn từng ảnh qua `MAX_FILE_SIZE_MB`. Ứng dụng không giới hạn tổng số ảnh hoặc tổng dung lượng lưu trữ theo tài khoản; dung lượng thực tế phụ thuộc ổ đĩa chứa PostgreSQL. Các biến cũ `MAX_UPLOAD_FILES` và `MAX_UPLOAD_TOTAL_MB` không còn được sử dụng.

## Dùng PostgreSQL có sẵn

Với PostgreSQL tại `192.168.2.90`, tạo file `.env` từ `.env.example` và điền đúng `DB_USER`, `DB_PASSWORD`. Đảm bảo database `webapp` đã tồn tại, sau đó khởi tạo bảng:

```bash
psql -h 192.168.2.90 -U YOUR_DB_USER -d webapp -f db/init.sql
```

Chạy riêng container web (không tạo thêm container PostgreSQL):

```bash
docker compose -f docker-compose.external-db.yml --env-file .env up --build
```

PostgreSQL cần cho phép máy chạy Docker kết nối TCP đến cổng 5432. Nếu mật khẩu chứa ký tự đặc biệt dùng trong URL như `@`, `:`, `/`, `%`, hãy URL-encode giá trị đó.

Khi nâng cấp từ phiên bản cũ có database đang chứa ảnh, chạy lại script sau một lần. Các lệnh dùng `IF NOT EXISTS` nên giữ nguyên dữ liệu hiện tại:

```bash
psql -h 192.168.2.90 -U YOUR_DB_USER -d webapp -f db/init.sql
```

Schema mới lưu thêm thumbnail WebP. Ảnh cũ tự tạo thumbnail ở lần xem đầu tiên; ảnh mới tạo thumbnail ngay khi upload. App mặc định chỉ cho 1 upload và 2 lượt đọc file lớn chạy đồng thời để bảo vệ PostgreSQL chạy trên HDD. Có thể điều chỉnh bằng `MAX_CONCURRENT_UPLOADS`, `MAX_CONCURRENT_DOWNLOADS` và `DB_POOL_MAX`.

## Chạy nhiều replica trên Kubernetes

Session đăng nhập được lưu trong bảng `image_drive.sessions`, nên không cần sticky session và request có thể đi tới pod bất kỳ. Trước khi rollout, chạy `db/init.sql` một lần bằng migration Job hoặc tài khoản có quyền tạo bảng/index. App cũng tự tạo bảng session nếu chưa có; PostgreSQL advisory lock bảo vệ trường hợp nhiều pod khởi động cùng lúc.

Mọi pod phải dùng chung các giá trị sau:

```yaml
env:
  - name: DATABASE_URL
    valueFrom:
      secretKeyRef: { name: image-drive, key: database-url }
  - name: SESSION_SECRET
    valueFrom:
      secretKeyRef: { name: image-drive, key: session-secret }
  - name: ADMIN_USERNAME
    value: "admin"
  - name: ADMIN_EMAIL
    value: "admin@example.com"
  - name: ADMIN_PASSWORD
    valueFrom:
      secretKeyRef: { name: image-drive, key: admin-password }
  - name: TRUST_PROXY
    value: "true"
  - name: COOKIE_SECURE
    value: "true"
  - name: DB_POOL_MAX
    value: "5"
readinessProbe:
  httpGet: { path: /health, port: 3000 }
livenessProbe:
  httpGet: { path: /health, port: 3000 }
```

`SESSION_SECRET` phải cố định, giống nhau trên tất cả pod và dài ít nhất 32 ký tự. `COOKIE_SECURE=true` chỉ dùng khi người dùng truy cập qua HTTPS; nếu Ingress chỉ phục vụ HTTP thì đặt `false`. Với Ingress terminate TLS, giữ `TRUST_PROXY=true` để Express nhận đúng giao thức gốc.

Session mặc định tự hết hạn sau 15 phút không có request sử dụng ứng dụng. Khi hết phiên, trang thư viện/quản trị hiển thị thông báo và nút **Continue**; chỉ khi nhấn nút mới chuyển về `/login`. Kiểm tra phiên nền không gia hạn session. Các request sử dụng ứng dụng (ngoại trừ `/session-status`) sẽ gia hạn lại thời gian này. Có thể thay đổi bằng `SESSION_IDLE_TIMEOUT_MS` (đơn vị millisecond), và mọi pod nên dùng cùng một giá trị.

Tổng số connection tối đa xấp xỉ `replicas × DB_POOL_MAX`. Ví dụ 4 pod và `DB_POOL_MAX=5` có thể dùng tối đa 20 connection; cần giữ con số này thấp hơn `max_connections` của PostgreSQL sau khi chừa connection cho migration, giám sát và quản trị.


## Nâng cấp bảo mật và giới hạn chống lạm dụng

Quyền quản trị nằm trong cột `users.is_admin`, mặc định `FALSE`; username/email không tự cấp quyền. App đọc lại quyền từ database cho mỗi request cần đăng nhập, nên session cũ không giữ quyền đã bị thu hồi. Khi triển khai bản sửa, thay thế toàn bộ replica cũ trước khi mở lại lưu lượng.

Bootstrap được khóa để chạy an toàn trên nhiều replica. Với database cũ, `ADMIN_USERNAME` và `ADMIN_EMAIL` phải cùng khớp chính xác một tài khoản:

- Nếu tài khoản còn dùng mật khẩu mặc định cũ, bootstrap thay bằng `ADMIN_PASSWORD` mới và xóa session của tài khoản đó.
- Nếu tài khoản chưa có cờ admin và dùng mật khẩu khác, `ADMIN_PASSWORD` phải khớp mật khẩu hiện tại để xác nhận chuyển quyền. Mật khẩu này phải đáp ứng yêu cầu mới; tài khoản có mật khẩu yếu khác cần được quản trị viên đổi mật khẩu trong database trước khi nâng cấp.
- Nếu tài khoản đã có cờ admin, bootstrap giữ mật khẩu riêng hiện tại. Đổi biến môi trường không phải thao tác reset mật khẩu.
- Nếu username/email trùng những tài khoản khác nhau hoặc không xác minh được mật khẩu, app dừng khởi động thay vì cấp nhầm quyền.

Giới hạn đăng nhập/đăng ký được lưu chung trong PostgreSQL, tính cả yêu cầu thành công và thất bại, cập nhật nguyên tử trước khi xử lý mật khẩu. Khi database không sẵn sàng, endpoint từ chối xử lý thay vì bỏ qua giới hạn. Bảng giới hạn tối đa 10.000 mục; mục hết hạn được dọn khi có yêu cầu tiếp theo, bảng đầy trả `429`.

| Biến môi trường | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `LOGIN_RATE_LIMIT_WINDOW_MS` | 900000 | Cửa sổ đăng nhập 15 phút |
| `LOGIN_RATE_LIMIT_MAX_ATTEMPTS` | 10 | Số lần đăng nhập theo identity, chung mọi IP |
| `LOGIN_RATE_LIMIT_IP_MAX_ATTEMPTS` | 100 | Số lần đăng nhập theo IP, chung mọi identity |
| `REGISTER_RATE_LIMIT_WINDOW_MS` | 3600000 | Cửa sổ đăng ký 1 giờ |
| `REGISTER_RATE_LIMIT_MAX_ATTEMPTS` | 5 | Số yêu cầu đăng ký theo IP |
| `MAX_PENDING_REQUESTS` | 100 | Hạn mức hàng chờ riêng, không chiếm suất `MAX_ACCOUNTS` |
| `ACCOUNT_REQUEST_TTL_MS` | 86400000 | Yêu cầu đăng ký hết hạn sau 24 giờ, không hiển thị/duyệt được; dọn khi đăng ký tiếp |

Các replica phải dùng cùng cấu hình giới hạn. Chỉ bật `TRUST_PROXY=true` khi app nằm sau đúng một proxy tin cậy và không thể truy cập trực tiếp từ Internet.

## Kiểm thử

`npm test` chạy unit test. Để chạy cả kiểm thử HTTP và transaction trên PostgreSQL, đặt `TEST_DATABASE_URL` trỏ đến một PostgreSQL dành cho test, với tài khoản có quyền tạo database. Bộ test tự tạo database tên ngẫu nhiên và xóa nó khi hoàn tất; không sử dụng `DATABASE_URL` của app. CI chạy đầy đủ với PostgreSQL 16, dùng `npm ci` và kiểm tra dependency bằng `npm audit --omit=dev --audit-level=high`.
