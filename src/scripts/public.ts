const dialog = document.querySelector<HTMLDialogElement>('#search-dialog');
document.querySelectorAll('[data-open-search]').forEach(button => button.addEventListener('click', () => dialog?.showModal()));
document.querySelector('[data-close-search]')?.addEventListener('click', () => dialog?.close());
dialog?.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
document.addEventListener('keydown', event => {
  if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement).tagName) && !(event.target as HTMLElement).isContentEditable) {
    event.preventDefault(); dialog?.showModal();
  }
});
let toastTimer: ReturnType<typeof setTimeout>;
export function toast(message: string) {
  const element = document.querySelector<HTMLElement>('#toast');
  if (!element) return;
  element.textContent = message; element.classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => element.classList.remove('visible'), 3200);
}
document.querySelectorAll<HTMLElement>('[data-copy]').forEach(button => button.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(button.dataset.copy || ''); toast('Copied to your clipboard.'); }
  catch { toast('Could not copy. Select the code and copy it manually.'); }
}));
document.querySelector('#sort')?.addEventListener('change', () => document.querySelector<HTMLFormElement>('#sort-form')?.requestSubmit());
document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(button => button.addEventListener('click', () => {
  document.querySelector('#post-grid')?.classList.toggle('list-view', button.dataset.view === 'list');
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(item => { const active = item === button; item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active)); });
}));
document.querySelector('[data-share]')?.addEventListener('click', async () => {
  try {
    if (navigator.share) await navigator.share({ title: document.title, url: location.href });
    else { await navigator.clipboard.writeText(location.href); toast('Post link copied.'); }
  } catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) toast('Copy the address from your browser to share this post.'); }
});
if (location.pathname === '/' || location.pathname.startsWith('/post/')) {
  fetch('/api/visit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: location.pathname }), keepalive: true }).catch(() => {});
}
