import type { APIRoute } from 'astro';
import { hashedClientKey, sameOrigin } from '../../lib/auth';
import { getPostBySlug, recordVisit } from '../../lib/db';
import { errorResponse, HttpError, json, readJson, validateVisitPath } from '../../lib/validation';
import type { Env } from '../../lib/types';

export const prerender = false;
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    if (request.headers.has('Origin') && !sameOrigin(request)) throw new HttpError('Origin is not allowed.', 403);
    const env = locals.env as Env;
    const path = validateVisitPath((await readJson(request)).path);
    // Do not inflate counters for missing, draft, or not-yet-live detail pages.
    if (path !== '/' && !await getPostBySlug(env.DB, path.slice('/post/'.length))) throw new HttpError('Post not found.', 404);
    const now = Date.now();
    const key = await hashedClientKey(request, env, 'visit', path, now);
    // Analytics is optional when no secret/trusted address is available.
    return json({ ok: true, recorded: key ? await recordVisit(env.DB, key, now) : false });
  } catch (error) { return errorResponse(error); }
};
