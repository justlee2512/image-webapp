## 2.0.2-toast-cache

- Hiển thị lỗi và lỗi phân quyền bằng toast đỏ tại trang hiện tại.
- Không cache HTML, CSS và JavaScript để tránh frontend cũ sau khi deploy.
- Giữ cache dài hạn cho ảnh và thumbnail để không làm giảm hiệu suất thư viện.
- Tự dọn Cache Storage và service worker cũ khi phiên bản frontend thay đổi.
- Route không tồn tại và lỗi HTML quay về trang an toàn với toast thay vì trang chữ lỗi.

## 2.0.1-toast

- Chuyển lỗi thao tác sang toast màu đỏ, tự mờ và biến mất.
- Đăng nhập, đăng ký và quản trị người dùng dùng AJAX để lỗi không mở trang lỗi mới.
- Xóa, di chuyển và tải ZIP xử lý tại trang hiện tại; lỗi quyền truy cập hiển thị bằng toast.
- Thông báo thành công được giữ qua lần reload bằng sessionStorage.

# Changelog

## 2.0.0

### Security
- Quyền admin lưu bằng cột `users.is_admin`, không còn suy ra từ username/email.
- Bắt buộc secret và mật khẩu admin mạnh trong production.
- Thêm CSRF protection cho mọi thao tác thay đổi dữ liệu.
- Regenerate session sau login/register để chống session fixation.
- Rate-limit login và register.
- Kiểm tra magic bytes, metadata, kích thước pixel và MIME thực của ảnh.
- CSP, HSTS khi HTTPS, no-sniff, referrer policy và request ID.
- Docker chạy non-root, read-only filesystem, drop capabilities.

### Performance
- ETag và cache một năm cho ảnh/thumbnail bất biến.
- Giảm ghi session bằng touch throttling.
- Tối ưu index PostgreSQL và chỉ đọc metadata khi hiển thị thư viện.
- Giới hạn hàng đợi upload/download và tổng dung lượng ZIP.
- Thumbnail WebP tạo sẵn, lazy loading và client-side search.

### UX
- Giao diện responsive mới.
- Upload nhiều ảnh tuần tự với progress tổng.
- Drag-and-drop, lightbox, chọn nhiều ảnh, tải ZIP, di chuyển và xóa không cần tải lại toàn trang cho thao tác chính.
