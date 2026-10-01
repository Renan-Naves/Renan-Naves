// GET /api/ctwa/events/:id?key=… — one captured webhook including the full raw_payload.

import { guard, json } from '../../../lib/ctwa-http.js';

export async function onRequestGet({ request, env, params }) {
  const denied = await guard(request, env);
  if (denied) return denied;

  const id = Number.parseInt(params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return json({ ok: false, error: 'invalid_id' }, 400);

  const row = await env.DB.prepare('SELECT * FROM wa_webhook_events WHERE id = ?').bind(id).first();
  if (!row) return json({ ok: false, error: 'not_found' }, 404);
  return json({ event: row });
}
