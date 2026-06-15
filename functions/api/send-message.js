// POST /api/send-message?key=<DASH_KEY>
//
// Sends a WhatsApp reply from the dashboard mini-CRM through the uazapi instance,
// then records it as an outbound row in wa_messages and bumps last_outbound_at on
// the conversation (so its atendimento dot turns green — awaiting the lead).
//
// Body: { conversation_id, text }
//
// Dormant until BOTH UAZAPI_BASE_URL and UAZAPI_TOKEN are set (same "self-skip"
// pattern as the rest of the stack). The uazapi send shape is the standard REST
// (POST {base}/send/text, header `token`, body { number, text }); CONFIRM it
// against the client's uazapi server and adjust send() if their build differs.
//
// Auth: ?key=<DASH_KEY>.

export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!env.DASH_KEY || key !== env.DASH_KEY) {
    return json({ error: 'Unauthorized' }, 401);
  }

  let body = {};
  try { body = await request.json(); } catch (_) { return json({ error: 'Invalid JSON body' }, 400); }

  const conversationId = parseInt(body.conversation_id, 10);
  const text = String(body.text || '').trim();
  if (!conversationId || !text) {
    return json({ error: 'conversation_id and a non-empty text are required' }, 400);
  }

  if (!env.UAZAPI_BASE_URL || !env.UAZAPI_TOKEN) {
    return json({ error: 'envio indisponível: UAZAPI_BASE_URL / UAZAPI_TOKEN não configurados', skipped: true }, 503);
  }

  let conv;
  try {
    conv = await env.DB.prepare('SELECT id, wa_phone, wa_chat_id FROM wa_conversations WHERE id = ?')
      .bind(conversationId).first();
  } catch (_) {
    return json({ error: 'wa_conversations not migrated yet' }, 503);
  }
  if (!conv) return json({ error: 'conversation not found' }, 404);

  // uazapi addresses by phone number (digits); fall back to the chat id.
  const number = String(conv.wa_phone || '').replace(/\D/g, '') || String(conv.wa_chat_id || '');
  if (!number) return json({ error: 'conversation has no phone / chat id to send to' }, 422);

  const now = Math.floor(Date.now() / 1000);
  let sent;
  try {
    sent = await send(env, number, text);
  } catch (e) {
    await recordOutbound(env, conv, text, null, 'failed', now);
    return json({ error: 'uazapi send failed: ' + e.message, fired: false }, 502);
  }

  const ok = sent.ok;
  await recordOutbound(env, conv, text, sent.messageId, ok ? 'sent' : 'failed', now);
  if (ok) {
    try {
      await env.DB.prepare('UPDATE wa_conversations SET last_outbound_at = ?, updated_at = ? WHERE id = ?')
        .bind(now, now, conv.id).run();
    } catch (_) { /* ignore */ }
  }

  return json({ ok, message_id: sent.messageId || null, status: sent.status, conversation_id: conv.id });
}

// Standard uazapi REST send. The instance token rides in the `token` header.
async function send(env, number, text) {
  const base = String(env.UAZAPI_BASE_URL).replace(/\/+$/, '');
  const res = await fetch(`${base}/send/text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', token: env.UAZAPI_TOKEN },
    body: JSON.stringify({ number, text }),
  });
  let data = {};
  try { data = await res.json(); } catch (_) { /* non-JSON body */ }
  // uazapi returns the created message; the id field name varies by build.
  const messageId = data.id || data.messageid || data.messageId || data.key?.id
    || data.message?.id || data.message?.key?.id || null;
  return { ok: res.ok, status: res.status, messageId: messageId ? String(messageId) : null };
}

async function recordOutbound(env, conv, text, messageId, status, now) {
  try {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO wa_messages
        (conversation_id, wa_chat_id, wa_message_id, direction, body, status, sender_name, msg_at, created_at)
      VALUES (?, ?, ?, 'out', ?, ?, ?, ?, ?)
    `).bind(conv.id, conv.wa_chat_id, messageId || null, text, status, 'atendente', now, now).run();
  } catch (_) { /* wa_messages not migrated yet — send still succeeded */ }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
