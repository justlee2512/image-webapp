CREATE SCHEMA IF NOT EXISTS image_drive;

CREATE TABLE IF NOT EXISTS image_drive.users (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(30) NOT NULL,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT users_username_unique UNIQUE (username),
  CONSTRAINT users_email_unique UNIQUE (email)
);

CREATE TABLE IF NOT EXISTS image_drive.folders (
  id UUID PRIMARY KEY,
  owner_id BIGINT NOT NULL REFERENCES image_drive.users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT folders_owner_name_unique UNIQUE (owner_id, name)
);

CREATE TABLE IF NOT EXISTS image_drive.folder_shares (
  folder_id UUID NOT NULL REFERENCES image_drive.folders(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES image_drive.users(id) ON DELETE CASCADE,
  shared_by BIGINT NOT NULL REFERENCES image_drive.users(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (folder_id, user_id)
);

CREATE TABLE IF NOT EXISTS image_drive.images (
  id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES image_drive.users(id) ON DELETE CASCADE,
  folder_id UUID REFERENCES image_drive.folders(id) ON DELETE CASCADE,
  original_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  image_data BYTEA NOT NULL,
  thumbnail_data BYTEA,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Session dùng chung cho mọi replica. Không dùng MemoryStore vì request có thể
-- được Kubernetes chuyển sang pod khác ở bất kỳ thời điểm nào.
CREATE TABLE IF NOT EXISTS image_drive.sessions (
  sid VARCHAR(128) PRIMARY KEY,
  sess JSONB NOT NULL,
  expire TIMESTAMP WITH TIME ZONE NOT NULL
);

-- Nâng cấp an toàn cho database đã có bảng images từ phiên bản cũ.
ALTER TABLE image_drive.images
  ADD COLUMN IF NOT EXISTS folder_id UUID REFERENCES image_drive.folders(id) ON DELETE CASCADE;

ALTER TABLE image_drive.images
  ADD COLUMN IF NOT EXISTS thumbnail_data BYTEA;

-- JPEG/PNG/WebP vốn đã nén; EXTERNAL tránh PostgreSQL tốn CPU thử nén lại BYTEA lớn.
ALTER TABLE image_drive.images
  ALTER COLUMN image_data SET STORAGE EXTERNAL;

CREATE INDEX IF NOT EXISTS images_user_created_idx
  ON image_drive.images (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS images_folder_created_idx
  ON image_drive.images (folder_id, created_at DESC);

CREATE INDEX IF NOT EXISTS folder_shares_user_idx
  ON image_drive.folder_shares (user_id);

CREATE INDEX IF NOT EXISTS sessions_expire_idx
  ON image_drive.sessions (expire);

-- Giúp PostgreSQL cập nhật thống kê sau khi thêm index/cột trên database hiện có.
ANALYZE image_drive.users;
ANALYZE image_drive.folders;
ANALYZE image_drive.folder_shares;
ANALYZE image_drive.images;
ANALYZE image_drive.sessions;
