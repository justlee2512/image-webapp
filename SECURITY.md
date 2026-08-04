# Security policy

Không đăng issue công khai nếu phát hiện lỗ hổng có thể làm lộ tài khoản, session hoặc dữ liệu ảnh. Hãy gửi mô tả riêng cho chủ repository, bao gồm phiên bản, cách tái hiện và mức ảnh hưởng.

## Nguyên tắc triển khai production

- Bắt buộc dùng HTTPS.
- `SESSION_SECRET` phải là chuỗi ngẫu nhiên ít nhất 32 ký tự và giống nhau trên mọi replica.
- `ADMIN_PASSWORD` phải là mật khẩu riêng, không dùng giá trị mẫu.
- `COOKIE_SECURE=true` và `TRUST_PROXY=true` khi TLS được terminate ở Ingress hoặc reverse proxy.
- Không commit file `.env`, database dump hoặc ảnh người dùng vào Git.
- Chạy `db/init.sql` trước mỗi lần rollout có thay đổi schema.
