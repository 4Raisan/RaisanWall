PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  excerpt TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'markdown' CHECK (format IN ('markdown', 'html')),
  category TEXT NOT NULL DEFAULT 'Thoughts' CHECK (category IN ('AI & tech', 'Apps', 'Games', 'Offers', 'Thoughts')),
  tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags) AND json_type(tags) = 'array'),
  cover_image TEXT,
  link_url TEXT,
  link_label TEXT,
  invite_code TEXT,
  offer_start TEXT,
  offer_end TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'scheduled')),
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  CHECK (status = 'draft' OR published_at IS NOT NULL),
  CHECK (offer_start IS NULL OR offer_end IS NULL OR julianday(offer_start) <= julianday(offer_end))
);
CREATE INDEX IF NOT EXISTS posts_visibility ON posts(status, published_at);
CREATE INDEX IF NOT EXISTS posts_category ON posts(category, published_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO settings(key, value) VALUES
  ('site_name', 'RaisanWall'),
  ('tagline', 'A little corner of the internet, curated by Raisan.'),
  ('description', 'Discover useful apps, AI experiments, games, good deals, and thoughts worth sharing.'),
  ('author_name', 'Raisan'),
  ('author_bio', 'Curious builder. Collector of useful things. Sharing what I discover along the way.'),
  ('launch_date', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('github_url', ''),
  ('contact_url', '');

-- Counts recorded page views, never unique visitors.
CREATE TABLE IF NOT EXISTS visits_daily (
  day TEXT PRIMARY KEY,
  views INTEGER NOT NULL DEFAULT 0 CHECK (views >= 0)
);
CREATE TABLE IF NOT EXISTS visit_limits (
  key TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS visit_limits_expiry ON visit_limits(expires_at);
CREATE TABLE IF NOT EXISTS auth_attempts (
  key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_attempts_expiry ON auth_attempts(window_start);
