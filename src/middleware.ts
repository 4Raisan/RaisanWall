import { defineMiddleware } from 'astro:middleware';
import { env } from 'cloudflare:workers';
import type { Env } from './lib/types';

export const onRequest = defineMiddleware(async (context, next) => {
  context.locals.env = env as Env;
  const { request, url } = context;
  const publicPage = url.pathname === '/' || url.pathname === '/about' || url.pathname === '/rss.xml' || url.pathname.startsWith('/post/');
  const cacheable = !import.meta.env.DEV && request.method === 'GET' && publicPage && !request.headers.has('Cookie') && !request.headers.has('Authorization');
  const cacheKey = new Request(url.href, { method: 'GET' });
  const cache = cacheable ? await caches.open('raisanwall-pages') : null;
  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) { const hit = new Response(cached.body, cached); hit.headers.set('X-Wall-Cache', 'HIT'); return hit; }
  }
  const response = await next();
  const headers = response.headers;
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (url.protocol === 'https:') headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  const dev = import.meta.env.DEV;
  if (!headers.has('Content-Security-Policy')) headers.set('Content-Security-Policy', `default-src 'self'; script-src 'self'${dev ? " 'unsafe-inline'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; font-src 'self'; connect-src 'self'${dev ? ' ws: wss:' : ''}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`);
  if (url.pathname.startsWith('/studio')) headers.set('Cache-Control', 'no-store');
  else if (publicPage && response.status === 200) headers.set('Cache-Control', 'public, max-age=0, s-maxage=30');
  if (cache && response.status === 200 && !headers.has('Set-Cookie')) {
    headers.set('X-Wall-Cache', 'MISS');
    context.locals.cfContext.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
});
