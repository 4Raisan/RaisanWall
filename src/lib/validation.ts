import { deriveExcerpt } from './content';
import { CATEGORIES, FORMATS, STATUSES, type Post, type PostQuery, type Settings, type ValidatedPost } from './types';

export class HttpError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = 'HttpError'; }
}
export { HttpError as ValidationError };

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  const result = new Headers(headers);
  result.set('Content-Type', 'application/json; charset=utf-8');
  result.set('X-Content-Type-Options', 'nosniff');
  if (!result.has('Cache-Control')) result.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(data), { status, headers: result });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) return json({ error: error.message }, error.status);
  // Never expose SQL, configuration, tokens, or internal exception messages.
  return json({ error: 'An internal error occurred.' }, 500);
}

export async function readLimitedBody(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const size = request.headers.get('Content-Length');
  if (size && Number(size) > limit) throw new HttpError('Request body is too large.', 413);
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); throw new HttpError('Request body is too large.', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError('Content-Type must be application/json.', 415);
  }
  const bytes = await readLimitedBody(request, 1_048_576);
  let data: unknown;
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new HttpError('Invalid JSON body.'); }
  return objectInput(data);
}

export function objectInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError('Expected a JSON object.');
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, max: number, required = false, trim = true): string {
  if (typeof value !== 'string') throw new HttpError(`${name} must be a string.`);
  const result = trim ? value.trim() : value;
  if (result.length > max || (required && !result.trim())) throw new HttpError(`${name} must be ${required ? '1' : '0'}–${max} characters.`);
  if (result.includes('\0')) throw new HttpError(`${name} contains invalid characters.`);
  return result;
}

function choice<T extends string>(value: unknown, name: string, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new HttpError(`Invalid ${name}.`);
  return value as T;
}

export function validateUrl(value: unknown, name = 'URL', allowLocal = false): string | null {
  if (value === null || value === '') return null;
  const url = text(value, name, 2048, true);
  if (/[\s\\\u0000-\u001f\u007f]/.test(url)) throw new HttpError(`Invalid ${name}.`);
  if (allowLocal && /^\/(?:media|art)\/[a-zA-Z0-9_./-]+$/.test(url)) {
    if (url.split('/').some(part => part === '.' || part === '..')) throw new HttpError(`Invalid ${name}.`);
    return url;
  }
  try {
    const parsed = new URL(url);
    if (!/^https?:\/\//i.test(url) || !['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) throw new Error();
    return parsed.href;
  } catch { throw new HttpError(`${name} must be an HTTP(S) URL${allowLocal ? ' or a local /media/ or /art/ path' : ''}.`); }
}

export function validateDate(value: unknown, name = 'date'): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) throw new HttpError(`${name} must be an ISO date.`);
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > daysInMonth || !Number.isFinite(Date.parse(value))) throw new HttpError(`Invalid ${name}.`);
  if (value.length > 10 && (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59)) throw new HttpError(`Invalid ${name}.`);
  return new Date(value).toISOString();
}

export function slugify(title: string): string {
  return title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120).replace(/-+$/g, '') || 'post';
}

export function validatePost(input: unknown, existing?: Post, now = new Date()): ValidatedPost {
  const data = objectInput(input);
  const get = (key: keyof ValidatedPost, fallback: unknown) => data[key] !== undefined ? data[key] : existing ? existing[key] : fallback;
  const title = text(get('title', undefined), 'title', 200, true);
  const body = text(get('body', undefined), 'body', 200_000, true, false);
  const format = choice(get('format', 'markdown'), 'format', FORMATS);
  const slug = text(get('slug', slugify(title)), 'slug', 120, true);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new HttpError('slug must contain lowercase letters, numbers, and single dashes.');
  const category = choice(get('category', 'Thoughts'), 'category', CATEGORIES);
  const status = choice(get('status', 'draft'), 'status', STATUSES);
  const rawTags = get('tags', []);
  if (!Array.isArray(rawTags) || rawTags.length > 20) throw new HttpError('tags must be an array with at most 20 items.');
  const tags = [...new Set(rawTags.map(tag => text(tag, 'tag', 40, true)))];
  const pinned = get('pinned', false);
  if (typeof pinned !== 'boolean') throw new HttpError('pinned must be a boolean.');
  let published_at = validateDate(get('published_at', null), 'published_at');
  if (status === 'published' && !published_at) published_at = now.toISOString();
  if (status === 'scheduled') {
    const unchangedSchedule = existing?.status === 'scheduled' && published_at !== null && published_at === validateDate(existing.published_at);
    if (!published_at || (Date.parse(published_at) <= now.getTime() && !unchangedSchedule)) throw new HttpError('scheduled posts require a future published_at.');
  }
  const offer_start = validateDate(get('offer_start', null), 'offer_start');
  const offer_end = validateDate(get('offer_end', null), 'offer_end');
  if (offer_start && offer_end && offer_start > offer_end) throw new HttpError('offer_start must not be after offer_end.');
  const nullableText = (key: 'link_label' | 'invite_code', max: number) => {
    const value = get(key, null);
    return value === null || value === '' ? null : text(value, key, max);
  };
  return {
    title, body, slug, format, category, status, tags, pinned, published_at, offer_start, offer_end,
    excerpt: text(get('excerpt', deriveExcerpt(body, format)), 'excerpt', 500),
    cover_image: validateUrl(get('cover_image', null), 'cover_image', true),
    link_url: validateUrl(get('link_url', null), 'link_url'),
    link_label: nullableText('link_label', 100),
    invite_code: nullableText('invite_code', 200),
  };
}

