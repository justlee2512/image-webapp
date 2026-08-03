# CI/CD setup cho image-webapp

Bộ này bổ sung CI cho repository:

- Kiểm tra cú pháp JavaScript trên Pull Request.
- Build Docker image trên Pull Request nhưng không push.
- Khi merge vào `main`, push image bất biến lên GHCR với tag `sha-<commit>`.
- Commit tag mới vào repository `justlee2512/image-webapp-gitops`.
- Argo CD theo dõi GitOps repo và tự rollout Kubernetes.

## Chuẩn bị

### 1. Tạo GitOps repository

Tạo repository GitHub tên:

```text
justlee2512/image-webapp-gitops
```

Push nội dung của file ZIP GitOps đi kèm vào repository đó.

### 2. Tạo token ghi GitOps repo

Tạo Fine-grained Personal Access Token chỉ có quyền với repo
`image-webapp-gitops`:

- Contents: Read and write
- Metadata: Read

Trong repository `image-webapp`, tạo Actions secret:

```text
GITOPS_TOKEN
```

Không lưu `DATABASE_URL`, `SESSION_SECRET`, kubeconfig hoặc mật khẩu Argo CD
trong GitHub Actions.

### 3. GHCR

Workflow dùng `GITHUB_TOKEN` để push:

```text
ghcr.io/justlee2512/image-webapp:sha-<commit>
```

Đặt package GHCR thành public, hoặc tạo `imagePullSecret` trong namespace
`image-webapp` nếu muốn giữ private.

## Cài tự động lên source hiện tại

Từ thư mục ZIP này:

```bash
chmod +x bootstrap.sh
./bootstrap.sh image-webapp
```

Nếu lần chạy trước đã clone source nhưng dừng ở lỗi `patch does not apply`, cứ chạy lại lệnh trên. Bản v2 không dùng `git apply`; nó tìm route `/health` và chèn `/live` ngay phía trước nên không phụ thuộc số dòng.

Script sẽ:

1. Clone repo nếu thư mục đích chưa tồn tại.
2. Dùng repo hiện có nếu đã clone.
3. Thay Dockerfile bằng bản chạy non-root.
4. Thêm GitHub Actions workflow.
5. Thêm endpoint `/live` cho Kubernetes liveness probe.
6. Chạy `node --check` nếu máy có Node.js.

## Database

Pipeline không truy cập PostgreSQL và không chạy migration. Dữ liệu tiếp tục
được lưu trong PostgreSQL ngoài Kubernetes.

Khi schema thay đổi, chạy thủ công:

```bash
psql -h 192.168.2.90 -U YOUR_DB_USER -d webapp -f db/init.sql
```
