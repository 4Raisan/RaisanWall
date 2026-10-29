import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const base = process.env.TEST_URL || 'http://127.0.0.1:4321';
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname), 'Integration tests only run against a local wall.');
const vars = Object.fromEntries(readFileSync('.dev.vars', 'utf8').split(/\r?\n/).filter(line => /^[A-Z_]+=/.test(line)).map(line => { const [key, ...parts] = line.split('='); return [key, JSON.parse(parts.join('='))]; }));
const token = vars.AGENT_TOKEN;
const ids = [];
const unique = `test-${Date.now()}`;
let count = 0;
async function call(path, { method = 'GET', data, auth = false, cookie, origin, headers = {}, body } = {}) {
  const response = await fetch(`${base}${path}`, { method, headers: { ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(auth ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}), ...headers }, body: body ?? (data !== undefined ? JSON.stringify(data) : undefined), redirect: 'manual' });
  const text = await response.text();
  let result; try { result = JSON.parse(text); } catch { result = text; }
  return { response, status: response.status, data: result, text };
}
function check(name, condition) { assert(condition, name); count++; console.log(`PASS ${name}`); }
async function create(data) { const result = await call('/api/posts', { method: 'POST', data: { title: 'Integration sample', body: '## A private test\n\nSafe **content**.', category: 'Thoughts', tags: ['integration-test'], ...data }, auth: true }); assert.equal(result.status, 201, result.text); ids.push(result.data.post.id); return result.data.post; }
try {
  const wall = await call('/'); check('public wall renders without login', wall.status === 200 && wall.text.includes('worth sharing'));
  check('security headers present', wall.response.headers.get('x-content-type-options') === 'nosniff' && !!wall.response.headers.get('content-security-policy'));
  const badQuery = await call('/?category=not-real&page=abc&tag=%00hello'); check('invalid public filters do not crash the page', badQuery.status === 200);
  check('writes require credentials', (await call('/api/posts', { method: 'POST', data: { title: 'No', body: 'No' } })).status === 401);
  check('studio listing is protected', (await call('/api/posts?view=studio')).status === 401);
  const draft = await create({ slug: `${unique}-draft`, status: 'draft' });
  check('anonymous cannot retrieve a draft', (await call(`/api/posts/${draft.id}`)).status === 404);
  check('draft detail page is 404', (await call(`/post/${draft.slug}`)).status === 404);
  check('draft absent from search', (await call(`/api/posts?q=${unique}`)).data.total === 0);
  const scheduled = await create({ slug: `${unique}-scheduled`, status: 'scheduled', published_at: new Date(Date.now() + 86400000).toISOString() });
  check('scheduled post hidden before publication', (await call(`/api/posts/${scheduled.id}`)).status === 404);
  check('duplicate slug rejected', (await call('/api/posts', { method: 'POST', auth: true, data: { title: 'Duplicate', body: 'Text', slug: draft.slug } })).status === 409);
  check('bad offer dates rejected', (await call('/api/posts', { method: 'POST', auth: true, data: { title: 'Bad dates', body: 'Text', offer_start: '2030-01-02', offer_end: '2030-01-01' } })).status === 400);
  check('unsafe destination rejected', (await call('/api/posts', { method: 'POST', auth: true, data: { title: 'Bad URL', body: 'Text', link_url: 'javascript:alert(1)' } })).status === 400);
  const preview = await call('/api/preview', { method: 'POST', auth: true, data: { format: 'html', body: '<h2>Heading</h2><script>alert(1)</script><img src="/art/focus-space.svg" onerror="alert(2)"><a href="javascript:alert(3)">Bad</a><p>Safe paragraph</p>' } });
  check('HTML preview strips unsafe content', preview.status === 200 && !/script|onerror|javascript:/.test(preview.data.html) && preview.data.html.includes('<h2>Heading</h2>'));
  const markdown = await call('/api/preview', { method: 'POST', auth: true, data: { format: 'markdown', body: '## Heading\n\n**Bold** text.\n\n- One\n- Two' } });
  check('Markdown renders headings and lists', markdown.data.html.includes('<h2>') && markdown.data.html.includes('<ul>'));
  const published = await call(`/api/posts/${draft.id}`, { method: 'PATCH', auth: true, data: { status: 'published', title: `${unique} published`, expected_updated_at: draft.updated_at } });
  check('agent can publish a draft', published.status === 200 && published.data.post.status === 'published');
  check('published post appears publicly', (await call(`/api/posts/${draft.id}`)).status === 200);
  const detail = await call(`/post/${draft.slug}`); check('published detail renders Markdown', detail.status === 200 && detail.text.includes('<h2>A private test</h2>'));
  check('stale editor cannot overwrite newer changes', (await call(`/api/posts/${draft.id}`, { method: 'PATCH', auth: true, data: { title: 'Stale', expected_updated_at: draft.updated_at } })).status === 409);
  const rss = await call('/rss.xml'); check('RSS exposes published posts but not drafts or schedules', rss.status === 200 && rss.text.includes(draft.slug) && !rss.text.includes(scheduled.slug));
  const before = (await call('/api/stats')).data.visits;
  const visit = await call('/api/visit', { method: 'POST', origin: base, data: { path: `/post/${draft.slug}` } });
  const duplicateVisit = await call('/api/visit', { method: 'POST', origin: base, data: { path: `/post/${draft.slug}` } });
  const after = (await call('/api/stats')).data.visits;
  check('visits counted once per path and minute', visit.data.recorded === true && duplicateVisit.data.recorded === false && after === before + 1);
  check('cross-origin analytics rejected', (await call('/api/visit', { method: 'POST', origin: 'https://untrusted.invalid', data: { path: '/' } })).status === 403);
  const login = await call('/api/auth/login', { method: 'POST', origin: base, data: { password: vars.ADMIN_PASSWORD } });
  const cookie = login.response.headers.get('set-cookie')?.split(';')[0];
  check('Studio sign-in sets HttpOnly strict cookie', login.status === 200 && !!cookie && /HttpOnly/.test(login.response.headers.get('set-cookie')) && /SameSite=Strict/.test(login.response.headers.get('set-cookie')));
  check('cookie can access private studio', (await call('/studio', { cookie })).text.includes('Your wall, your words'));
  check('Studio responses cannot be cached', (await call('/studio', { cookie })).response.headers.get('cache-control') === 'no-store');
  check('cookie writes require matching origin', (await call(`/api/posts/${draft.id}`, { method: 'PATCH', cookie, origin: 'https://untrusted.invalid', data: { title: 'CSRF' } })).status === 403);
  check('cookie writes work with matching origin', (await call(`/api/posts/${draft.id}`, { method: 'PATCH', cookie, origin: base, data: { excerpt: 'Updated in the Studio' } })).status === 200);
  const image = new FormData(); image.append('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1kAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), 'test.png');
  const upload = await call('/api/media', { method: 'POST', auth: true, body: image }); check('image upload succeeds', upload.status === 201 || upload.status === 200);
  const media = upload.data.url; assert(media, upload.text);
  check('unpublished image is private', (await call(media)).status === 404);
  check('owner can preview an unpublished image', (await call(media, { auth: true })).status === 200);
  await call(`/api/posts/${draft.id}`, { method: 'PATCH', auth: true, data: { cover_image: media } });
  check('published image becomes public', (await call(media)).status === 200);
  const svg = new FormData(); svg.append('file', new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], { type: 'image/svg+xml' }), 'bad.svg');
  check('SVG uploads rejected', (await call('/api/media', { method: 'POST', auth: true, body: svg })).status === 415);
  await call(`/api/posts/${draft.id}`, { method: 'PATCH', auth: true, data: { status: 'draft' } });
  check('unpublished post disappears', (await call(`/api/posts/${draft.id}`)).status === 404);
  check('unpublished cover loses anonymous access', (await call(media)).status === 404);
  const session = await call('/api/auth/session', { cookie }); check('session endpoint recognizes sign-in', session.data.authenticated === true);
  const logout = await call('/api/auth/logout', { method: 'POST', origin: base, cookie }); check('sign-out clears session cookie', logout.status === 200 && /Max-Age=0/.test(logout.response.headers.get('set-cookie')));
  const ip = { 'CF-Connecting-IP': '192.0.2.77' };
  for (let i = 0; i < 5; i++) await call('/api/auth/login', { method: 'POST', origin: base, headers: ip, data: { password: 'intentionally-incorrect' } });
  check('login attempts are rate limited', (await call('/api/auth/login', { method: 'POST', origin: base, headers: ip, data: { password: 'intentionally-incorrect' } })).status === 429);
  console.log(`\n${count} integration checks passed.`);
} finally {
  for (const id of ids) await call(`/api/posts/${id}`, { method: 'DELETE', auth: true });
}
