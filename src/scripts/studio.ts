import { toast } from './public';
import type { Post } from '../lib/types';

async function request<T = Record<string, unknown>>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...options, headers: { ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...options.headers } });
  const data = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'The request failed. Please try again.');
  return data as T;
}
function message(id: string, text = '') { const target = document.getElementById(id); if (target) target.textContent = text; }
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.';

document.querySelector<HTMLFormElement>('#login-form')?.addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget as HTMLFormElement;
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  button.disabled = true; message('login-error');
  try { await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: new FormData(form).get('password') }) }); location.replace('/studio'); }
  catch (error) { message('login-error', errorText(error)); button.disabled = false; }
});
document.querySelector('#logout-button')?.addEventListener('click', async () => {
  try { await request('/api/auth/logout', { method: 'POST' }); location.replace('/studio'); }
  catch (error) { toast(errorText(error)); }
});
document.querySelector<HTMLFormElement>('#settings-form')?.addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget as HTMLFormElement;
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  button.disabled = true; message('settings-error');
  const data = Object.fromEntries(new FormData(form));
  data.launch_date = new Date(`${data.launch_date}T00:00:00.000Z`).toISOString();
  try { await request('/api/settings', { method: 'PUT', body: JSON.stringify(data) }); toast('Wall settings saved.'); }
  catch (error) { message('settings-error', errorText(error)); }
  finally { button.disabled = false; }
});

