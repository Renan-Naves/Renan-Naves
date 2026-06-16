// GET /api/conversation-detail?key=<DASH_KEY>&id=<conversation_id>&mark_read=0|1
//
// Full view of one WhatsApp conversation for the dashboard pop-ups:
//   - CRM thread (WhatsApp/Comercial tab) → call with mark_read=1, which also
//     stamps last_viewed_at=now so the "unread" (red) dot clears.
//   - Attribution details (Atribuição UTM tab) → call with mark_read=0 (default).
//
// Returns { conversation, session, messages[], fires[] }. The conversation row
// carries the REAL phone (this endpoint is gated by DASH_KEY and the attendant
// needs the number to work the lead).
//
// Auth: ?key=<DASH_KEY>.

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!env.DASH_KEY || key !== env.DASH_KEY) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const id = parseInt(url.searchParams.get('id'), 10);
  if (!id) return json({ error: 'id is required' }, 400);
  const markRead = url.searchParams.get('mark_read') === '1';

  let conv;
  try {
    conv = await env.DB.prepare('SELECT * FROM wa_conversations WHERE id = ? AND deleted_at IS NULL')
      .bind(id).first();
  } catch (_) {
    return json({ error: 'wa_conversations not migrated yet' }, 503);
  }
  if (!conv) return json({ error: 'conversation not found' }, 404);

  const now = Math.floor(Date.now() / 1000);
  if (markRead) {
    try {
      await env.DB.prepare('UPDATE wa_conversations SET last_viewed_at = ? WHERE id = ?')
        .bind(now, id).run();
      conv.last_viewed_at = now;
    } catch (_) { /* ignore */ }
  }

  // linked LP session (Google/token path) — best effort
  let session = null;
  if (conv.session_id) {
    try {
      session = await env.DB.prepare(`
        SELECT session_id, gclid, fbclid, fbc, fbp, ip_address, user_agent, referrer, landing_url,
               utm_source, utm_medium, utm_campaign, utm_content, utm_term, created_at
        FROM sessions WHERE session_id = ?
      `).bind(conv.session_id).first();
    } catch (_) { /* ignore */ }
  }

  // thread (forward-only; may be empty / unmigrated)
  let messages = [];
  try {
    const r = await env.DB.prepare(`
      SELECT id, direction, body, status, sender_name, msg_at, created_at
      FROM wa_messages WHERE conversation_id = ?
      ORDER BY COALESCE(msg_at, created_at) ASC, id ASC
    `).bind(id).all();
    messages = r.results || [];
  } catch (_) { /* wa_messages not migrated yet */ }

  // offline-conversion audit trail
  let fires = [];
  try {
    const r = await env.DB.prepare(`
      SELECT event_name, platform, click_id, click_id_type, value_cents, currency,
             status_code, response_ok, fired_at
      FROM conversion_fires WHERE conversation_id = ?
      ORDER BY fired_at DESC
    `).bind(id).all();
    fires = r.results || [];
  } catch (_) { /* conversion_fires not migrated yet */ }

  return json({
    conversation: {
      id: conv.id,
      phone: formatPhone(conv.wa_phone),
      name: conv.wa_contact_name || '',
      wa_chat_id: conv.wa_chat_id || '',
      first_message: conv.first_message || '',
      platform: conv.platform || 'unknown',
      link_method: conv.link_method || 'unresolved',
      ctwa_clid: conv.ctwa_clid || '',
      session_id: conv.session_id || '',
      gclid: conv.gclid || '',
      fbc: conv.fbc || '',
      fbp: conv.fbp || '',
      manual_origin: conv.manual_origin || '',
      referral_name: conv.referral_name || '',
      utm_source: conv.utm_source || '',
      utm_medium: conv.utm_medium || '',
      utm_campaign: conv.utm_campaign || '',
      utm_content: conv.utm_content || '',
      utm_term: conv.utm_term || '',
      status: conv.status || 'new',
      is_qualified: !!conv.is_qualified,
      sale_value: conv.sale_value_cents != null ? conv.sale_value_cents / 100 : null,
      sale_currency: conv.sale_currency || 'BRL',
      first_message_at: conv.first_message_at,
      last_inbound_at: conv.last_inbound_at,
      last_outbound_at: conv.last_outbound_at,
      last_viewed_at: conv.last_viewed_at,
      qualified_at: conv.qualified_at,
      sale_at: conv.sale_at,
      marked_by: conv.marked_by || '',
      archived_at: conv.archived_at,
      created_at: conv.created_at,
      updated_at: conv.updated_at,
    },
    session,
    messages: messages.map(m => ({
      id: m.id,
      direction: m.direction,
      body: m.body || '',
      status: m.status || '',
      sender_name: m.sender_name || '',
      at: m.msg_at || m.created_at,
    })),
    fires: fires.map(f => ({
      event_name: f.event_name,
      platform: f.platform,
      click_id: f.click_id || '',
      click_id_type: f.click_id_type || '',
      value: f.value_cents != null ? f.value_cents / 100 : null,
      currency: f.currency || 'BRL',
      status_code: f.status_code,
      response_ok: !!f.response_ok,
      fired_at: f.fired_at,
    })),
  });
}

// Show the FULL WhatsApp number for the attendant. The stored number is the
// @s.whatsapp.net JID digits (55 + DDD + line).
// BR mobiles → "(DD) 9 NNNN-NNNN", landlines → "(DD) NNNN-NNNN".
function formatPhone(p) {
  if (!p) return '';
  const d = String(p).replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) {
    const ddd = d.slice(2, 4);
    const rest = d.slice(4);
    if (rest.length === 9) return `(${ddd}) ${rest[0]} ${rest.slice(1, 5)}-${rest.slice(5)}`;
    return `(${ddd}) ${rest.slice(0, 4)}-${rest.slice(4)}`;
  }
  return '+' + d;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
