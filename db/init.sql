CREATE SCHEMA IF NOT EXISTS image_drive;

CREATE TABLE IF NOT EXISTS image_drive.users (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(30) NOT NULL,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT users_username_unique UNIQUE (username),
  CONSTRAINT users_email_unique UNIQUE (email)
);

CREATE TABLE IF NOT EXISTS image_drive.folders (
  id UUID PRIMARY KEY,
  owner_id BIGINT NOT NULL REFERENCES image_drive.users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT folders_owner_name_unique UNIQUE (owner_id, name)
);

CREATE TABLE IF NOT EXISTS image_drive.folder_shares (
  folder_id UUID NOT NULL REFERENCES image_drive.folders(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES image_drive.users(id) ON DELETE CASCADE,
  shared_by BIGINT NOT NULL REFERENCES image_drive.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (folder_id, user_id),
  CONSTRAINT folder_share_not_owner CHECK (user_id <> shared_by)
);

CREATE TABLE IF NOT EXISTS image_drive.images (
  id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES image_drive.users(id) ON DELETE CASCADE,
  folder_id UUID REFERENCES image_drive.folders(id) ON DELETE CASCADE,
  original_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  content_sha256 CHAR(64),
  image_data BYTEA NOT NULL,
  thumbnail_data BYTEA,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS image_drive.sessions (
  sid VARCHAR(128) PRIMARY KEY,
  sess JSONB NOT NULL,
  expire TIMESTAMPTZ NOT NULL
);

ALTER TABLE image_drive.users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE image_drive.images ADD COLUMN IF NOT EXISTS folder_id UUID REFERENCES image_drive.folders(id) ON DELETE CASCADE;
ALTER TABLE image_drive.images ADD COLUMN IF NOT EXISTS thumbnail_data BYTEA;
ALTER TABLE image_drive.images ADD COLUMN IF NOT EXISTS width INTEGER;
ALTER TABLE image_drive.images ADD COLUMN IF NOT EXISTS height INTEGER;
ALTER TABLE image_drive.images ADD COLUMN IF NOT EXISTS content_sha256 CHAR(64);
ALTER TABLE image_drive.images ALTER COLUMN image_data SET STORAGE EXTERNAL;
ALTER TABLE image_drive.images ALTER COLUMN thumbnail_data SET STORAGE EXTERNAL;

CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_unique ON image_drive.users (lower(username));
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique ON image_drive.users (lower(email));
CREATE INDEX IF NOT EXISTS users_created_idx ON image_drive.users (created_at DESC);
CREATE INDEX IF NOT EXISTS folders_owner_created_idx ON image_drive.folders (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS images_user_root_created_idx ON image_drive.images (user_id, created_at DESC) WHERE folder_id IS NULL;
CREATE INDEX IF NOT EXISTS images_folder_created_idx ON image_drive.images (folder_id, created_at DESC);
CREATE INDEX IF NOT EXISTS images_sha256_idx ON image_drive.images (content_sha256) WHERE content_sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS folder_shares_user_idx ON image_drive.folder_shares (user_id, folder_id);
CREATE INDEX IF NOT EXISTS sessions_expire_idx ON image_drive.sessions (expire);

ANALYZE image_drive.users;
ANALYZE image_drive.folders;
ANALYZE image_drive.folder_shares;
ANALYZE image_drive.images;
ANALYZE image_drive.sessions;
