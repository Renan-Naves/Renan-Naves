// Google Ads — Lead counted on the WhatsApp MESSAGE, not on the site button click.
//
// The uazapi webhook calls fireGoogleMessageLead() when an inbound message carries
// the token of a Google session (gclid). Uploads to
// GOOGLE_ADS_MESSAGE_CONVERSION_ACTION_ID and audits every attempt in
// conversion_fires (event_name 'Lead', platform 'google'). Idempotent per gclid:
// skips once an ok row exists, and the transaction id is derived from the gclid
// so a webhook retry racing the audit row is still deduped by Google.
//
// retryFailedMessageLeads() re-sends the gclids whose every attempt failed (e.g.
// the conversion action was still propagating right after it was created).

import { sendGoogleOfflineConversion } from '../google-ads.js';

export async function fireGoogleMessageLead(env, { conversationId, gclid, phone, eventTime }) {
  const conversionActionId = env.GOOGLE_ADS_MESSAGE_CONVERSION_ACTION_ID;
  if (!conversionActionId || !gclid) return { skipped: 'missing action id or gclid' };
  try {
    const existing = await env.DB.prepare(`
      SELECT id FROM conversion_fires
      WHERE click_id = ? AND event_name = 'Lead' AND platform = 'google' AND response_ok = 1 LIMIT 1
    `).bind(gclid).first();
    if (existing) return { skipped: 'already fired' };
  } catch (_) { /* conversion_fires not migrated → proceed best-effort */ }

  const eventId = 'wamsg-' + (await sha256Hex(gclid)).slice(0, 32);
  const result = await sendGoogleOfflineConversion({
    env, conversionActionId, gclid, eventTime, transactionId: eventId, phone,
  });

  try {
    await env.DB.prepare(`
      INSERT INTO conversion_fires
        (conversation_id, event_name, platform, click_id, click_id_type, value_cents, currency,
         event_id, status_code, response_ok, response_body, fired_at)
      VALUES (?, 'Lead', 'google', ?, 'gclid', NULL, 'BRL', ?, ?, ?, ?, ?)
    `).bind(
      conversationId ?? null, gclid, eventId,
      result.response?.status ?? null, result.response?.ok ? 1 : 0,
      result.skipped ? `skipped: ${result.skipped}` : (result.body || '').slice(0, 1000),
      Math.floor(eventTime || Date.now() / 1000),
    ).run();
  } catch (_) { /* ignore audit failure */ }

  return result;
}

// fired_at of the first failed attempt is the message time (see the insert above),
// so the retry keeps the original conversion time.
export async function retryFailedMessageLeads(env, { limit = 200 } = {}) {
  const { results } = await env.DB.prepare(`
    SELECT g.gclid, g.event_time, g.conversation_id, c.wa_phone AS phone
      FROM (SELECT click_id AS gclid, MIN(fired_at) AS event_time, MAX(conversation_id) AS conversation_id
              FROM conversion_fires
             WHERE event_name = 'Lead' AND platform = 'google'
             GROUP BY click_id
            HAVING MAX(response_ok) = 0
             LIMIT ?) g
      LEFT JOIN wa_conversations c ON c.id = g.conversation_id
  `).bind(limit).all();

  const out = [];
  for (const r of results || []) {
    const res = await fireGoogleMessageLead(env, {
      conversationId: r.conversation_id, gclid: r.gclid, phone: r.phone, eventTime: r.event_time,
    });
    out.push({ status: res.response?.status ?? null, ok: !!res.response?.ok, skipped: res.skipped || null });
  }
  return out;
}

async function sha256Hex(value) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
