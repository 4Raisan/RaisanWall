import type { APIRoute } from 'astro';
import { getPosts, getSettings } from '../lib/db';
import { renderContent } from '../lib/content';
import { errorResponse } from '../lib/validation';
import type { Env } from '../lib/types';

export const prerender = false;
export function xmlEscape(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff\ud800-\udfff]/gu, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export const GET: APIRoute = async ({ locals, url }) => {
  try {
    const db = (locals.env as Env).DB;
    const [settings, { posts }] = await Promise.all([getSettings(db), getPosts(db, { limit: 20, sort: 'newest' })]);
    const origin = url.origin;
    const items = posts.map(post => {
      const link = new URL(`/post/${post.slug}`, origin).href;
      const html = renderContent(post.body, post.format).replace(/\b(href|src)="(\/(?!\/)[^"]*)"/g, (_match, attr: string, path: string) => `${attr}="${origin}${path}"`);
      return `<item><title>${xmlEscape(post.title)}</title><link>${xmlEscape(link)}</link><guid isPermaLink="true">${xmlEscape(link)}</guid><pubDate>${new Date(post.published_at!).toUTCString()}</pubDate><description>${xmlEscape(post.excerpt)}</description><category>${xmlEscape(post.category)}</category>${post.tags.map(tag => `<category>${xmlEscape(tag)}</category>`).join('')}<content:encoded>${xmlEscape(html)}</content:encoded></item>`;
    }).join('');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>${xmlEscape(settings.site_name)}</title><link>${xmlEscape(origin + '/')}</link><description>${xmlEscape(settings.description)}</description><language>en</language><atom:link href="${xmlEscape(new URL('/rss.xml', origin).href)}" rel="self" type="application/rss+xml"/>${items}</channel></rss>`;
    return new Response(xml, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'public, max-age=60', 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) { return errorResponse(error); }
};
