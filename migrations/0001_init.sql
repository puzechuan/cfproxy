-- 用户系统初始化
-- 密码使用 PBKDF2-SHA256 + 随机盐，只存哈希与盐，绝不存明文。
-- 会话为无状态 HMAC 签名 Cookie，服务端每次请求按 id 回查状态，
-- 这样管理员「禁用账号 / 调整角色」能立即生效，无需等待 Cookie 过期。

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash   TEXT    NOT NULL,               -- base64(PBKDF2 32 bytes)
  salt        TEXT    NOT NULL,               -- base64(16 random bytes)
  role        TEXT    NOT NULL DEFAULT 'user',-- 'user' | 'admin'
  disabled    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL,
  last_login  TEXT
);

-- 持久化会话签名密钥：Worker 首次启动时生成一次并写入，
-- 所有 isolate 共享同一把密钥，避免多实例签名不一致导致会话失效。
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username COLLATE NOCASE);
