CREATE TABLE IF NOT EXISTS telemetry_installs (
  install_id TEXT PRIMARY KEY,
  app TEXT NOT NULL,
  app_version TEXT,
  platform TEXT,
  locale TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS telemetry_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  install_id TEXT NOT NULL,
  app TEXT NOT NULL,
  app_version TEXT,
  platform TEXT,
  locale TEXT,
  event_name TEXT NOT NULL,
  event_time INTEGER,
  received_at TEXT NOT NULL,
  properties_json TEXT NOT NULL,
  FOREIGN KEY (install_id) REFERENCES telemetry_installs(install_id)
);

CREATE INDEX IF NOT EXISTS idx_telemetry_events_received_at
  ON telemetry_events(received_at);

CREATE INDEX IF NOT EXISTS idx_telemetry_events_install_received
  ON telemetry_events(install_id, received_at);

CREATE INDEX IF NOT EXISTS idx_telemetry_events_name_received
  ON telemetry_events(event_name, received_at);