const editor = document.querySelector<HTMLDialogElement>('#editor-dialog');
const form = document.querySelector<HTMLFormElement>('#post-form');
let dirty = false;
let busy = false;
let currentPost: Post | null = null;
let previewSequence = 0;
const field = (name: string) => form?.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
const localDate = (value: string | null) => {
  if (!value) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
function updatePublishing() {
  if (!form) return;
  const status = field('status').value;
  document.getElementById('schedule-label')!.hidden = status !== 'scheduled';
  field('published_at').required = status === 'scheduled';
  const save = document.getElementById('save-post');
  if (save) save.textContent = status === 'archived' ? 'Save archive' : status === 'draft' ? 'Save draft' : status === 'scheduled' ? 'Schedule post' : currentPost?.status === 'published' ? 'Save changes' : 'Publish post';
}
function showCover(url: string) {
  const image = document.querySelector<HTMLImageElement>('#cover-preview');
  if (!image) return;
  let allowed = false;
  try { const parsed = new URL(url, location.origin); allowed = !!url && (parsed.protocol === 'https:' || parsed.origin === location.origin && /^\/(media|art)\//.test(parsed.pathname)); } catch { /* Invalid URLs stay in the form for correction. */ }
  image.hidden = !allowed;
  if (allowed) image.src = url; else image.removeAttribute('src');
}
function openEditor(post: Post | null = null) {
  if (!form || !editor) return;
  form.reset(); currentPost = post; dirty = false; busy = false;
  message('post-error'); message('upload-status');
  document.getElementById('content-preview')!.hidden = true;
  document.getElementById('post-body')!.hidden = false;
  document.getElementById('preview-button')!.textContent = 'Preview';
  document.getElementById('editor-title')!.textContent = post ? 'Edit post' : 'New post';
  document.getElementById('delete-post')!.hidden = !post;
  field('id').value = post?.id || ''; field('updated_at').value = post?.updated_at || '';
  if (post) {
    for (const key of ['title', 'slug', 'excerpt', 'body', 'format', 'category', 'cover_image', 'link_url', 'link_label', 'invite_code', 'status'] as const) field(key).value = post[key] || '';
    field('tags').value = post.tags.join(', ');
    for (const key of ['offer_start', 'offer_end', 'published_at'] as const) field(key).value = localDate(post[key]);
    (field('pinned') as HTMLInputElement).checked = post.pinned;
  }
  updatePublishing(); showCover(post?.cover_image || ''); editor.showModal();
}
function closeEditor() {
  if (busy) { toast('Wait for the current action to finish.'); return; }
  if (dirty) document.querySelector<HTMLDialogElement>('#discard-dialog')?.showModal();
  else editor?.close();
}
document.getElementById('new-post')?.addEventListener('click', () => openEditor());
document.querySelectorAll<HTMLButtonElement>('[data-edit]').forEach(button => button.addEventListener('click', async () => {
  button.disabled = true;
  try { const { post } = await request<{ post: Post }>(`/api/posts/${button.dataset.edit}`); openEditor(post); }
  catch (error) { toast(errorText(error)); }
  finally { button.disabled = false; }
}));
form?.addEventListener('input', () => { dirty = true; });
form?.addEventListener('change', () => { dirty = true; });
document.getElementById('post-status')?.addEventListener('change', updatePublishing);
field('cover_image')?.addEventListener('change', () => showCover(field('cover_image').value));
document.getElementById('close-editor')?.addEventListener('click', closeEditor);
document.getElementById('cancel-editor')?.addEventListener('click', closeEditor);
editor?.addEventListener('cancel', event => { event.preventDefault(); closeEditor(); });
document.getElementById('keep-editing')?.addEventListener('click', () => document.querySelector<HTMLDialogElement>('#discard-dialog')?.close());
document.getElementById('discard-changes')?.addEventListener('click', () => { dirty = false; document.querySelector<HTMLDialogElement>('#discard-dialog')?.close(); editor?.close(); });
window.addEventListener('beforeunload', event => { if (dirty && editor?.open) event.preventDefault(); });

document.getElementById('preview-button')?.addEventListener('click', async event => {
  const button = event.currentTarget as HTMLButtonElement;
  const preview = document.getElementById('content-preview')!;
  const body = document.getElementById('post-body')!;
  if (!preview.hidden) { preview.hidden = true; body.hidden = false; button.textContent = 'Preview'; return; }
  button.disabled = true;
  const sequence = ++previewSequence;
  try {
    const { html } = await request<{ html: string }>('/api/preview', { method: 'POST', body: JSON.stringify({ body: field('body').value, format: field('format').value }) });
    if (sequence !== previewSequence || !editor?.open) return;
    preview.innerHTML = html; preview.hidden = false; body.hidden = true; button.textContent = 'Back to writing';
  } catch (error) { message('post-error', errorText(error)); }
  finally { button.disabled = false; }
});
document.querySelector<HTMLInputElement>('#cover-upload')?.addEventListener('change', async event => {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0]; if (!file) return;
  if (file.size > 8 * 1024 * 1024) { message('upload-status', 'Choose an image smaller than 8 MB.'); input.value = ''; return; }
  const data = new FormData(); data.append('file', file);
  busy = true; input.disabled = true; message('upload-status', 'Uploading your image…');
  (document.getElementById('save-post') as HTMLButtonElement).disabled = true;
  try { const result = await request<{ url: string }>('/api/media', { method: 'POST', body: data }); field('cover_image').value = result.url; showCover(result.url); dirty = true; message('upload-status', 'Image uploaded. Save the post to use it.'); }
  catch (error) { message('upload-status', errorText(error)); }
  finally { busy = false; input.disabled = false; (document.getElementById('save-post') as HTMLButtonElement).disabled = false; input.value = ''; }
});
form?.addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  busy = true; const button = document.getElementById('save-post') as HTMLButtonElement; button.disabled = true; message('post-error');
  const data: Record<string, unknown> = {};
  for (const key of ['title', 'body', 'format', 'category', 'status']) data[key] = field(key).value;
  if (field('excerpt').value.trim()) data.excerpt = field('excerpt').value.trim();
  if (field('slug').value.trim()) data.slug = field('slug').value.trim();
  for (const key of ['cover_image', 'link_url', 'link_label', 'invite_code']) data[key] = field(key).value.trim() || null;
  for (const key of ['offer_start', 'offer_end']) data[key] = field(key).value ? new Date(field(key).value).toISOString() : null;
  data.tags = field('tags').value.split(',').map(tag => tag.trim().replace(/^#/, '')).filter(Boolean);
  data.pinned = (field('pinned') as HTMLInputElement).checked;
  if (data.status === 'scheduled') data.published_at = currentPost?.published_at && localDate(currentPost.published_at) === field('published_at').value ? currentPost.published_at : new Date(field('published_at').value).toISOString();
  else if (data.status === 'published') data.published_at = currentPost?.published_at && Date.parse(currentPost.published_at) <= Date.now() ? currentPost.published_at : new Date().toISOString();
  else data.published_at = data.status === 'archived' ? currentPost?.published_at ?? null : null;
  if (currentPost) data.expected_updated_at = field('updated_at').value;
  try {
    await request(currentPost ? `/api/posts/${currentPost.id}` : '/api/posts', { method: currentPost ? 'PATCH' : 'POST', body: JSON.stringify(data) });
    dirty = false; editor?.close(); sessionStorage.setItem('studio-notice', data.status === 'archived' ? 'Archive saved. Only you can see it.' : data.status === 'draft' ? 'Draft saved. Only you can see it.' : data.status === 'scheduled' ? 'Post scheduled. It will appear automatically.' : 'Post published. Your wall will refresh shortly.'); location.reload();
  } catch (error) { message('post-error', errorText(error)); }
  finally { busy = false; button.disabled = false; }
});
document.getElementById('delete-post')?.addEventListener('click', () => { if (!busy) document.querySelector<HTMLDialogElement>('#delete-dialog')?.showModal(); });
document.getElementById('cancel-delete')?.addEventListener('click', () => document.querySelector<HTMLDialogElement>('#delete-dialog')?.close());
document.getElementById('confirm-delete')?.addEventListener('click', async event => {
  if (!currentPost || busy) return;
  const button = event.currentTarget as HTMLButtonElement; button.disabled = true; busy = true;
  try { await request(`/api/posts/${currentPost.id}`, { method: 'DELETE' }); dirty = false; sessionStorage.setItem('studio-notice', 'Post deleted.'); location.reload(); }
  catch (error) { document.querySelector<HTMLDialogElement>('#delete-dialog')?.close(); message('post-error', errorText(error)); }
  finally { button.disabled = false; busy = false; }
});
try { const notice = sessionStorage.getItem('studio-notice'); if (notice) { toast(notice); sessionStorage.removeItem('studio-notice'); } } catch {}
