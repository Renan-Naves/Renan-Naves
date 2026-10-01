// functions/lib/ctwa-http.js — shared bits for the /api/ctwa/* endpoints.
// Auth: the same DASH_KEY as /dashboard, sent as ?key= or the x-dash-key header.

import { ensureCtwaSchema } from './ctwa-schema.js';

// Returns a 401 Response when unauthorized, else null (and makes sure the
// tracker tables exist).
export async function guard(request, env) {
  const url = new URL(request.url);
  const key = request.headers.get('x-dash-key') || url.searchParams.get('key') || '';
  if (!env.DASH_KEY || key !== env.DASH_KEY) return json({ error: 'Unauthorized' }, 401);
  await ensureCtwaSchema(env);
  return null;
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

export async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}
