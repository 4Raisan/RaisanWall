import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { archiveExpiredOffers } from '../src/lib/offer-lifecycle';
import type { APIRoute } from 'astro';
import type { Env, Post } from '../src/lib/types';
import { constantTimeEqual, createSession, hashedClientKey, isAuthenticated, requireAuth, SESSION_COOKIE, SESSION_SECONDS, sessionCookie, verifySession } from '../src/lib/auth';
import { deriveExcerpt, renderContent } from '../src/lib/content';
import { clearLoginAttempts, createPost, getPostById, getPostBySlug, getPosts, getSettings, getStats, recordVisit, reserveLoginAttempt, updatePost } from '../src/lib/db';
import { detectImage, errorResponse, mediaContentType, readJson, readLimitedBody, validateDate, validatePost, validatePreview, validateQuery, validateSettings, validateUrl, validateVisitPath } from '../src/lib/validation';
import { GET as listPosts, POST as postPost } from '../src/pages/api/posts/index';
import { GET as detailPost, PATCH as patchPost, DELETE as deletePost } from '../src/pages/api/posts/[id]';
import { POST as login } from '../src/pages/api/auth/login';
import { POST as logout } from '../src/pages/api/auth/logout';
import { GET as session } from '../src/pages/api/auth/session';
import { POST as visit } from '../src/pages/api/visit';
import { POST as preview } from '../src/pages/api/preview';
import { POST as upload } from '../src/pages/api/media';
import { GET as rss, xmlEscape } from '../src/pages/rss.xml';
import { GET as getMedia, HEAD as headMedia } from '../src/pages/media/[...key]';

