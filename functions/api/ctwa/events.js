// GET /api/ctwa/events?key=…  — captured uazapi webhooks, newest first (no raw_payload).
//
// Query: limit (50, max 200), offset, sender_pn (exact digits), since (unix ms),
//        filter = ctwa (has ctwa_clid) | hint (looks like an ad message but NO clid)

import { guard, json, clampInt } from '../../lib/ctwa-http.js';

export async function onRequestGet({ request, env }) {
  const denied = await guard(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
  const senderPn = (url.searchParams.get('sender_pn') || '').replace(/\D/g, '');
  const since = Number(url.searchParams.get('since'));
  const filter = url.searchParams.get('filter') || '';

  const where = [];
  const params = [];
  if (filter === 'ctwa') where.push('is_ctwa = 1');
  if (filter === 'hint') where.push('ad_hint = 1');
  if (senderPn) { where.push('sender_pn LIKE ?'); params.push(`%${senderPn}%`); }
  if (Number.isFinite(since) && since > 0) { where.push('received_at >= ?'); params.push(since); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [list, count, hints] = await Promise.all([
    env.DB.prepare(`
      SELECT id, received_at, event_type, instance_name, message_id, chat_id, sender_pn, sender_name,
             from_me, is_group, message_type, message_content, message_ts,
             is_ctwa, ad_hint, ad_title, entry_point_app, entry_point_source, wa_conversation_id
      FROM wa_webhook_events ${whereSql}
      ORDER BY received_at DESC LIMIT ? OFFSET ?`).bind(...params, limit, offset).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM wa_webhook_events ${whereSql}`).bind(...params).first(),
    env.DB.prepare('SELECT SUM(is_ctwa) AS ctwa, SUM(ad_hint) AS hint FROM wa_webhook_events').first(),
  ]);

  return json({
    events: list.results ?? [],
    count: count?.n ?? 0,
    totals: { ctwa: hints?.ctwa ?? 0, hint: hints?.hint ?? 0 },
    limit, offset,
  });
}
