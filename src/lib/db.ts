import { CATEGORIES, type Post, type PostQuery, type PostsResult, type Settings, type Stats, type ValidatedPost } from './types';
import { HttpError, validateQuery } from './validation';
import { mediaWritable, referencedMedia } from './offer-lifecycle';

interface PostRow extends Omit<Post, 'tags' | 'pinned'> { tags: string; pinned: number }
function toPost(row: PostRow): Post { return { ...row, tags: JSON.parse(row.tags), pinned: row.pinned === 1 }; }
const visible = "status IN ('published', 'scheduled') AND published_at IS NOT NULL AND julianday(published_at) <= julianday(?)";

export async function getPosts(db: D1Database, query: PostQuery = {}): Promise<PostsResult> {
  const options = validateQuery(query);
  const clauses: string[] = [];
  const bindings: (string | number)[] = [];
  if (!options.studio) { clauses.push(visible); bindings.push(new Date().toISOString()); }
  else if (options.status) { clauses.push('status = ?'); bindings.push(options.status); }
  if (options.category) { clauses.push('category = ?'); bindings.push(options.category); }
  if (options.tag) { clauses.push('EXISTS (SELECT 1 FROM json_each(posts.tags) WHERE json_each.value = ?)'); bindings.push(options.tag); }
  if (options.q) {
    const term = `%${options.q.replace(/[\\%_]/g, '\\$&')}%`;
    clauses.push("(title LIKE ? ESCAPE '\\' OR excerpt LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')");
    bindings.push(term, term, term);
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  // Only these hard-coded orderings and predicates can become SQL syntax.
  const direction = options.sort === 'oldest' ? 'ASC' : 'DESC';
  const prefix = !options.studio && options.sort === 'newest' ? 'pinned DESC, ' : '';
  const results = await db.batch([
    db.prepare(`SELECT COUNT(*) AS total FROM posts${where}`).bind(...bindings),
    db.prepare(`SELECT * FROM posts${where} ORDER BY ${prefix}COALESCE(published_at, created_at) ${direction}, id ${direction} LIMIT ? OFFSET ?`)
      .bind(...bindings, options.limit, (options.page - 1) * options.limit),
  ]);
  const total = Number((results[0].results[0] as { total: number }).total);
  return { posts: (results[1].results as unknown as PostRow[]).map(toPost), total, page: options.page, pages: Math.ceil(total / options.limit) };
}

export async function getPostBySlug(db: D1Database, slug: string): Promise<Post | null> {
  const row = await db.prepare(`SELECT * FROM posts WHERE slug = ? AND ${visible}`).bind(slug, new Date().toISOString()).first<PostRow>();
  return row ? toPost(row) : null;
}

export async function getPostById(db: D1Database, id: string, includePrivate = false): Promise<Post | null> {
  const statement = includePrivate
    ? db.prepare('SELECT * FROM posts WHERE id = ?').bind(id)
    : db.prepare(`SELECT * FROM posts WHERE id = ? AND ${visible}`).bind(id, new Date().toISOString());
  const row = await statement.first<PostRow>();
  return row ? toPost(row) : null;
}

const columns = [
  'slug', 'title', 'excerpt', 'body', 'format', 'category', 'tags', 'cover_image',
  'link_url', 'link_label', 'invite_code', 'offer_start', 'offer_end', 'status', 'published_at', 'pinned',
] as const;
function values(post: ValidatedPost): (string | number | null)[] {
  return columns.map(key => key === 'tags' ? JSON.stringify(post.tags) : key === 'pinned' ? Number(post.pinned) : post[key]) as (string | number | null)[];
}
function databaseError(error: unknown): never {
  if (error instanceof Error && /UNIQUE constraint failed: posts\.slug/i.test(error.message + String(error.cause ?? ''))) {
    throw new HttpError('That slug is already in use.', 409);
  }
  throw error;
}

export async function createPost(db: D1Database, data: ValidatedPost): Promise<Post> {
  const now = new Date().toISOString();
  const post: Post = { ...data, id: crypto.randomUUID(), created_at: now, updated_at: now };
  try {
    const inserted = await db.prepare(`INSERT INTO posts (id, ${columns.join(', ')}, created_at, updated_at)
      SELECT ${Array(columns.length + 3).fill('?').join(', ')} WHERE ${mediaWritable} RETURNING id`)
      .bind(post.id, ...values(data), now, now, JSON.stringify(referencedMedia(data))).first();
    if (!inserted) throw new HttpError('An image has been retired for cleanup. Upload it again before attaching it.', 409);
  } catch (error) { databaseError(error); }
  return post;
}

export async function updatePost(db: D1Database, existing: Post, data: ValidatedPost): Promise<Post> {
  // Advance the version even for same-millisecond writes or a clock moving backwards.
  const now = new Date(Math.max(Date.now(), Date.parse(existing.updated_at) + 1)).toISOString();
  try {
    const row = await db.prepare(`UPDATE posts SET ${columns.map(key => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND updated_at = ? AND ${mediaWritable} RETURNING *`)
      .bind(...values(data), now, existing.id, existing.updated_at, JSON.stringify(referencedMedia(data))).first<PostRow>();
    if (!row) {
      const exists = await db.prepare('SELECT updated_at FROM posts WHERE id = ?').bind(existing.id).first<{ updated_at: string }>();
      if (exists?.updated_at === existing.updated_at) throw new HttpError('An image has been retired for cleanup. Upload it again before attaching it.', 409);
      if (exists) throw new HttpError('Post has changed. Reload and try again.', 409);
      throw new HttpError('Post not found.', 404);
    }
    return toPost(row);
  } catch (error) { return databaseError(error); }
}

export async function deletePost(db: D1Database, id: string): Promise<void> {
  const result = await db.prepare('DELETE FROM posts WHERE id = ?').bind(id).run();
  if (!result.meta.changes) throw new HttpError('Post not found.', 404);
}

export async function getSettings(db: D1Database): Promise<Settings> {
  const defaults: Settings = {
    site_name: 'RaisanWall', tagline: 'A little corner of the internet, curated by Raisan.',
    description: 'Discover useful apps, AI experiments, games, good deals, and thoughts worth sharing.',
    author_name: 'Raisan', author_bio: 'Curious builder. Collector of useful things. Sharing what I discover along the way.',
    launch_date: new Date().toISOString(), github_url: '', contact_url: '',
  };
  const rows = await db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  for (const row of rows.results) if (Object.hasOwn(defaults, row.key)) defaults[row.key as keyof Settings] = row.value;
  return defaults;
}

export async function updateSettings(db: D1Database, data: Partial<Settings>): Promise<Settings> {
  const allowed = ['site_name', 'tagline', 'description', 'author_name', 'author_bio', 'launch_date', 'github_url', 'contact_url'];
  const statements = Object.entries(data).filter(([key]) => allowed.includes(key)).map(([key, value]) =>
    db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value));
  if (statements.length) await db.batch(statements);
  return getSettings(db);
}

