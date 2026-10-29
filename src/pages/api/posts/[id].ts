import type { APIRoute } from 'astro';
import { isAuthenticated, requireAuth } from '../../../lib/auth';
import { deletePost, getPostById, updatePost } from '../../../lib/db';
import { errorResponse, HttpError, json, readJson, validatePost } from '../../../lib/validation';
import type { Env } from '../../../lib/types';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals, params }) => {
  try {
    const env = locals.env as Env;
    const authenticated = await isAuthenticated(request, env);
    const post = await getPostById(env.DB, params.id ?? '', authenticated);
    if (!post) throw new HttpError('Post not found.', 404);
    // This URL varies by credentials; never let a shared cache mix its variants.
    return json({ post });
  } catch (error) { return errorResponse(error); }
};

export const PATCH: APIRoute = async ({ request, locals, params }) => {
  try {
    const env = locals.env as Env;
    const denied = await requireAuth(request, env);
    if (denied) return denied;
    const existing = await getPostById(env.DB, params.id ?? '', true);
    if (!existing) throw new HttpError('Post not found.', 404);
    const input = await readJson(request);
    if (Object.hasOwn(input, 'expected_updated_at') && input.expected_updated_at !== existing.updated_at) {
      throw new HttpError('Post has changed. Reload and try again.', 409);
    }
    delete input.expected_updated_at;
    const data = validatePost(input, existing);
    return json({ post: await updatePost(env.DB, existing, data) });
  } catch (error) { return errorResponse(error); }
};

export const DELETE: APIRoute = async ({ request, locals, params }) => {
  try {
    const env = locals.env as Env;
    const denied = await requireAuth(request, env);
    if (denied) return denied;
    await deletePost(env.DB, params.id ?? '');
    return json({ ok: true });
  } catch (error) { return errorResponse(error); }
};
