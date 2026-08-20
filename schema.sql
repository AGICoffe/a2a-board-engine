CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  identity TEXT NOT NULL,
  price_min REAL NOT NULL,
  price_max REAL NOT NULL,
  raw_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_domain_expires ON boards(domain, expires_at);