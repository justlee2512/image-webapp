# Lumina Image Drive

Web app Node.js lưu trữ ảnh theo tài khoản. Ảnh và metadata được lưu trực tiếp trong PostgreSQL (`BYTEA`). Hệ thống giới hạn tối đa 5 tài khoản, hỗ trợ upload nhiều ảnh theo hàng đợi tuần tự, tải nhiều ảnh thành ZIP, tạo/xóa folder và chia sẻ folder chỉ đọc cho tài khoản khác.

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

Mặc định hỗ trợ JPG, PNG, GIF, WebP, tối đa 100 MB mỗi ảnh và 20 ảnh mỗi lượt. Có thể đổi qua các biến môi trường `MAX_FILE_SIZE_MB` và `MAX_BATCH_FILES`.

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
