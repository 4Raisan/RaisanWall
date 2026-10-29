import type { Env } from './types';
import { json } from './validation';

export const SESSION_COOKIE = 'raisanwall_session';
export const SESSION_SECONDS = 12 * 60 * 60;
const encoder = new TextEncoder();
const unsafe = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin');
  return origin !== null && origin === new URL(request.url).origin;
}

/** Always compare fixed-size SHA-256 byte sequences, never passwords directly. */
export async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < x.length; i++) difference |= x[i] ^ y[i];
  return difference === 0;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
}
async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function sign(value: string, secret: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(value))));
}

export function loginConfigured(env: Env): boolean {
  return !!(env?.ADMIN_PASSWORD?.trim() && env?.SESSION_SECRET?.trim());
}

export async function createSession(secret: string, now = Date.now()): Promise<string> {
  if (!secret?.trim()) throw new Error('Session signing is unavailable.');
  const expires = Math.floor(now / 1000) + SESSION_SECONDS;
  const payload = `v1.${expires}.${crypto.randomUUID()}`;
  return `${payload}.${await sign(payload, secret)}`;
}

export async function verifySession(token: string, secret: string, now = Date.now()): Promise<boolean> {
  if (!secret?.trim() || token.length > 256) return false;
  const match = /^(v1\.(\d{10,11})\.[a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return false;
  const expires = Number(match[2]);
  const seconds = Math.floor(now / 1000);
  if (expires <= seconds || expires > seconds + SESSION_SECONDS) return false;
  try {
    return await crypto.subtle.verify('HMAC', await hmacKey(secret), fromBase64url(match[3]), encoder.encode(match[1]));
  } catch { return false; }
}

export function sessionCookie(request: Request, token: string, clear = false): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_SECONDS}${secure}`;
}

function readSessionCookie(request: Request): string | null {
  const values = (request.headers.get('Cookie') ?? '').split(';').map(part => part.trim())
    .filter(part => part.startsWith(`${SESSION_COOKIE}=`));
  // Reject duplicate cookies instead of depending on ambiguous client ordering.
  return values.length === 1 ? values[0].slice(SESSION_COOKIE.length + 1) : null;
}

async function authentication(request: Request, env: Env): Promise<'bearer' | 'cookie' | null> {
  const authorization = request.headers.get('Authorization');
  if (authorization !== null) {
    const match = /^Bearer ([^\s]+)$/i.exec(authorization);
    if (!match || match[1].length > 4096 || !env?.AGENT_TOKEN?.trim()) return null;
    return await constantTimeEqual(match[1], env.AGENT_TOKEN) ? 'bearer' : null;
  }
  if (!loginConfigured(env)) return null;
  const token = readSessionCookie(request);
  return token && await verifySession(token, env.SESSION_SECRET) ? 'cookie' : null;
}

/** Safe for Studio page guards; unsafe cookie requests also have to pass CSRF. */
export async function isAuthenticated(request: Request, env: Env): Promise<boolean> {
  const mode = await authentication(request, env);
  return mode !== null && (mode !== 'cookie' || !unsafe.has(request.method.toUpperCase()) || sameOrigin(request));
}

export async function requireAuth(request: Request, env: Env): Promise<Response | null> {
  const mode = await authentication(request, env);
  if (!mode) return json({ error: 'Authentication required.' }, 401);
  if (mode === 'cookie' && unsafe.has(request.method.toUpperCase()) && !sameOrigin(request)) {
    return json({ error: 'A matching Origin is required.' }, 403);
  }
  return null;
}

/** Only trust Cloudflare's injected address. A shared local bucket is for local development only. */
export async function hashedClientKey(request: Request, env: Env, purpose: 'login' | 'visit', path = '', now = Date.now()): Promise<string | null> {
  if (!env?.SESSION_SECRET?.trim()) return null;
  let address = request.headers.get('CF-Connecting-IP');
  const hostname = new URL(request.url).hostname;
  if (!address && ['localhost', '127.0.0.1', '[::1]'].includes(hostname)) address = 'local-development';
  if (!address || address.length > 64) return null;
  // Login keys stay stable across midnight, enforcing the full 15-minute window.
  // Analytics keys rotate daily and contain neither the address nor raw paths.
  const day = new Date(now).toISOString().slice(0, 10);
  const salt = await sign(purpose === 'visit' ? `visit-salt:${day}` : 'login-salt', env.SESSION_SECRET);
  return sign(JSON.stringify([purpose, address, purpose === 'visit' ? path : '', purpose === 'visit' ? Math.floor(now / 60000) : '']), salt);
}