export async function getStats(db: D1Database): Promise<Stats> {
  const now = new Date().toISOString();
  const [settings, results] = await Promise.all([
    getSettings(db),
    db.batch([
      db.prepare(`SELECT COUNT(*) AS posts, MAX(updated_at) AS last_updated FROM posts WHERE ${visible}`).bind(now),
      db.prepare('SELECT COALESCE(SUM(views), 0) AS visits FROM visits_daily'),
      db.prepare(`SELECT category, COUNT(*) AS count FROM posts WHERE ${visible} GROUP BY category`).bind(now),
    ]),
  ]);
  const totals = results[0].results[0] as { posts: number; last_updated: string | null };
  const counts = results[2].results as { category: string; count: number }[];
  return {
    posts: Number(totals.posts), visits: Number((results[1].results[0] as { visits: number }).visits),
    started_at: settings.launch_date, last_updated: totals.last_updated,
    categories: CATEGORIES.map(category => ({ category, count: Number(counts.find(row => row.category === category)?.count ?? 0) })),
  };
}

/** Reserve before checking credentials, so concurrent attempts cannot bypass the limit. */
export async function reserveLoginAttempt(db: D1Database, key: string, now = Date.now()): Promise<boolean> {
  const seconds = Math.floor(now / 1000);
  const results = await db.batch([
    db.prepare('DELETE FROM auth_attempts WHERE window_start <= ?').bind(seconds - 172800),
    db.prepare(`INSERT INTO auth_attempts(key, failures, window_start) VALUES (?, 1, ?)
      ON CONFLICT(key) DO UPDATE SET
        failures = CASE WHEN window_start <= ? THEN 1 ELSE failures + 1 END,
        window_start = CASE WHEN window_start <= ? THEN excluded.window_start ELSE window_start END
      WHERE window_start <= ? OR failures < 5 RETURNING failures`)
      .bind(key, seconds, seconds - 900, seconds - 900, seconds - 900),
  ]);
  return results[1].results.length > 0;
}

export async function clearLoginAttempts(db: D1Database, key: string): Promise<void> {
  await db.prepare('DELETE FROM auth_attempts WHERE key = ?').bind(key).run();
}

/** Transactional, one recorded page view per salted visitor/path/minute key. */
export async function recordVisit(db: D1Database, key: string, now = Date.now()): Promise<boolean> {
  const seconds = Math.floor(now / 1000);
  const day = new Date(now).toISOString().slice(0, 10);
  const results = await db.batch([
    db.prepare('DELETE FROM visit_limits WHERE expires_at <= ?').bind(seconds),
    db.prepare('INSERT INTO visit_limits(key, expires_at) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').bind(key, (Math.floor(seconds / 60) + 1) * 60),
    // changes() is connection-local and D1 batch executes sequentially in a transaction.
    db.prepare(`INSERT INTO visits_daily(day, views) SELECT ?, 1 WHERE changes() = 1
      ON CONFLICT(day) DO UPDATE SET views = views + 1`).bind(day),
  ]);
  return results[2].meta.changes > 0;
}
