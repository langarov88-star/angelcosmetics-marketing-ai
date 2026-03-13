-- Seed default admin user
-- Password hash must be replaced before production use
-- Default password: 'change-me-in-production'

INSERT OR IGNORE INTO users (id, email, name, role, password_hash)
VALUES (
  'usr_admin_001',
  'admin@angelcosmetics.com',
  'System Admin',
  'admin',
  '$2a$12$PLACEHOLDER_HASH_REPLACE_BEFORE_PROD'
);
