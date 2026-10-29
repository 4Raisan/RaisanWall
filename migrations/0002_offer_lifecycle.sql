CREATE TABLE posts_new (
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
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'scheduled', 'archived')),
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  CHECK (status IN ('draft', 'archived') OR published_at IS NOT NULL),
  CHECK (offer_start IS NULL OR offer_end IS NULL OR julianday(offer_start) <= julianday(offer_end))
);
INSERT INTO posts_new SELECT * FROM posts;
DROP TABLE posts;
ALTER TABLE posts_new RENAME TO posts;
CREATE INDEX posts_visibility ON posts(status, published_at);
CREATE INDEX posts_category ON posts(category, published_at);
CREATE TABLE media_cleanup (
  key TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'claimed', 'deleted'))
);
-- Any post mutation invalidates a cleanup reference snapshot.
CREATE TABLE posts_revision (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
INSERT INTO posts_revision VALUES (1, 0);
CREATE TRIGGER posts_revision_insert AFTER INSERT ON posts BEGIN
  UPDATE posts_revision SET version = version + 1 WHERE id = 1;
END;
CREATE TRIGGER posts_revision_update AFTER UPDATE ON posts BEGIN
  UPDATE posts_revision SET version = version + 1 WHERE id = 1;
END;
CREATE TRIGGER posts_revision_delete AFTER DELETE ON posts BEGIN
  UPDATE posts_revision SET version = version + 1 WHERE id = 1;
END;
