import type { APIRoute } from 'astro';
import { getStats } from '../../lib/db';
import { errorResponse, json } from '../../lib/validation';
import type { Env } from '../../lib/types';

export const prerender = false;
export const GET: APIRoute = async ({ locals }) => {
  try { return json(await getStats((locals.env as Env).DB), 200, { 'Cache-Control': 'public, max-age=60' }); }
  catch (error) { return errorResponse(error); }
};
