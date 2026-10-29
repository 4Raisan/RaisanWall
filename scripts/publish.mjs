import { readFileSync, existsSync } from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/publish.mjs post.json [post-id]\nSet RAISANWALL_URL and RAISANWALL_TOKEN for a remote wall. Defaults to the local development wall.'); process.exit(1); }
const base = (process.env.RAISANWALL_URL || 'http://127.0.0.1:4321').replace(/\/$/, '');
let token = process.env.RAISANWALL_TOKEN;
if (!token && ['localhost', '127.0.0.1'].includes(new URL(base).hostname) && existsSync('.dev.vars')) {
  const match = /^AGENT_TOKEN=(.+)$/m.exec(readFileSync('.dev.vars', 'utf8'));
  if (match) token = match[1].trim().replace(/^"|"$/g, '');
}
if (!token) { console.error('Set RAISANWALL_TOKEN in your environment.'); process.exit(1); }
if (new URL(base).protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(new URL(base).hostname)) { console.error('Remote publishing requires HTTPS.'); process.exit(1); }
try {
  const body = JSON.parse(readFileSync(file, 'utf8'));
  if (!body.status) body.status = 'draft';
  const id = process.argv[3];
  const response = await fetch(`${base}/api/posts${id ? `/${encodeURIComponent(id)}` : ''}`, { method: id ? 'PATCH' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  console.log(JSON.stringify({ id: data.post.id, slug: data.post.slug, status: data.post.status, url: `${base}/post/${data.post.slug}` }, null, 2));
} catch (error) { console.error(error.message); process.exit(1); }
