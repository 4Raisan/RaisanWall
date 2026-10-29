import type { APIRoute } from 'astro';
import { requireAuth } from '../../../lib/auth';
import { createPost, getPosts } from '../../../lib/db';
import { errorResponse, json, queryFromUrl, readJson, validatePost } from '../../../lib/validation';
import type { Env } from '../../../lib/types';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals, url }) => {
  try {
    const env = locals.env as Env;
    const studio = url.searchParams.get('view') === 'studio';
    if (studio) { const denied = await requireAuth(request, env); if (denied) return denied; }
    return json(await getPosts(env.DB, queryFromUrl(url, studio)), 200, {
      'Cache-Control': studio ? 'no-store' : 'public, max-age=60',
    });
  } catch (error) { return errorResponse(error); }
};

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = locals.env as Env;
    const denied = await requireAuth(request, env);
    if (denied) return denied;
    const data = validatePost(await readJson(request));
    return json({ post: await createPost(env.DB, data) }, 201);
  } catch (error) { return errorResponse(error); }
};
