// GET /api/wa-debug?key=<DASH_KEY>&ref=1&limit=20
//
// TEMP DIAGNOSTIC (remove together with captureRaw() in the uazapi webhook once
// the CTWA referral/ctwa_clid shape is confirmed). Reads back the raw inbound
// payloads captured by the webhook so we can see the real uazapi field paths for
// a Click-to-WhatsApp ad message and fix normalise() accordingly.
//
// ?ref=1  → only rows flagged as carrying an ad referral (the CTWA first message)
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
