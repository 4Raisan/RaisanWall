import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { samplePosts } from './sample-posts.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const varsPath = resolve(root, '.dev.vars');
if (!existsSync(varsPath)) {
  const values = { ADMIN_PASSWORD: randomBytes(18).toString('base64url'), AGENT_TOKEN: `rw_${randomBytes(32).toString('hex')}`, SESSION_SECRET: randomBytes(48).toString('hex') };
  writeFileSync(varsPath, Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
}
const vars = Object.fromEntries(readFileSync(varsPath, 'utf8').split(/\r?\n/).filter(line => /^[A-Z_]+=/.test(line)).map(line => { const [key, ...parts] = line.split('='); const raw = parts.join('='); return [key, raw.startsWith('"') ? JSON.parse(raw) : raw]; }));
if (vars.ADMIN_PASSWORD && vars.AGENT_TOKEN) {
  writeFileSync(resolve(root, 'local-access.txt'), `RAISANWALL — LOCAL ACCESS ONLY\n\nStudio: http://127.0.0.1:4321/studio\nPassword: ${vars.ADMIN_PASSWORD}\n\nAgent API: http://127.0.0.1:4321/api\nAgent token: ${vars.AGENT_TOKEN}\n\nKeep this file private. It and .dev.vars are excluded from git.\nStart locally: npm run dev\nRun checks: npm run build && npm test\nProduction preview: npm run preview (port 4322, after building)\n\nCLOUDFLARE DEPLOYMENT\n1. Sign in: npx wrangler login\n2. Create D1: npx wrangler d1 create raisanwall\n3. Replace the database_id placeholder in wrangler.jsonc.\n4. Create R2: npx wrangler r2 bucket create raisanwall-media\n5. Create KV: npx wrangler kv namespace create SESSION\n6. Replace the KV id placeholder in wrangler.jsonc.\n7. Set fresh production secrets using wrangler secret put for ADMIN_PASSWORD, AGENT_TOKEN, and SESSION_SECRET.\n8. Apply schema: npx wrangler d1 migrations apply raisanwall --remote\n9. Publish: npm run deploy\n\nProduction starts with an empty wall. Local sample posts are not deployed.\nCloudflare may require billing enabled for R2. No resources are created remotely by setup.\n`, { mode: 0o600 });
}
const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
function run(args) { const child = spawnSync(process.execPath, [wrangler, ...args], { cwd: root, stdio: 'inherit' }); if (child.status !== 0) process.exit(child.status || 1); }
run(['d1', 'migrations', 'apply', 'raisanwall', '--local']);
const quote = value => value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
const now = Date.now();
const sql = samplePosts(now).map(post => {
  const entries = Object.entries({ ...post, tags: JSON.stringify(post.tags), pinned: post.pinned ? 1 : 0 });
  return `INSERT OR IGNORE INTO posts (${entries.map(([key]) => key).join(', ')}) SELECT ${entries.map(([, value]) => quote(value)).join(', ')} WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'local_samples_seeded');`;
}).join('\n') + `\nUPDATE settings SET value = 'AI rabbit holes, apps I love, games worth playing, and good finds. All on one little wall.' WHERE key = 'tagline' AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'local_samples_seeded');\nINSERT OR IGNORE INTO settings(key, value) VALUES ('local_samples_seeded', '1');\n`;
const seedPath = resolve(root, 'scripts/.local-seed.sql');
writeFileSync(seedPath, sql);
try { run(['d1', 'execute', 'raisanwall', '--local', '--file', seedPath]); }
finally { if (existsSync(seedPath)) unlinkSync(seedPath); }
console.log('\nRaisanWall is ready. Your private access details are in local-access.txt.\nRun npm run dev, then open http://127.0.0.1:4321.\nSample posts are for demonstration only. Replace them in Studio.\n');
