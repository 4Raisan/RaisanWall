import type { APIRoute } from 'astro';
import { requireAuth } from '../../lib/auth';
import { detectImage, errorResponse, HttpError, IMAGE_MIME, json, MAX_IMAGE_BYTES, readLimitedBody } from '../../lib/validation';
import type { Env } from '../../lib/types';

export const prerender = false;
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = locals.env as Env;
    const denied = await requireAuth(request, env);
    if (denied) return denied;
    const contentType = request.headers.get('Content-Type') ?? '';
    if (!/^multipart\/form-data\s*;/i.test(contentType)) throw new HttpError('Expected multipart/form-data.', 415);
    const bytes = await readLimitedBody(request, MAX_IMAGE_BYTES + 64 * 1024);
    let form: FormData;
    try { form = await new Response(bytes, { headers: { 'Content-Type': contentType } }).formData(); }
    catch { throw new HttpError('Invalid multipart form.'); }
    const files = form.getAll('file');
    const file = files[0];
    if (files.length !== 1 || !file || typeof file === 'string') throw new HttpError('Provide one image in the file field.');
    if (!file.size || file.size > MAX_IMAGE_BYTES) throw new HttpError('Images must be between 1 byte and 8 MB.', 413);
    const image = new Uint8Array(await file.arrayBuffer());
    const extension = detectImage(image);
    if (!extension || file.type.toLowerCase() !== IMAGE_MIME[extension]) throw new HttpError('Use a PNG, JPEG, WebP, GIF, or AVIF image with a matching MIME type.', 415);
    const key = `${crypto.randomUUID()}.${extension}`;
    await env.MEDIA.put(key, image, { httpMetadata: { contentType: IMAGE_MIME[extension], cacheControl: 'public, max-age=31536000, immutable' } });
    return json({ url: `/media/${key}` }, 201);
  } catch (error) { return errorResponse(error); }
};
