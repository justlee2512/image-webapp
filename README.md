# Richard Le Image Drive

Web app Node.js lưu trữ ảnh theo tài khoản. Ảnh và metadata được lưu trực tiếp trong PostgreSQL (`BYTEA`). Hệ thống giới hạn tối đa 5 tài khoản, hỗ trợ upload tuần tự, kéo hoặc chọn nhiều ảnh để chuyển folder, chọn/xóa nhiều ảnh, tải ZIP và chia sẻ folder chỉ đọc.

## Chạy bằng Docker

```bash
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

Yêu cầu Node.js 20+ và PostgreSQL. Tạo DB `webapp`, chạy `db/init.sql`, sau đó:

```bash
cp .env.example .env
npm install
npm start
```

Mặc định hỗ trợ JPG, PNG, GIF, WebP, tối đa 30 MB mỗi ảnh và không giới hạn số ảnh được chọn. Ảnh được upload tuần tự, mỗi request chỉ chứa một ảnh. Có thể đổi giới hạn dung lượng qua biến môi trường `MAX_FILE_SIZE_MB`.

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

Tổng số connection tối đa xấp xỉ `replicas × DB_POOL_MAX`. Ví dụ 4 pod và `DB_POOL_MAX=5` có thể dùng tối đa 20 connection; cần giữ con số này thấp hơn `max_connections` của PostgreSQL sau khi chừa connection cho migration, giám sát và quản trị.
