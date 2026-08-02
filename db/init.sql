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

CREATE TABLE IF NOT EXISTS image_drive.images (
  id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES image_drive.users(id) ON DELETE CASCADE,
  original_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  image_data BYTEA NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS images_user_created_idx
  ON image_drive.images (user_id, created_at DESC);
