import type { APIRoute } from 'astro';
import { isAuthenticated } from '../../lib/auth';
import { errorResponse, HttpError, mediaContentType } from '../../lib/validation';
import type { Env } from '../../lib/types';

export const prerender = false;
const serve: APIRoute = async ({ request, locals, params }) => {
  try {
    const key = params.key ?? '';
    const contentType = mediaContentType(key);
    if (!contentType) throw new HttpError('Media not found.', 404);
    const env = locals.env as Env;
    const path = `/media/${key}`;
    // Uploads stay private until a currently visible post references them.
    const publicReference = await env.DB.prepare(`SELECT 1 FROM posts
      WHERE status IN ('published', 'scheduled') AND published_at IS NOT NULL AND julianday(published_at) <= julianday(?)
        AND (cover_image = ? OR instr(body, ?) > 0) LIMIT 1`)
      .bind(new Date().toISOString(), path, path).first();
    if (!publicReference && !await isAuthenticated(request, env)) throw new HttpError('Media not found.', 404);
    const object = request.method === 'HEAD' ? await env.MEDIA.head(key) : await env.MEDIA.get(key);
    if (!object) throw new HttpError('Media not found.', 404);
    const headers = new Headers({
      'Content-Type': contentType,
      // Short shared caching bounds exposure after unpublishing; private previews must not persist.
      'Cache-Control': publicReference ? 'public, max-age=0, s-maxage=30' : 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': `inline; filename="${key}"`,
      'ETag': object.httpEtag,
    });
    if (request.headers.get('If-None-Match')?.split(',').map(value => value.trim()).some(value => value === '*' || value.replace(/^W\//, '') === object.httpEtag)) {
      return new Response(null, { status: 304, headers });
    }
    headers.set('Content-Length', String(object.size));
    return new Response('body' in object ? object.body as ReadableStream : null, { headers });
  } catch (error) { return errorResponse(error); }
};
export const GET = serve;
export const HEAD = serve;
