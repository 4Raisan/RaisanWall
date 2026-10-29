import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';

const base = process.env.TEST_URL || 'http://127.0.0.1:4321';
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname), 'Browser tests only run against a local wall.');
const browserPath = process.env.BROWSER_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
assert(browserPath, 'Set BROWSER_PATH to an installed Chrome or Edge executable.');
const output = resolve('test-results'); mkdirSync(output, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'raisanwall-browser-'));
const child = spawn(browserPath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
let session;
let sequence = 0;
const pending = new Map();
const listeners = new Map();
const exceptions = [];
let checks = 0;
let createdId;
const password = JSON.parse(/^ADMIN_PASSWORD=(.+)$/m.exec(readFileSync('.dev.vars', 'utf8'))[1]);
const agentToken = JSON.parse(/^AGENT_TOKEN=(.+)$/m.exec(readFileSync('.dev.vars', 'utf8'))[1]);
const title = `Browser verification ${Date.now()}`;
const slug = `browser-verification-${Date.now()}`;
function check(label, condition) { assert(condition, label); checks++; console.log(`PASS ${label}`); }
function send(method, params = {}, useSession = true) {
  return new Promise((res, rej) => {
    const id = ++sequence; const timeout = setTimeout(() => { pending.delete(id); rej(new Error(`CDP timeout: ${method}`)); }, 25000);
    pending.set(id, { res, rej, timeout }); socket.send(JSON.stringify({ id, method, params, ...(useSession && session ? { sessionId: session } : {}) }));
  });
}
function event(name, timeout = 20000) { return new Promise((res, rej) => { const timer = setTimeout(() => { listeners.delete(name); rej(new Error(`Timeout waiting for ${name}`)); }, timeout); listeners.set(name, value => { clearTimeout(timer); res(value); }); }); }
async function evaluate(expression) { const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; }
async function waitFor(expression) { return evaluate(`new Promise((resolve, reject) => { const started = performance.now(); const tick = () => { if (${expression}) return resolve(true); if (performance.now() - started > 12000) return reject(new Error('UI condition timed out')); requestAnimationFrame(tick); }; tick(); })`); }
async function ready() { await evaluate('document.fonts.ready.then(() => Promise.all([...document.images].map(image => image.decode().catch(() => {}))))'); }
async function navigate(path) { const loaded = event('Page.loadEventFired'); await send('Page.navigate', { url: `${base}${path}` }); await loaded; await ready(); }
async function clickAndNavigate(selector) { const loaded = event('Page.loadEventFired'); await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); await loaded; await ready(); }
async function fill(selector, value) { await evaluate(`(() => { const field = document.querySelector(${JSON.stringify(selector)}); field.value = ${JSON.stringify(value)}; field.dispatchEvent(new Event('input', {bubbles: true})); field.dispatchEvent(new Event('change', {bubbles: true})); })()`); }
async function savePost() { const loaded = event('Page.loadEventFired'); await evaluate("document.querySelector('#post-form').requestSubmit()"); await loaded; await ready(); }
async function screenshot(name) { const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); writeFileSync(join(output, name), Buffer.from(data, 'base64')); }
try {
  const endpoint = await new Promise((res, rej) => {
    let stderr = ''; const timer = setTimeout(() => rej(new Error('Browser did not start.')), 20000);
    child.on('error', error => { clearTimeout(timer); rej(error); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr); if (match) { clearTimeout(timer); res(match[1]); } });
    child.on('exit', code => { clearTimeout(timer); rej(new Error(`Browser exited early: ${code}`)); });
  });
  socket = new WebSocket(endpoint);
  await new Promise((res, rej) => { socket.addEventListener('open', res, { once: true }); socket.addEventListener('error', rej, { once: true }); });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { const p = pending.get(message.id); pending.delete(message.id); clearTimeout(p.timeout); message.error ? p.rej(new Error(message.error.message)) : p.res(message.result); }
    if (message.method && message.sessionId === session) {
      if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error' && /Content Security Policy|Refused to|Uncaught/.test(message.params.entry.text)) exceptions.push(message.params.entry.text);
      const listener = listeners.get(message.method); if (listener) { listeners.delete(message.method); listener(message.params); }
    }
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, false);
  ({ sessionId: session } = await send('Target.attachToTarget', { targetId, flatten: true }, false));
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Browser.grantPermissions', { origin: base, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }, false);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1080, deviceScaleFactor: 1, mobile: false });
  await navigate('/');
  check('desktop wall has no horizontal overflow', await evaluate('document.documentElement.scrollWidth <= innerWidth'));
  check('all visible cover images load', await evaluate('[...document.images].every(img => img.complete && img.naturalWidth > 0)'));
  await screenshot('wall-desktop.png');
  await evaluate("document.querySelector('[data-view=list]').click()"); check('list layout switches correctly', await evaluate("document.querySelector('#post-grid').classList.contains('list-view')"));
  await evaluate("document.querySelector('[data-view=grid]').click()");
  await clickAndNavigate('.category-nav a[href="/?category=Apps"]');
  check('category filter shows only apps', await evaluate("[...document.querySelectorAll('.post-card .category-label')].length > 0 && [...document.querySelectorAll('.post-card .category-label')].every(el => el.textContent.trim() === 'Apps')"));
  await evaluate("document.querySelector('[data-open-search]').click()");
  check('search dialog opens', await evaluate("document.querySelector('#search-dialog').open"));
  await fill('#global-search', 'not-a-real-query-zzzzzz');
  const searched = event('Page.loadEventFired'); await evaluate("document.querySelector('#search-dialog form').requestSubmit()"); await searched;
  check('empty search gives recovery path', await evaluate("document.querySelector('.empty-state').textContent.includes('Nothing here') && !!document.querySelector('.filter-bar a')"));
  await clickAndNavigate('.filter-bar a');
  await clickAndNavigate('.post-card h2 a');
  check('post reading view renders content', await evaluate("!!document.querySelector('.article-title') && !!document.querySelector('.prose h2')"));
  await screenshot('post-desktop.png');
  await navigate('/studio');
  await fill('#password', 'incorrect-password-for-browser-check');
  await evaluate("document.querySelector('#login-form').requestSubmit()");
  await waitFor("document.querySelector('#login-error').textContent.length > 0");
  check('invalid login has useful feedback', await evaluate("!document.querySelector('#login-form button').disabled && document.querySelector('#login-error').textContent.length > 0"));
  await fill('#password', password);
  const signedIn = event('Page.loadEventFired'); await evaluate("document.querySelector('#login-form').requestSubmit()"); await signedIn;
  check('Studio login works', await evaluate("!!document.querySelector('#new-post')"));
  await screenshot('studio-desktop.png');
  await evaluate("document.querySelector('#new-post').click()");
  check('new post editor opens', await evaluate("document.querySelector('#editor-dialog').open"));
  await fill('[name=title]', title); await fill('[name=slug]', slug);
  await fill('[name=body]', '## A browser-tested post\n\nThis **post** was created through the real editor.\n\n- Markdown works\n- Publishing works');
  await fill('[name=category]', 'Offers'); await fill('[name=tags]', 'verification'); await fill('[name=invite_code]', 'BROWSER-TEST');
  await evaluate("document.querySelector('#preview-button').click()"); await waitFor("!document.querySelector('#content-preview').hidden");
  check('editor renders a sanitized Markdown preview', await evaluate("document.querySelector('#content-preview h2').textContent === 'A browser-tested post'"));
  await evaluate("document.querySelector('#preview-button').click()");
  const png = join(output, 'upload-fixture.png'); writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1kAAAAASUVORK5CYII=', 'base64'));
  const { root } = await send('DOM.getDocument'); const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#cover-upload' });
  await send('DOM.setFileInputFiles', { nodeId, files: [png] });
  await waitFor("document.querySelector('[name=cover_image]').value.startsWith('/media/')");
  check('image upload works through editor', await evaluate("document.querySelector('#upload-status').textContent.includes('Image uploaded')"));
  await screenshot('editor-desktop.png');
  await savePost();
  check('draft appears in Studio after saving', await evaluate(`document.querySelector('.post-table').textContent.includes(${JSON.stringify(title)})`));
  createdId = await evaluate(`document.querySelectorAll('[data-edit]')[0].dataset.edit`);
  const visibility = await fetch(`${base}/api/posts/${createdId}`); check('browser-created draft remains private', visibility.status === 404);
  await evaluate(`document.querySelector('[data-edit="${createdId}"]').click()`); await waitFor("document.querySelector('#editor-dialog').open");
  await fill('#post-form [name=status]', 'scheduled');
  const future = new Date(Date.now() + 86400000); const local = new Date(future.getTime() - future.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  await fill('[name=published_at]', local); await savePost();
  check('scheduled status is visible in Studio', await evaluate(`document.querySelector('[data-edit="${createdId}"]').closest('.post-table-row').textContent.includes('scheduled')`));
  check('scheduled post remains private', (await fetch(`${base}/api/posts/${createdId}`)).status === 404);
  await evaluate(`document.querySelector('[data-edit="${createdId}"]').click()`); await waitFor("document.querySelector('#editor-dialog').open");
  await fill('#post-form [name=status]', 'published'); await savePost();
  await navigate(`/post/${slug}`);
  check('published post is readable', await evaluate(`document.querySelector('.article-title').textContent === ${JSON.stringify(title)}`));
  await evaluate("document.querySelector('[data-copy]').click()"); await waitFor("document.querySelector('#toast').classList.contains('visible')");
  check('invite code copies to clipboard', await evaluate("navigator.clipboard.readText()") === 'BROWSER-TEST');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await navigate('/');
  check('mobile wall fits viewport', await evaluate('document.documentElement.scrollWidth <= innerWidth'));
  check('mobile cards stack in one column', await evaluate("getComputedStyle(document.querySelector('#post-grid')).gridTemplateColumns.split(' ').length === 1"));
  await screenshot('wall-mobile.png');
  await navigate('/?category=Apps');
  await screenshot('wall-mobile.png');
  await navigate('/studio');
  check('mobile Studio fits viewport', await evaluate('document.documentElement.scrollWidth <= innerWidth'));
  await evaluate(`document.querySelector('[data-edit="${createdId}"]').click()`); await waitFor("document.querySelector('#editor-dialog').open");
  check('mobile editor fits viewport', await evaluate("document.querySelector('#editor-dialog').getBoundingClientRect().width <= innerWidth"));
  await screenshot('editor-mobile.png');
  await fill('#post-form [name=status]', 'archived'); await savePost();
  await navigate('/studio?status=archived');
  check('archived filter shows the archived post', await evaluate(`document.querySelector('[data-edit="${createdId}"]').closest('.post-table-row').textContent.includes('archived')`));
  check('archived post is private', (await fetch(`${base}/api/posts/${createdId}`)).status === 404);
  await evaluate(`document.querySelector('[data-edit="${createdId}"]').click()`); await waitFor("document.querySelector('#editor-dialog').open");
  check('archived editor preserves its status', await evaluate("document.querySelector('#post-status').value === 'archived' && document.querySelector('#save-post').textContent === 'Save archive'"));
  await fill('[name=title]', `${title} unsaved`); await evaluate("document.querySelector('#cancel-editor').click()");
  check('unsaved changes require confirmation', await evaluate("document.querySelector('#discard-dialog').open"));
  await evaluate("document.querySelector('#keep-editing').click()"); await evaluate("document.querySelector('#delete-post').click()");
  check('deletion requires confirmation', await evaluate("document.querySelector('#delete-dialog').open"));
  const deleted = event('Page.loadEventFired'); await evaluate("document.querySelector('#confirm-delete').click()"); await deleted;
  check('post deleted through Studio', !(await evaluate(`document.querySelector('.post-table').textContent.includes(${JSON.stringify(title)})`)));
  createdId = null;
  await navigate('/studio?section=settings');
  const tagline = await evaluate("document.querySelector('[name=tagline]').value");
  await fill('[name=tagline]', 'Browser verification — a temporary test tagline.'); await evaluate("document.querySelector('#settings-form').requestSubmit()"); await waitFor("document.querySelector('#toast').classList.contains('visible')");
  check('settings save through browser', (await (await fetch(`${base}/api/settings`)).json()).tagline === 'Browser verification — a temporary test tagline.');
  await fill('[name=tagline]', tagline); await evaluate("document.querySelector('#settings-form').requestSubmit()"); await waitFor("!document.querySelector('#settings-form button[type=submit]').disabled");
  await navigate('/studio?section=agent'); check('agent setup is available privately', await evaluate("document.querySelector('.agent-panel').textContent.includes('AGENT_TOKEN')"));
  const signedOut = event('Page.loadEventFired'); await evaluate("document.querySelector('#logout-button').click()"); await signedOut;
  check('Studio sign-out works', await evaluate("!!document.querySelector('#login-form')"));
  if (exceptions.length) console.error('Browser exceptions:', exceptions);
  check('no browser runtime or CSP exceptions', exceptions.length === 0);
  console.log(`\n${checks} browser checks passed. Screenshots saved in test-results/.`);
} catch (error) {
  if (socket?.readyState === 1 && session) { try { await screenshot('failure.png'); console.error(await evaluate("({url: location.href, error: document.querySelector('#post-error')?.textContent, login: document.querySelector('#login-error')?.textContent})")); } catch {} }
  throw error;
} finally {
  if (createdId) await fetch(`${base}/api/posts/${createdId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${agentToken}` } });
  if (socket?.readyState === 1) { try { await send('Browser.close', {}, false); } catch {} socket.close(); }
  if (child.exitCode === null) { await new Promise(resolve => { const timer = setTimeout(() => { child.kill(); resolve(); }, 5000); child.once('exit', () => { clearTimeout(timer); resolve(); }); }); }
  for (const p of pending.values()) clearTimeout(p.timeout);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
