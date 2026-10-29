import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const base = process.env.TEST_URL || 'http://127.0.0.1:4321';
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname), 'Lifecycle tests only run locally.');
const token = JSON.parse(/^AGENT_TOKEN=(.+)$/m.exec(readFileSync('.dev.vars', 'utf8'))[1]);
const authorization = { Authorization: `Bearer ${token}` };
const ids = [];
const unique = `lifecycle-${Date.now()}`;
let count = 0;
function check(label, condition) { assert(condition, label); console.log(`PASS ${label}`); count++; }
async function api(path, method = 'GET', data) {
  const response = await fetch(`${base}${path}`, { method, headers: { ...authorization, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  assert(response.ok, `${method} ${path}: ${response.status}`);
  return response.json();
}
async function create(slug, data) {
  const { post } = await api('/api/posts', 'POST', { title: 'Lifecycle verification', body: 'Keep these words.', slug: `${unique}-${slug}`, ...data });
  ids.push(post.id);
  return post;
}
async function upload() {
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1kAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), 'fixture.png');
  const response = await fetch(`${base}/api/media`, { method: 'POST', headers: authorization, body: form });
  assert.equal(response.status, 201);
  return (await response.json()).url;
}
async function trigger() {
  const response = await fetch(`${base}/cdn-cgi/handler/scheduled?cron=0%20*%20*%20*%20*&format=json`);
  assert.equal(response.status, 200, await response.text());
}
try {
  const media = await upload();
  const shared = await upload();
  const due = { status: 'published', published_at: new Date(Date.now() - 7 * 86400000).toISOString(), offer_end: new Date(Date.now() - 4 * 86400000).toISOString() };
  const expired = await create('expired', { ...due, cover_image: media, body: `Keep these words. ![Old cover](${media}) ![Shared](${shared})` });
  const draft = await create('draft', { status: 'draft', cover_image: shared, offer_end: due.offer_end });
  const grace = await create('grace', { ...due, offer_end: new Date(Date.now() - 2 * 86400000).toISOString() });
  await trigger();
  const archived = (await api(`/api/posts/${expired.id}`)).post;
  check('real scheduled handler archives expired offers', archived.status === 'archived');
  check('archive retains text and detaches uploaded images', archived.cover_image === null && archived.body === 'Keep these words. Old cover Shared');
  check('archived offer is hidden from visitors', (await fetch(`${base}/api/posts/${expired.id}`)).status === 404);
  check('unshared object is deleted from R2 even for owner', (await fetch(`${base}${media}`, { method: 'HEAD', headers: authorization })).status === 404);
  check('shared draft object remains in R2', (await fetch(`${base}${shared}`, { method: 'HEAD', headers: authorization })).status === 200);
  check('draft and grace-period offer remain unchanged', (await api(`/api/posts/${draft.id}`)).post.status === 'draft' && (await api(`/api/posts/${grace.id}`)).post.status === 'published');
  await api(`/api/posts/${draft.id}`, 'PATCH', { cover_image: null });
  await trigger();
  check('queued object is deleted after final reference is removed', (await fetch(`${base}${shared}`, { method: 'HEAD', headers: authorization })).status === 404);
  await trigger();
  check('repeated scheduled invocation is safe', (await api(`/api/posts/${expired.id}`)).post.status === 'archived');
  console.log(`\n${count} lifecycle checks passed.`);
} finally {
  for (const id of ids) await api(`/api/posts/${id}`, 'DELETE');
}
