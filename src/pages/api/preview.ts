import type { APIRoute } from 'astro';
import { requireAuth } from '../../lib/auth';
import { renderContent } from '../../lib/content';
import { errorResponse, json, readJson, validatePreview } from '../../lib/validation';
import type { Env } from '../../lib/types';

export const prerender = false;
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = locals.env as Env;
    const denied = await requireAuth(request, env);
    if (denied) return denied;
    const { body, format } = validatePreview(await readJson(request));
    return json({ html: renderContent(body, format) });
  } catch (error) { return errorResponse(error); }
};
