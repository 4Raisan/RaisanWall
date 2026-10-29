import type { APIRoute } from 'astro';
import { isAuthenticated } from '../../../lib/auth';
import { errorResponse, json } from '../../../lib/validation';
import type { Env } from '../../../lib/types';

export const prerender = false;
export const GET: APIRoute = async ({ request, locals }) => {
  try { return json({ authenticated: await isAuthenticated(request, locals.env as Env) }); }
  catch (error) { return errorResponse(error); }
};
