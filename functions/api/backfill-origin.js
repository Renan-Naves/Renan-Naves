// GET  /api/backfill-origin?key=<DASH_KEY>          → dry run (what would change)
// POST /api/backfill-origin?key=<DASH_KEY>          → apply
//
// TEMP one-off (2026-10-01): re-classifies conversations stuck at
// platform='unknown' using originFromText() on their first message — the same
// rule the uazapi webhook now applies to new messages (CTWA default greeting →
// meta/'ctwa-text'; instagram/tiktok bio pre-filled text → organic). Never
// touches rows that already have a platform or a manual origin. Remove after use.

import { originFromText } from '../origins.js';

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (!env.DASH_KEY || url.searchParams.get('key') !== env.DASH_KEY) {
    return json({ error: 'Unauthorized' }, 401);
  }
  const apply = request.method === 'POST';

  try {
    const rows = (await env.DB.prepare(`
      SELECT id, first_message FROM wa_conversations
      WHERE (platform IS NULL OR platform IN ('unknown',''))
        AND (manual_origin IS NULL OR manual_origin = '')
        AND deleted_at IS NULL
    `).all()).results || [];

    const now = Math.floor(Date.now() / 1000);
    const counts = {};
    let changed = 0;
    for (const r of rows) {
      const hit = originFromText(r.first_message);
      if (!hit) continue;
      const k = `${hit.platform}/${hit.utmSource}`;
      counts[k] = (counts[k] || 0) + 1;
      changed++;
      if (apply) {
        await env.DB.prepare(`
          UPDATE wa_conversations
             SET platform = ?, link_method = ?,
                 utm_source = COALESCE(NULLIF(utm_source,''), ?),
                 utm_medium = COALESCE(NULLIF(utm_medium,''), ?),
                 updated_at = ?
           WHERE id = ? AND (platform IS NULL OR platform IN ('unknown',''))`)
          .bind(hit.platform, hit.linkMethod, hit.utmSource, hit.utmMedium, now, r.id).run();
      }
    }
    return json({ applied: apply, scanned: rows.length, changed, by_origin: counts });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
