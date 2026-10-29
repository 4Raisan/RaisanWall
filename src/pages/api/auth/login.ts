import type { APIRoute } from 'astro';
import { constantTimeEqual, createSession, hashedClientKey, loginConfigured, sameOrigin, sessionCookie } from '../../../lib/auth';
import { clearLoginAttempts, reserveLoginAttempt } from '../../../lib/db';
import { errorResponse, HttpError, json, readJson } from '../../../lib/validation';
import type { Env } from '../../../lib/types';

export const prerender = false;
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    if (!sameOrigin(request)) throw new HttpError('A matching Origin is required.', 403);
    const env = locals.env as Env;
    if (!loginConfigured(env)) throw new HttpError('Login is unavailable.', 503);
    const { password } = await readJson(request);
    if (typeof password !== 'string' || !password.length || password.length > 4096) throw new HttpError('Invalid password input.');
    const key = await hashedClientKey(request, env, 'login');
    if (!key) throw new HttpError('Login is unavailable.', 503);
    if (!await reserveLoginAttempt(env.DB, key)) return json({ error: 'Too many login attempts. Try again later.' }, 429, { 'Retry-After': '900' });
    if (!await constantTimeEqual(password, env.ADMIN_PASSWORD)) throw new HttpError('Invalid credentials.', 401);
    await clearLoginAttempts(env.DB, key);
    return json({ authenticated: true }, 200, { 'Set-Cookie': sessionCookie(request, await createSession(env.SESSION_SECRET)) });
  } catch (error) { return errorResponse(error); }
};
