CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  link_url TEXT,
  locale TEXT NOT NULL DEFAULT 'all',
  platform TEXT NOT NULL DEFAULT 'all',
  min_version TEXT,
  max_version TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  starts_at TEXT,
  ends_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_announcements_active
  ON announcements(enabled, starts_at, ends_at, priority);

CREATE INDEX IF NOT EXISTS idx_announcements_target
  ON announcements(locale, platform, priority);
