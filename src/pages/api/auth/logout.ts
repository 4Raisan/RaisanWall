import type { APIRoute } from 'astro';
import { requireAuth, sessionCookie } from '../../../lib/auth';
import { errorResponse, json } from '../../../lib/validation';
import type { Env } from '../../../lib/types';

export const prerender = false;
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const denied = await requireAuth(request, locals.env as Env);
    if (denied) return denied;
    return json({ authenticated: false }, 200, { 'Set-Cookie': sessionCookie(request, '', true) });
  } catch (error) { return errorResponse(error); }
};
