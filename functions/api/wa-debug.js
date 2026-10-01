// GET /api/wa-debug?key=<DASH_KEY>&ref=1&limit=20
//
// TEMP DIAGNOSTIC (remove together with captureRaw() in the uazapi webhook once
// the missing-ctwa_clid cause is known). Reads back the inbound payloads the
// webhook stored because they arrived WITHOUT a ctwa_clid.
//
// ?ref=1  → only rows that look like an ad message (ad keys in the payload, or
//           the CTWA default greeting text)
// Auth: ?key=<DASH_KEY>.

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (!env.DASH_KEY || url.searchParams.get('key') !== env.DASH_KEY) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const onlyRef = url.searchParams.get('ref') === '1';
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 100);

  try {
    const sql = `SELECT id, has_ref, datetime(created_at,'unixepoch') AS created, raw
                 FROM wa_raw_debug ${onlyRef ? 'WHERE has_ref = 1' : ''}
                 ORDER BY id DESC LIMIT ?`;
    const rows = await env.DB.prepare(sql).bind(limit).all();
    return json({ count: rows.results?.length || 0, only_ref: onlyRef, rows: rows.results || [] });
  } catch (e) {
    return json({ error: 'no capture table yet — webhook has not stored a payload (' + e.message + ')' });
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
