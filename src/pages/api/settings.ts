import type { APIRoute } from 'astro';
import { requireAuth } from '../../lib/auth';
import { getSettings, updateSettings } from '../../lib/db';
import { errorResponse, json, readJson, validateSettings } from '../../lib/validation';
import type { Env } from '../../lib/types';

export const prerender = false;
export const GET: APIRoute = async ({ locals }) => {
  try { return json(await getSettings((locals.env as Env).DB), 200, { 'Cache-Control': 'public, max-age=60' }); }
  catch (error) { return errorResponse(error); }
};
export const PUT: APIRoute = async ({ request, locals }) => {
  try {
    const env = locals.env as Env;
    const denied = await requireAuth(request, env);
    if (denied) return denied;
    return json(await updateSettings(env.DB, validateSettings(await readJson(request))));
  } catch (error) { return errorResponse(error); }
};