export function validateSettings(input: unknown): Partial<Settings> {
  const data = objectInput(input);
  const limits = { site_name: 100, tagline: 200, description: 1000, author_name: 100, author_bio: 2000 } as const;
  const result: Partial<Settings> = {};
  for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
    if (data[key] !== undefined) result[key] = text(data[key], key, limits[key], key === 'site_name' || key === 'author_name');
  }
  for (const key of ['github_url', 'contact_url'] as const) {
    if (data[key] !== undefined) result[key] = validateUrl(data[key], key) ?? '';
  }
  if (data.launch_date !== undefined) {
    const date = validateDate(data.launch_date, 'launch_date');
    if (!date) throw new HttpError('launch_date is required.');
    result.launch_date = date;
  }
  if (!Object.keys(result).length) throw new HttpError('No supported settings were supplied.');
  return result;
}

export function validateQuery(query: PostQuery = {}): Required<Omit<PostQuery, 'status'>> & { status?: string } {
  const category = query.category ? choice(query.category, 'category', CATEGORIES) : '';
  const status = query.status ? choice(query.status, 'status', STATUSES) : undefined;
  const page = query.page ?? 1;
  const requestedLimit = query.limit ?? 12;
  if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000) throw new HttpError('Invalid page.');
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) throw new HttpError('Invalid limit.');
  return {
    category, status, page, limit: Math.min(requestedLimit, 30), studio: query.studio === true,
    q: text(query.q ?? '', 'q', 200), tag: text(query.tag ?? '', 'tag', 40),
    sort: choice(query.sort || 'newest', 'sort', ['newest', 'oldest']),
  };
}

export function queryFromUrl(url: URL, studio: boolean): PostQuery {
  const p = url.searchParams;
  return {
    category: p.get('category') || undefined, q: p.get('q') || undefined,
    tag: p.get('tag') || undefined, sort: p.get('sort') || undefined,
    page: p.has('page') ? Number(p.get('page')) : undefined,
    limit: p.has('limit') ? Number(p.get('limit')) : undefined,
    status: studio ? p.get('status') || undefined : undefined, studio,
  };
}

export function validatePreview(input: unknown): { body: string; format: 'markdown' | 'html' } {
  const data = objectInput(input);
  return { body: text(data.body, 'body', 200_000, false, false), format: choice(data.format ?? 'markdown', 'format', FORMATS) };
}

export function validateVisitPath(input: unknown): string {
  if (typeof input !== 'string' || input.length > 126 || (input !== '/' && !/^\/post\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input))) throw new HttpError('Invalid visit path.');
  return input;
}

export const IMAGE_MIME = {
  png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
} as const;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export type ImageExtension = keyof typeof IMAGE_MIME;

export function detectImage(bytes: Uint8Array): ImageExtension | null {
  if (bytes.length < 12) return null;
  const matches = (offset: number, signature: number[]) => signature.every((value, index) => bytes[offset + index] === value);
  const ascii = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (matches(0, [137, 80, 78, 71, 13, 10, 26, 10])) return 'png';
  if (matches(0, [255, 216, 255])) return 'jpg';
  if (['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return 'gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'webp';
  if (bytes.length >= 16 && ascii(4, 4) === 'ftyp') {
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    if (size >= 16 && size <= bytes.length && size <= 4096 && size % 4 === 0) {
      for (let offset = 8; offset < size; offset += 4) {
        if (offset !== 12 && ['avif', 'avis'].includes(ascii(offset, 4))) return 'avif';
      }
    }
  }
  return null;
}

export function mediaContentType(key: string): string | null {
  const match = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(png|jpg|webp|gif|avif)$/.exec(key);
  return match ? IMAGE_MIME[match[1] as ImageExtension] : null;
}
