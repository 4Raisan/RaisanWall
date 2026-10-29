import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import type { Env, Post, ValidatedPost } from './types';

const keyPattern = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\.(?:png|jpg|webp|gif|avif)';
function decode(value: string): string {
  const entities = value.replace(/&#(x[0-9a-f]+|[0-9]+);?/gi, (raw, code: string) => {
    const n = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : raw;
  }).replace(/&sol;/gi, '/').replace(/&period;/gi, '.').replace(/&hyphen;/gi, '-');
  return entities.replace(/(?:%[0-9a-f]{2})+/gi, part => { try { return decodeURIComponent(part); } catch { return part; } });
}
/** Conservative: even plain text, external links and encoded references retain a key. */
export function referencedMedia(post: Pick<ValidatedPost, 'body' | 'cover_image' | 'link_url'>): string[] {
  const parts = [post.body, post.cover_image ?? '', post.link_url ?? ''];
  // The HTML parser decodes named/numeric entities in attributes and text too.
  sanitizeHtml(post.body, {
    allowedAttributes: false,
    transformTags: { '*': (tagName, attribs) => { parts.push(...Object.values(attribs)); return { tagName, attribs }; } },
    textFilter: text => { parts.push(text); return text; },
  });
  return [...new Set(decode(parts.join('\n')).match(new RegExp(keyPattern, 'g')) ?? [])];
}
export const mediaWritable = `NOT EXISTS (SELECT 1 FROM media_cleanup WHERE state IN ('claimed', 'deleted') AND key IN (SELECT value FROM json_each(?)))`;

function owned(url: string): string | null {
  return new RegExp(`^/media/(${keyPattern})(?:[?#].*)?$`).exec(decode(url))?.[1] ?? null;
}
function detach(post: Post): { body: string; cover: string | null; keys: string[] } {
  const keys = new Set<string>();
  const coverKey = post.cover_image && owned(post.cover_image);
  if (coverKey) keys.add(coverKey);
  let body = post.body;
  const protectedCode: { marker: string; raw: string }[] = [];
  if (post.format === 'markdown') {
    marked.walkTokens(marked.lexer(body), token => {
      if (token.type === 'code' || token.type === 'codespan') {
        const marker = `ARCHIVECODE${crypto.randomUUID()}END`;
        protectedCode.push({ marker, raw: token.raw });
        body = body.replace(token.raw, marker);
      }
    });
    const replacements: { raw: string; text: string }[] = [];
    marked.walkTokens(marked.lexer(body), token => {
      if (token.type === 'image') {
        const key = owned(token.href);
        if (key) { keys.add(key); replacements.push({ raw: token.raw, text: token.text }); }
      }
    });
    for (const replacement of replacements) body = body.replace(replacement.raw, replacement.text);
    const retainedLinks = new Set<string>();
    marked.walkTokens(marked.lexer(body), token => {
      if (token.type === 'link' || token.type === 'image') retainedLinks.add(token.href);
    });
    // Remove now-unused image definitions, but never break a retained reference link.
    body = body.replace(/^ {0,3}\[[^\]\n]+\]:[ \t]*<?([^\s>]+)>?[^\n]*(?:\n|$)/gm, (definition, href: string) => {
      const key = owned(href);
      return key && keys.has(key) && !retainedLinks.has(href) ? '' : definition;
    });
  }
  body = body.replace(/<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, tag => {
    let attrs: Record<string, string> = {};
    sanitizeHtml(tag, { transformTags: { img: (tagName, attribs) => { attrs = attribs; return { tagName, attribs }; } } });
    const key = owned(attrs.src ?? '');
    if (!key) return tag;
    keys.add(key);
    return (attrs.alt ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  });
  for (const code of protectedCode) body = body.replace(code.marker, code.raw);
  return { body, cover: coverKey ? null : post.cover_image, keys: [...keys] };
}

/** Cron entry point. Permanent claims serialize post writes against R2 deletion. */
export async function archiveExpiredOffers(env: Env, now: Date = new Date()): Promise<void> {
  const timestamp = now.toISOString();
  const cutoff = new Date(now.getTime() - 72 * 60 * 60 * 1000).toISOString();
  const due = await env.DB.prepare(`SELECT * FROM posts WHERE status IN ('published', 'scheduled')
    AND julianday(published_at) <= julianday(?) AND julianday(offer_end) <= julianday(?)`)
    .bind(timestamp, cutoff).all<Post>();
  for (const post of due.results) {
    const detached = detach(post);
    const version = new Date(Math.max(now.getTime(), Date.parse(post.updated_at) + 1)).toISOString();
    // Queue insertion is conditional on this CAS winning, in the same transaction.
    await env.DB.batch([
      env.DB.prepare(`UPDATE posts SET status = 'archived', pinned = 0, body = ?, cover_image = ?, updated_at = ?
        WHERE id = ? AND updated_at = ?`).bind(detached.body, detached.cover, version, post.id, post.updated_at),
      env.DB.prepare(`INSERT OR IGNORE INTO media_cleanup(key)
        SELECT value FROM json_each(?) WHERE changes() = 1`).bind(JSON.stringify(detached.keys)),
    ]);
  }
  const queued = await env.DB.prepare("SELECT key, state FROM media_cleanup WHERE state != 'deleted'").all<{ key: string; state: string }>();
  for (const item of queued.results) {
    if (item.state === 'pending') {
      // Snapshot and revision are read together. A concurrent edit invalidates the claim.
      const snapshot = await env.DB.batch([
        env.DB.prepare('SELECT version FROM posts_revision WHERE id = 1'),
        env.DB.prepare('SELECT body, cover_image, link_url FROM posts'),
      ]);
      if ((snapshot[1].results as unknown as ValidatedPost[]).some(post => referencedMedia(post).includes(item.key))) continue;
      const claimed = await env.DB.prepare(`UPDATE media_cleanup SET state = 'claimed' WHERE key = ? AND state = 'pending'
        AND (SELECT version FROM posts_revision WHERE id = 1) = ? RETURNING key`)
        .bind(item.key, (snapshot[0].results[0] as { version: number }).version).first();
      if (!claimed) continue;
    }
    // Claims never expire: crashes and failures retry without reopening the attachment race.
    try {
      await env.MEDIA.delete(item.key);
      await env.DB.prepare("UPDATE media_cleanup SET state = 'deleted' WHERE key = ? AND state = 'claimed'").bind(item.key).run();
    } catch { /* Durable claimed row remains for the next invocation. */ }
  }
}