const base = { title: 'Hello, World!', body: '# Hello\n\nA useful **post** & more.' };
const environment = (overrides: Partial<Env> = {}): Env => ({
  ADMIN_PASSWORD: 'a test password', AGENT_TOKEN: 'a-test-agent-token', SESSION_SECRET: 'a-long-test-session-secret-with-entropy',
  DB: undefined as unknown as D1Database, MEDIA: undefined as unknown as R2Bucket, ...overrides,
});
const req = (path = '/api/posts', options: RequestInit = {}) => new Request(`https://wall.test${path}`, options);
const bearer = { Authorization: 'Bearer a-test-agent-token' };
const jsonRequest = (path: string, data: unknown, headers: Record<string, string> = {}, method = 'POST') =>
  req(path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
async function invoke(route: APIRoute, request: Request, env: Env, params = {}): Promise<Response> {
  return await route({ request, url: new URL(request.url), locals: { env }, params } as unknown as Parameters<APIRoute>[0]);
}

// This tiny D1-shaped adapter executes real SQL locally, with no bindings or services.
function memoryD1() {
  const sqlite = new DatabaseSync(':memory:');
  for (const migration of readdirSync(new URL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  }
  function prepare(sql: string) {
    let bindings: SQLInputValue[] = [];
    const result = (results: unknown[], changes = 0) => ({ success: true, results, meta: { changes } });
    const statement = {
      bind: (...values: SQLInputValue[]) => { bindings = values; return statement; },
      first: async () => sqlite.prepare(sql).get(...bindings) ?? null,
      all: async () => result(sqlite.prepare(sql).all(...bindings)),
      run: async () => result([], Number(sqlite.prepare(sql).run(...bindings).changes)),
      batchRun: () => {
        const rows = sqlite.prepare(sql).all(...bindings);
        const changes = Number((sqlite.prepare('SELECT changes() AS n').get() as { n: number }).n);
        return result(rows, changes);
      },
    };
    return statement;
  }
  const db = {
    prepare,
    batch: async (statements: ReturnType<typeof prepare>[]) => {
      sqlite.exec('BEGIN');
      try { const results = statements.map(statement => statement.batchRun()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  } as unknown as D1Database;
  return { db, sqlite };
}

it('migrates existing posts and indexes without losing data', () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
    sqlite.prepare("INSERT INTO posts(id, slug, title, body, status, published_at) VALUES (?, ?, ?, ?, ?, ?)").run('old', 'old', 'Original', 'Text', 'published', '2020-01-01');
    const original = sqlite.prepare('SELECT * FROM posts').get();
    sqlite.exec(readFileSync(new URL('../migrations/0002_offer_lifecycle.sql', import.meta.url), 'utf8'));
    expect(sqlite.prepare('SELECT * FROM posts').get()).toEqual(original);
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'posts_%'").all().map(row => row.name).sort()).toEqual(['posts_category', 'posts_visibility']);
    sqlite.prepare("UPDATE posts SET status = 'archived', published_at = NULL").run();
    expect(sqlite.prepare('SELECT status FROM posts').get()).toMatchObject({ status: 'archived' });
  } finally { sqlite.close(); }
});

describe('post and settings validation', () => {
  it('normalizes a PostInput and derives a plain excerpt', () => {
    const post = validatePost(base);
    expect(post).toMatchObject({ slug: 'hello-world', status: 'draft', published_at: null, tags: [], pinned: false, category: 'Thoughts', format: 'markdown' });
    expect(post.excerpt).toBe('Hello A useful post & more.');
  });
  it.each([
    {}, { ...base, title: '' }, { ...base, title: 'x'.repeat(201) }, { ...base, body: 'x'.repeat(200001) },
    { ...base, excerpt: 'x'.repeat(501) }, { ...base, slug: 'Bad-Slug' }, { ...base, slug: '../hidden' },
    { ...base, slug: 'two--dashes' }, { ...base, category: 'News' }, { ...base, status: 'deleted' },
    { ...base, tags: 'tag' }, { ...base, tags: Array(21).fill('a') }, { ...base, tags: [''] },
    { ...base, pinned: 1 }, { ...base, cover_image: 'data:image/svg+xml,abc' }, { ...base, link_url: 'javascript:alert(1)' },
    { ...base, offer_start: '2026-11-01', offer_end: '2026-10-01' },
  ])('rejects invalid input %#', input => { expect(() => validatePost(input)).toThrow(); });
  it('preserves the existing slug on title edits and accepts an explicit new slug', () => {
    const existing: Post = { ...validatePost(base), id: '1', created_at: '2026-01-01', updated_at: '2026-01-01' };
    expect(validatePost({ title: 'Changed' }, existing).slug).toBe('hello-world');
    expect(validatePost({ slug: 'explicit' }, existing).slug).toBe('explicit');
  });
  it('defaults published_at to now and enforces new scheduled dates', () => {
    const now = new Date('2026-10-28T12:00:00Z');
    expect(validatePost({ ...base, status: 'published' }, undefined, now).published_at).toBe(now.toISOString());
    for (const published_at of [null, 'nope', now.toISOString(), '2020-01-01']) {
      expect(() => validatePost({ ...base, status: 'scheduled', published_at }, undefined, now)).toThrow();
    }
    expect(validatePost({ ...base, status: 'scheduled', published_at: '2099-01-01' }, undefined, now).status).toBe('scheduled');
  });
  it('allows editing already-live scheduled posts, but not backdating a new schedule', () => {
    const existing = { ...validatePost(base), status: 'scheduled', published_at: '2020-01-01T00:00:00.000Z' } as Post;
    expect(validatePost({ title: 'Still live' }, existing).published_at).toBe(existing.published_at);
    expect(validatePost({ published_at: '2020-01-01' }, existing).status).toBe('scheduled');
    expect(() => validatePost({ published_at: '2021-01-01' }, existing)).toThrow();
  });
  it.each(['2026-02-30', '2026-02-29', '2026-13-01', '2026-01-00', '01/01/2026', '2026-01-01T24:00:00Z', '2026-01-01T12:00:00'])('rejects invalid ISO date %s', value => {
    expect(() => validateDate(value)).toThrow();
  });
  it('normalizes ISO offsets and leap days', () => {
    expect(validateDate('2024-02-29')).toBe('2024-02-29T00:00:00.000Z');
    expect(validateDate('2026-01-01T03:00:00+03:00')).toBe('2026-01-01T00:00:00.000Z');
  });
  it.each(['javascript:alert(1)', 'data:text/html,hi', '//evil.test/a', '/media/../evil', '/media/%2e%2e/evil', 'https://u:p@example.com', 'https://example.com\\evil'])('rejects unsafe URL %s', value => {
    expect(() => validateUrl(value, 'cover', true)).toThrow();
  });
  it('allows bounded HTTP(S) URLs and cover paths only', () => {
    expect(validateUrl('/art/cover.svg', 'cover', true)).toBe('/art/cover.svg');
    expect(validateUrl('https://example.com/a?q=b')).toBe('https://example.com/a?q=b');
    expect(() => validateUrl('/art/cover.png')).toThrow();
  });
  it('whitelists settings and rejects oversized and unsafe fields', () => {
    expect(validateSettings({ site_name: 'Wall', ADMIN_PASSWORD: 'never persist' })).toEqual({ site_name: 'Wall' });
    expect(() => validateSettings({ contact_url: 'javascript:alert(1)' })).toThrow();
    expect(() => validateSettings({ author_bio: 'x'.repeat(2001) })).toThrow();
    expect(() => validateSettings({ launch_date: null })).toThrow();
  });
  it('bounds pagination and rejects non-whitelisted sorting', () => {
    expect(validateQuery({ limit: 999 }).limit).toBe(30);
    for (const query of [{ page: 0 }, { page: 1.2 }, { limit: -1 }, { sort: 'title; DROP TABLE posts' }]) expect(() => validateQuery(query)).toThrow();
  });
  it('validates visit paths and previews', () => {
    expect(validateVisitPath('/post/a-good-slug')).toBe('/post/a-good-slug');
    for (const path of ['//evil.test', '/post/../admin', '/studio', '/post/a?q=b']) expect(() => validateVisitPath(path)).toThrow();
    expect(validatePreview({ body: '', format: 'html' })).toEqual({ body: '', format: 'html' });
  });
  it('rejects malformed, non-object, and oversized request bodies', async () => {
    await expect(readJson(req('/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'null' }))).rejects.toThrow();
    await expect(readJson(req('/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }))).rejects.toThrow();
    await expect(readLimitedBody(req('/', { method: 'POST', body: '123456' }), 3)).rejects.toThrow('too large');
    expect(await errorResponse(new Error('a database secret')).json()).toEqual({ error: 'An internal error occurred.' });
  });
});

describe('sanitization and RSS encoding', () => {
  it('retains useful Markdown and removes active HTML', () => {
    const html = renderContent('# Heading\n\n**bold**\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n<details><summary>More</summary>Text</details><script>alert(1)</script>', 'markdown');
    expect(html).toContain('<h1>Heading</h1>');
    expect(html).toContain('<table>');
    expect(html).toContain('<details>');
    expect(html).not.toContain('script');
    expect(html).not.toContain('alert(1)');
  });
  it('removes handlers, CSS, embeds, and unsafe URL schemes', () => {
    const html = renderContent('<p style="color:red" onclick="alert(1)">Safe</p><iframe src="https://evil.test"></iframe><svg onload="alert(1)"></svg><a href="jav&#x61;script:alert(1)">bad</a><img src="data:image/svg+xml,evil" onerror="alert(1)"><img src="//evil.test/a">', 'html');
    expect(html).not.toMatch(/style=|onclick|iframe|svg|javascript:|data:|onerror|\/\/evil/);
    expect(html).toContain('Safe');
  });
  it('forces safe link attributes and permits code/images', () => {
    const html = renderContent('[Link](https://example.com)\n\n![Alt](/media/a.png)\n\n```js\nalert(1)\n```', 'markdown');
    expect(html).toContain('rel="noreferrer noopener"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('src="/media/a.png"');
    expect(html).toContain('class="language-js"');
  });
  it('derives plain text and entity-escapes malicious XML boundaries', () => {
    expect(deriveExcerpt('<p>Hello &amp; <b>world</b></p><script>bad</script>', 'html')).toBe('Hello & world');
    expect(xmlEscape(']]><script>&\u0000')).toBe(']]&gt;&lt;script&gt;&amp;');
    expect(xmlEscape('\ud800text')).toBe('text');
  });
});

describe('authentication without a database', () => {
  it('compares SHA256 digests for equal and unequal values', async () => {
    expect(await constantTimeEqual('abc', 'abc')).toBe(true);
    expect(await constantTimeEqual('abc', 'abcd')).toBe(false);
  });
  it('signs sessions and rejects tampering, expiry, and missing secrets', async () => {
    const now = Date.now();
    const token = await createSession('secret', now);
    expect(await verifySession(token, 'secret', now)).toBe(true);
    expect(await verifySession(token, 'different', now)).toBe(false);
    expect(await verifySession(token.replace('v1.', 'v2.'), 'secret', now)).toBe(false);
    expect(await verifySession(token, 'secret', now + SESSION_SECONDS * 1000)).toBe(false);
    expect(await verifySession(token, '', now)).toBe(false);
    await expect(createSession('')).rejects.toThrow();
  });
  it('sets appropriately scoped secure cookies', () => {
    const value = sessionCookie(req(), 'token');
    expect(value).toContain('HttpOnly; SameSite=Strict; Max-Age=43200; Secure');
    expect(value).toContain('Path=/');
    expect(sessionCookie(new Request('http://localhost/'), 'token')).not.toContain('Secure');
    expect(sessionCookie(req(), '', true)).toContain('Max-Age=0');
  });
  it('enforces cookie Origin and lets bearer credentials bypass CSRF', async () => {
    const env = environment();
    const cookie = `${SESSION_COOKIE}=${await createSession(env.SESSION_SECRET)}`;
    expect(await isAuthenticated(req('/', { headers: { Cookie: cookie } }), env)).toBe(true);
    expect((await requireAuth(req('/', { method: 'POST', headers: { Cookie: cookie } }), env))?.status).toBe(403);
    expect((await requireAuth(req('/', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.test' } }), env))?.status).toBe(403);
    expect(await requireAuth(req('/', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://wall.test' } }), env)).toBeNull();
    expect(await requireAuth(req('/', { method: 'POST', headers: bearer }), env)).toBeNull();
    expect((await requireAuth(req(), env))?.status).toBe(401);
  });
  it('fails closed without configured credentials or with ambiguous cookies', async () => {
    const env = environment();
    const cookie = `${SESSION_COOKIE}=${await createSession(env.SESSION_SECRET)}`;
    expect(await isAuthenticated(req('/', { headers: bearer }), environment({ AGENT_TOKEN: '' }))).toBe(false);
    expect(await isAuthenticated(req('/', { headers: { Cookie: cookie } }), environment({ ADMIN_PASSWORD: '' }))).toBe(false);
    expect(await isAuthenticated(req('/', { headers: { Cookie: `${cookie}; ${cookie}` } }), env)).toBe(false);
    expect(await isAuthenticated(req('/', { headers: { Cookie: cookie, Authorization: 'Bearer wrong' } }), env)).toBe(false);
  });
  it('hashes visitor keys by day, path, minute, and address without global remote buckets', async () => {
    const env = environment();
    const request = req('/', { headers: { 'CF-Connecting-IP': '192.0.2.1' } });
    const now = Date.parse('2026-10-28T12:00:00Z');
    const key = await hashedClientKey(request, env, 'visit', '/', now);
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(key).not.toContain('192.0.2.1');
    expect(await hashedClientKey(request, env, 'visit', '/', now + 1000)).toBe(key);
    expect(await hashedClientKey(request, env, 'visit', '/', now + 60000)).not.toBe(key);
    expect(await hashedClientKey(request, env, 'visit', '/post/one', now)).not.toBe(key);
    expect(await hashedClientKey(request, env, 'visit', '/', now + 86400000)).not.toBe(key);
    expect(await hashedClientKey(req(), env, 'login')).toBeNull();
  });
});

describe('media signatures', () => {
  it.each([
    ['png', [137, 80, 78, 71, 13, 10, 26, 10]], ['jpg', [255, 216, 255]],
    ['gif', [...Buffer.from('GIF89a')]], ['webp', [...Buffer.from('RIFF1234WEBP')]],
    ['avif', [0, 0, 0, 24, ...Buffer.from('ftypavif'), 0, 0, 0, 0, ...Buffer.from('avifmif1')]],
  ] as const)('recognizes %s magic', (extension, signature) => {
    const bytes = new Uint8Array(32); bytes.set(signature);
    expect(detectImage(bytes)).toBe(extension);
  });
  it('rejects SVG, HTML, arbitrary keys, and traversal', () => {
    expect(detectImage(new TextEncoder().encode('<svg onload="alert(1)"></svg>'))).toBeNull();
    expect(detectImage(new TextEncoder().encode('<html>Hello world</html>'))).toBeNull();
    expect(mediaContentType('../secret')).toBeNull();
    expect(mediaContentType('00000000-0000-0000-0000-000000000000.html')).toBeNull();
    expect(mediaContentType('00000000-0000-0000-0000-000000000000.png')).toBe('image/png');
  });
});

describe('D1 SQL and backend endpoints using in-memory SQLite', () => {
  let db: D1Database;
  let sqlite: DatabaseSync;
  let env: Env;
  beforeEach(() => { ({ db, sqlite } = memoryD1()); env = environment({ DB: db }); });
  afterEach(() => { sqlite.close(); vi.useRealTimers(); vi.restoreAllMocks(); });
  async function seed() {
    const published = await createPost(db, validatePost({ ...base, slug: 'published', category: 'Apps', tags: ['useful'], status: 'published', published_at: '2020-01-01' }));
    const scheduled = await createPost(db, validatePost({ ...base, slug: 'scheduled', status: 'scheduled', published_at: '2099-01-01' }));
    sqlite.prepare('UPDATE posts SET published_at = ? WHERE id = ?').run('2020-02-01T00:00:00.000Z', scheduled.id);
    const draft = await createPost(db, validatePost({ ...base, slug: 'draft' }));
    await createPost(db, validatePost({ ...base, slug: 'future', status: 'published', published_at: '2099-01-01' }));
    await createPost(db, validatePost({ ...base, slug: 'future-schedule', status: 'scheduled', published_at: '2099-01-01' }));
    return { published, scheduled, draft };
  }
  it('never leaks drafts/future posts through list, slug, ID, or stats', async () => {
    const { draft, scheduled } = await seed();
    expect((await getPosts(db)).posts.map(post => post.slug)).toEqual(['scheduled', 'published']);
    expect(await getPostBySlug(db, 'draft')).toBeNull();
    expect(await getPostBySlug(db, 'future')).toBeNull();
    expect(await getPostById(db, draft.id)).toBeNull();
    expect((await getPostById(db, draft.id, true))?.status).toBe('draft');
    expect((await getPostById(db, scheduled.id))?.status).toBe('scheduled');
    const stats = await getStats(db);
    expect(stats.posts).toBe(2);
    expect(stats.categories.reduce((sum, row) => sum + row.count, 0)).toBe(2);
    expect(stats.visits).toBe(0);
    expect(Number.isFinite(Date.parse(stats.started_at))).toBe(true);
    expect((await getSettings(db)).site_name).toBe('RaisanWall');
  });
  it('filters and paginates with bound query parameters and whitelisted order', async () => {
    await seed();
    expect((await getPosts(db, { studio: true })).total).toBe(5);
    expect((await getPosts(db, { studio: true, status: 'draft' })).total).toBe(1);
    expect((await getPosts(db, { category: 'Apps', tag: 'useful', q: 'useful' })).total).toBe(1);
    expect((await getPosts(db, { q: "%' OR 1=1 --" })).total).toBe(0);
    expect((await getPosts(db, { q: '%' })).total).toBe(0);
    expect((await getPosts(db, { sort: 'oldest', limit: 1, page: 2 })).posts[0].slug).toBe('scheduled');
    expect((await getPosts(db, { limit: 1 })).pages).toBe(2);
  });
  it('pins only public newest results and keeps date ordering within each group', async () => {
    for (const [slug, published_at, pinned] of [
      ['oldest', '2020-01-01', false], ['pinned-old', '2020-02-01', true],
      ['pinned-new', '2020-03-01', true], ['newest', '2020-04-01', false],
    ] as const) await createPost(db, validatePost({ ...base, slug, published_at, pinned, status: 'published' }));
    expect((await getPosts(db)).posts.map(post => post.slug)).toEqual(['pinned-new', 'pinned-old', 'newest', 'oldest']);
    expect((await getPosts(db, { sort: 'newest', limit: 1, page: 2 })).posts[0].slug).toBe('pinned-old');
    expect((await getPosts(db, { sort: 'oldest' })).posts.map(post => post.slug)).toEqual(['oldest', 'pinned-old', 'pinned-new', 'newest']);
    expect((await getPosts(db, { studio: true })).posts.map(post => post.slug)).toEqual(['newest', 'pinned-new', 'pinned-old', 'oldest']);
  });
  it('returns conflicts without overwriting existing posts', async () => {
    const first = await createPost(db, validatePost(base));
    await expect(createPost(db, validatePost(base))).rejects.toMatchObject({ status: 409 });
    const second = await createPost(db, validatePost({ ...base, slug: 'second' }));
    await expect(updatePost(db, second, validatePost({ slug: first.slug }, second))).rejects.toMatchObject({ status: 409 });
  });
  it('rejects an interleaved update built from the same version without losing the winning edit', async () => {
    const post = await createPost(db, validatePost(base));
    const otherRead = (await getPostById(db, post.id, true))!;
    const results = await Promise.allSettled([
      updatePost(db, post, validatePost({ title: 'Winning edit' }, post)),
      updatePost(db, otherRead, validatePost({ body: 'Stale edit' }, otherRead)),
    ]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { status: 409 } });
    expect(await getPostById(db, post.id, true)).toMatchObject({ title: 'Winning edit', body: base.body });
  });
  it.each([-1000, 0, 1000])('strictly advances updated_at with a clock offset of %i ms', async offset => {
    const post = await createPost(db, validatePost(base));
    const previous = Date.parse(post.updated_at);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(previous + offset);
    const updated = await updatePost(db, post, validatePost({ title: 'Updated' }, post));
    expect(Date.parse(updated.updated_at)).toBe(previous + Math.max(1, offset));
    expect((await getPostById(db, post.id, true))?.updated_at).toBe(updated.updated_at);
  });
  it('returns 404 rather than a stale conflict when the post was deleted', async () => {
    const post = await createPost(db, validatePost(base));
    sqlite.prepare('DELETE FROM posts WHERE id = ?').run(post.id);
    await expect(updatePost(db, post, validatePost({ title: 'Too late' }, post))).rejects.toMatchObject({ status: 404 });
  });
  it('accepts a matching client version and rejects stale versions before validating post fields', async () => {
    const post = await createPost(db, validatePost(base));
    const path = `/api/posts/${post.id}`;
    const patched = await invoke(patchPost, jsonRequest(path, { title: 'Current title', expected_updated_at: post.updated_at }, bearer, 'PATCH'), env, { id: post.id });
    expect(patched.status).toBe(200);
    const current = (await patched.json() as { post: Post }).post;
    expect(current.updated_at).not.toBe(post.updated_at);
    expect(current).not.toHaveProperty('expected_updated_at');
    for (const title of ['Stale title', '']) {
      const stale = await invoke(patchPost, jsonRequest(path, { ...post, title, expected_updated_at: post.updated_at }, bearer, 'PATCH'), env, { id: post.id });
      expect(stale.status).toBe(409);
      expect(stale.headers.get('Cache-Control')).toBe('no-store');
    }
    const invalid = await invoke(patchPost, jsonRequest(path, { title: '', expected_updated_at: current.updated_at }, bearer, 'PATCH'), env, { id: post.id });
    expect(invalid.status).toBe(400);
    expect(await getPostById(db, post.id, true)).toEqual(current);
  });
  it('requires authentication for studio and writes, and keeps private responses no-store', async () => {
    const { draft } = await seed();
    expect((await invoke(listPosts, req('/api/posts?view=studio'), env)).status).toBe(401);
    const studio = await invoke(listPosts, req('/api/posts?view=studio', { headers: bearer }), env);
    expect(studio.headers.get('Cache-Control')).toBe('no-store');
    expect((await studio.json() as { total: number }).total).toBe(5);
    expect((await invoke(detailPost, req(`/api/posts/${draft.id}`), env, { id: draft.id })).status).toBe(404);
    expect((await invoke(detailPost, req(`/api/posts/${draft.id}`, { headers: bearer }), env, { id: draft.id })).status).toBe(200);
    expect((await invoke(postPost, jsonRequest('/api/posts', base), env)).status).toBe(401);
    const created = await invoke(postPost, jsonRequest('/api/posts', { ...base, slug: 'api-created' }, bearer), env);
    expect(created.status).toBe(201);
    const { post } = await created.json() as { post: Post };
    const patched = await invoke(patchPost, jsonRequest(`/api/posts/${post.id}`, { title: 'Changed by API' }, bearer, 'PATCH'), env, { id: post.id });
    expect((await patched.json() as { post: Post }).post.slug).toBe('api-created');
    expect((await invoke(deletePost, req(`/api/posts/${post.id}`, { method: 'DELETE', headers: bearer }), env, { id: post.id })).status).toBe(200);
    expect(await getPostById(db, post.id, true)).toBeNull();
  });
  it('atomically limits logins to five attempts per visitor for fifteen minutes', async () => {
    const now = Date.now();
    for (let n = 0; n < 5; n++) expect(await reserveLoginAttempt(db, 'one', now)).toBe(true);
    expect(await reserveLoginAttempt(db, 'one', now)).toBe(false);
    expect(await reserveLoginAttempt(db, 'two', now)).toBe(true);
    expect(await reserveLoginAttempt(db, 'one', now + 900000)).toBe(true);
    await clearLoginAttempts(db, 'one');
    expect(await reserveLoginAttempt(db, 'one', now + 900000)).toBe(true);
  });
  it('enforces login origin, throttling, cookie sessions, and logout', async () => {
    expect((await invoke(login, jsonRequest('/api/auth/login', { password: env.ADMIN_PASSWORD }), env)).status).toBe(403);
    const headers = { Origin: 'https://wall.test', 'CF-Connecting-IP': '192.0.2.1' };
    for (let n = 0; n < 5; n++) expect((await invoke(login, jsonRequest('/api/auth/login', { password: 'wrong' }, headers), env)).status).toBe(401);
    expect((await invoke(login, jsonRequest('/api/auth/login', { password: env.ADMIN_PASSWORD }, headers), env)).status).toBe(429);
    const success = await invoke(login, jsonRequest('/api/auth/login', { password: env.ADMIN_PASSWORD }, { ...headers, 'CF-Connecting-IP': '192.0.2.2' }), env);
    expect(success.status).toBe(200);
    const Cookie = success.headers.get('Set-Cookie')!.split(';')[0];
    expect(await (await invoke(session, req('/api/auth/session', { headers: { Cookie } }), env)).json()).toEqual({ authenticated: true });
    const exited = await invoke(logout, req('/api/auth/logout', { method: 'POST', headers: { Cookie, Origin: headers.Origin } }), env);
    expect(exited.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });
  it('records atomic page views once per visitor/path/minute without cookies', async () => {
    const now = Date.now();
    expect(await recordVisit(db, 'visitor-a-path-one', now)).toBe(true);
    expect(await recordVisit(db, 'visitor-a-path-one', now)).toBe(false);
    expect(await recordVisit(db, 'visitor-a-path-two', now)).toBe(true);
    expect((await getStats(db)).visits).toBe(2);
    const headers = { Origin: 'https://wall.test', 'CF-Connecting-IP': '192.0.2.5' };
    const first = await invoke(visit, jsonRequest('/api/visit', { path: '/' }, headers), env);
    expect(await first.json()).toEqual({ ok: true, recorded: true });
    expect(first.headers.has('Set-Cookie')).toBe(false);
    expect(await (await invoke(visit, jsonRequest('/api/visit', { path: '/' }, headers), env)).json()).toEqual({ ok: true, recorded: false });
    expect((await invoke(visit, jsonRequest('/api/visit', { path: '/' }, { Origin: 'https://evil.test' }), env)).status).toBe(403);
    expect((await invoke(visit, jsonRequest('/api/visit', { path: '/' }, { 'CF-Connecting-IP': '192.0.2.6' }), env)).status).toBe(200);
  });
  it('previews sanitized HTML and rejects spoofed image MIME types', async () => {
    expect((await invoke(preview, jsonRequest('/api/preview', { body: '# Hi' }), env)).status).toBe(401);
    const result = await invoke(preview, jsonRequest('/api/preview', { body: '<script>bad</script><p>Good</p>', format: 'html' }, bearer), env);
    expect(await result.json()).toEqual({ html: '<p>Good</p>' });
    const form = new FormData(); form.set('file', new Blob(['<svg>evil</svg>'], { type: 'image/png' }), 'picture.png');
    expect((await invoke(upload, req('/api/media', { method: 'POST', headers: bearer, body: form }), env)).status).toBe(415);
  });
  describe.each(['GET', 'HEAD'] as const)('media %s visibility and caching', method => {
    const key = '00000000-0000-0000-0000-000000000000.png';
    const path = `/media/${key}`;
    const metadata = { httpEtag: '"test-image"', size: 3 };
    const get = vi.fn(async (requestedKey: string) => requestedKey === key ? { ...metadata, body: new Blob(['img']).stream() } : null);
    const head = vi.fn(async (requestedKey: string) => requestedKey === key ? metadata : null);
    const route = method === 'HEAD' ? headMedia : getMedia;
    const mediaRequest = (headers: HeadersInit = {}) => invoke(route, req(path, { method, headers }), env, { key });
    beforeEach(() => {
      get.mockClear(); head.mockClear();
      env.MEDIA = { get, head } as unknown as R2Bucket;
    });
    it.each(['cover_image', 'body'])('serves visible %s references with short public caching, including due schedules', async field => {
      const post = await createPost(db, validatePost({ ...base, status: 'published', published_at: '2020-01-01', [field]: field === 'body' ? `![Image](${path})` : path }));
      const response = await mediaRequest();
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('public, max-age=0, s-maxage=30');
      expect(response.headers.get('Content-Type')).toBe('image/png');
      expect(response.headers.get('Content-Length')).toBe('3');
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(await response.text()).toBe(method === 'HEAD' ? '' : 'img');
      expect(method === 'HEAD' ? head : get).toHaveBeenCalledWith(key);
      expect(method === 'HEAD' ? get : head).not.toHaveBeenCalled();
      const conditional = await mediaRequest({ 'If-None-Match': `W/${metadata.httpEtag}` });
      expect(conditional.status).toBe(304);
      expect(conditional.headers.get('Cache-Control')).toBe('public, max-age=0, s-maxage=30');
      sqlite.prepare('UPDATE posts SET status = ? WHERE id = ?').run('scheduled', post.id);
      expect((await mediaRequest()).status).toBe(200);
      expect((await mediaRequest(bearer)).headers.get('Cache-Control')).toBe('public, max-age=0, s-maxage=30');
    });
    it.each([
      { status: 'draft', published_at: null }, { status: 'draft', published_at: '2020-01-01' },
      { status: 'archived', published_at: null }, { status: 'archived', published_at: '2020-01-01' },
      { status: 'published', published_at: '2099-01-01' }, { status: 'scheduled', published_at: '2099-01-01' },
    ])('hides images referenced only by $status posts dated $published_at', async visibility => {
      await createPost(db, validatePost({ ...base, ...visibility, cover_image: path, body: `![Private](${path})` }));
      const denied = await mediaRequest({ 'If-None-Match': '*' });
      expect(denied.status).toBe(404);
      expect(denied.headers.get('Cache-Control')).toBe('no-store');
      expect(denied.headers.has('ETag')).toBe(false);
      expect(get).not.toHaveBeenCalled();
      expect(head).not.toHaveBeenCalled();
      const allowed = await mediaRequest(bearer);
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get('Cache-Control')).toBe('no-store');
    });
    it('requires valid bearer or session authentication for unreferenced uploads', async () => {
      expect((await mediaRequest()).status).toBe(404);
      expect((await mediaRequest({ Authorization: 'Bearer wrong' })).status).toBe(404);
      expect(get).not.toHaveBeenCalled();
      expect(head).not.toHaveBeenCalled();
      const cookie = `${SESSION_COOKIE}=${await createSession(env.SESSION_SECRET)}`;
      for (const headers of [bearer, { Cookie: cookie }]) {
        const response = await mediaRequest(headers);
        expect(response.status).toBe(200);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
      }
      const conditional = await mediaRequest({ ...bearer, 'If-None-Match': metadata.httpEtag });
      expect(conditional.status).toBe(304);
      expect(conditional.headers.get('Cache-Control')).toBe('no-store');
    });
    it('rechecks visibility before returning a conditional response after unpublishing', async () => {
      const post = await createPost(db, validatePost({ ...base, status: 'published', published_at: '2020-01-01', cover_image: path }));
      expect((await mediaRequest()).status).toBe(200);
      await updatePost(db, post, validatePost({ status: 'draft' }, post));
      const response = await mediaRequest({ 'If-None-Match': metadata.httpEtag });
      expect(response.status).toBe(404);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    });
    it('returns 404 for missing objects and forbids SVG even with authentication', async () => {
      const missing = key.replace('.png', '.jpg');
      const response = await invoke(route, req(`/media/${missing}`, { method, headers: bearer }), env, { key: missing });
      expect(response.status).toBe(404);
      get.mockClear(); head.mockClear();
      const svg = key.replace('.png', '.svg');
      expect((await invoke(route, req(`/media/${svg}`, { method, headers: bearer }), env, { key: svg })).status).toBe(404);
      expect(get).not.toHaveBeenCalled();
      expect(head).not.toHaveBeenCalled();
    });
  });
  describe('offer lifecycle', () => {
    const key = '00000000-0000-0000-0000-000000000000.png';
    const path = `/media/${key}`;
    const now = new Date('2026-10-28T12:00:00.000Z');
    const expired = { ...base, status: 'published', published_at: '2020-01-01', offer_end: '2026-10-25T12:00:00Z', pinned: true };
    let remove: ReturnType<typeof vi.fn>;
    beforeEach(() => { remove = vi.fn(async () => {}); env.MEDIA = { delete: remove } as unknown as R2Bucket; });
    it('archives at exactly 72 hours, preserves text, and is private in lists, stats and RSS', async () => {
      const post = await createPost(db, validatePost({ ...expired, body: `Words ![Caption](${path}) **remain** ![Art](/art/a.svg) ![External](https://other.test/a.png)`, cover_image: path }));
      await archiveExpiredOffers(env, new Date(now.getTime() - 1));
      expect((await getPostById(db, post.id, true))?.status).toBe('published');
      await archiveExpiredOffers(env, now);
      const archived = (await getPostById(db, post.id, true))!;
      expect(archived).toMatchObject({ status: 'archived', pinned: false, cover_image: null, title: post.title, excerpt: post.excerpt });
      expect(archived.body).toBe('Words Caption **remain** ![Art](/art/a.svg) ![External](https://other.test/a.png)');
      expect(Date.parse(archived.updated_at)).toBeGreaterThan(Date.parse(post.updated_at));
      expect(await getPostById(db, post.id)).toBeNull();
      expect(await getPostBySlug(db, post.slug)).toBeNull();
      expect((await getPosts(db)).total).toBe(0);
      expect((await getStats(db)).posts).toBe(0);
      expect((await getPosts(db, { studio: true, status: 'archived' })).total).toBe(1);
      expect(await (await invoke(rss, req('/rss.xml'), env)).text()).not.toContain(`/post/${post.slug}`);
      expect(remove).toHaveBeenCalledExactlyOnceWith(key);
      await archiveExpiredOffers(env, now);
      expect(remove).toHaveBeenCalledTimes(1);
      await expect(updatePost(db, post, validatePost({ title: 'Stale' }, post))).rejects.toMatchObject({ status: 409 });
    });
    it('excludes drafts, future schedules, future publications and no end date, but includes live schedules in any category', async () => {
      for (const [slug, status, published_at, offer_end] of [
        ['draft-expired', 'draft', null, expired.offer_end],
        ['future-expired', 'scheduled', '2099-01-01', expired.offer_end],
        ['future-published', 'published', '2099-01-01', expired.offer_end],
        ['no-end', 'published', '2020-01-01', null],
        ['live-schedule', 'scheduled', '2099-01-01', expired.offer_end],
      ]) await createPost(db, validatePost({ ...base, slug, status, published_at, offer_end, category: 'Apps' }));
      sqlite.prepare("UPDATE posts SET published_at = '2020-01-01' WHERE slug = 'live-schedule'").run();
      await archiveExpiredOffers(env, now);
      expect((await getPosts(db, { studio: true, status: 'archived' })).posts.map(p => p.slug)).toEqual(['live-schedule']);
      expect(remove).not.toHaveBeenCalled();
      const manual = await createPost(db, validatePost({ ...base, slug: 'manual-archive', status: 'archived' }));
      expect(manual.published_at).toBeNull();
    });
    it.each(['draft', 'scheduled', 'archived', 'published'])('retains shared images referenced by %s, then retries after removal', async status => {
      const post = await createPost(db, validatePost({ ...expired, format: 'html', body: `<p>Keep <b>text</b></p><img src='${path}' alt='Caption'><img src='/art/a.svg'><img src='https://other.test/a.png'>`, cover_image: path }));
      const shared = await createPost(db, validatePost({ ...base, slug: 'shared', status, published_at: status === 'scheduled' ? '2099-01-01' : '2020-01-01', link_url: `https://wall.test${path}` }));
      await archiveExpiredOffers(env, now);
      expect(remove).not.toHaveBeenCalled();
      expect((await getPostById(db, post.id, true))?.body).toBe("<p>Keep <b>text</b></p>Caption<img src='/art/a.svg'><img src='https://other.test/a.png'>");
      await updatePost(db, shared, validatePost({ link_url: null }, shared));
      await archiveExpiredOffers(env, now);
      expect(remove).toHaveBeenCalledExactlyOnceWith(key);
    });
    it.each(['body', 'cover_image'])('retains a draft %s reference until removed', async field => {
      await createPost(db, validatePost({ ...expired, cover_image: path }));
      const draft = await createPost(db, validatePost({ ...base, slug: 'shared-draft', [field]: field === 'body' ? `![Shared](${path})` : path }));
      await archiveExpiredOffers(env, now);
      expect(remove).not.toHaveBeenCalled();
      await updatePost(db, draft, validatePost({ body: 'Retained words', cover_image: null }, draft));
      await archiveExpiredOffers(env, now);
      expect(remove).toHaveBeenCalledExactlyOnceWith(key);
    });
    it('detaches reference-style Markdown images without losing words', async () => {
      const post = await createPost(db, validatePost({ ...expired, body: `Before ![Caption][image] after.\n\n[image]: ${path}\n` }));
      await archiveExpiredOffers(env, now);
      expect((await getPostById(db, post.id, true))?.body).toBe('Before Caption after.\n\n');
      expect(remove).toHaveBeenCalledExactlyOnceWith(key);
    });
    it('retains failed claims and blocks concurrent or later attachments, including encoded references', async () => {
      await createPost(db, validatePost({ ...expired, cover_image: path }));
      const draft = await createPost(db, validatePost({ ...base, slug: 'draft-target' }));
      remove.mockImplementationOnce(async () => {
        await expect(createPost(db, validatePost({ ...base, slug: 'too-late', cover_image: path }))).rejects.toThrow('retired');
        await expect(updatePost(db, draft, validatePost({ body: `<img src="${path.replaceAll('-', '&#45;')}">` }, draft))).rejects.toThrow('retired');
        throw new Error('R2 unavailable');
      });
      await archiveExpiredOffers(env, now);
      expect(sqlite.prepare('SELECT state FROM media_cleanup').get()).toMatchObject({ state: 'claimed' });
      await archiveExpiredOffers(env, now);
      expect(remove).toHaveBeenCalledTimes(2);
      expect(sqlite.prepare('SELECT state FROM media_cleanup').get()).toMatchObject({ state: 'deleted' });
      await expect(updatePost(db, draft, validatePost({ cover_image: path }, draft))).rejects.toThrow('retired');
    });
    it('invalidates cleanup snapshots when a new reference wins before the claim', async () => {
      await createPost(db, validatePost({ ...expired, cover_image: path }));
      const prepare = db.prepare.bind(db);
      let inserted = false;
      vi.spyOn(db, 'prepare').mockImplementation(sql => {
        if (sql.includes("SET state = 'claimed'") && !inserted) {
          inserted = true;
          sqlite.prepare(`INSERT INTO posts(id, slug, title, body) VALUES ('racer', 'racer', 'Racer', ?)`).run(path);
        }
        return prepare(sql);
      });
      await archiveExpiredOffers(env, now);
      expect(remove).not.toHaveBeenCalled();
      await archiveExpiredOffers(env, now);
      expect(remove).not.toHaveBeenCalled();
    });
    it('does not archive or queue from a stale cron snapshot', async () => {
      const post = await createPost(db, validatePost({ ...expired, cover_image: path }));
      const batch = db.batch.bind(db);
      let changed = false;
      vi.spyOn(db, 'batch').mockImplementation(async statements => {
        if (!changed) {
          changed = true;
          await updatePost(db, post, validatePost({ offer_end: '2099-01-01', title: 'Extended' }, post));
        }
        return batch(statements);
      });
      await archiveExpiredOffers(env, now);
      expect((await getPostById(db, post.id, true))?.title).toBe('Extended');
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM media_cleanup').get()).toMatchObject({ n: 0 });
      expect(remove).not.toHaveBeenCalled();
    });
  });
  it('RSS includes only visible posts and safe XML with absolute links', async () => {
    await seed();
    const response = await invoke(rss, req('/rss.xml'), env);
    const xml = await response.text();
    expect(response.headers.get('Content-Type')).toContain('application/rss+xml');
    expect(xml).toContain('https://wall.test/post/published');
    expect(xml).toContain('https://wall.test/post/scheduled');
    expect(xml).not.toContain('https://wall.test/post/draft');
    expect(xml).not.toContain('https://wall.test/post/future');
    expect(xml).toContain('&lt;h1&gt;Hello&lt;/h1&gt;');
  });
});
