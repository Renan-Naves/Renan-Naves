// functions/lib/ctwa-funnel.js
//
// KROB whatsapp-tracking v0.3 clinic funnel, ported into the site's CTWA tracker
// (ctwa_conversions / wa_webhook_events / wa_auto_rules). The two stages v0.2
// didn't have:
//
//   Respondeu      — automatic: the contact writes after a HUMAN message from
//                    the clinic in the same chat since the CTWA click. Fires
//                    ViewContent (ctwa-capi.js fireReplied).
//   Desqualificado — nao respondeu, fora do perfil, sem orcamento, outro. Sent
//                    as OrderCanceled for an exclusion audience. Blocks the
//                    automatic Respondeu/Orcou; Agendou still fires.
//
// Stage precedence (same as the dashboard): Agendou > Desqualificado > Orcou >
// Respondeu > Lead novo. A stage counts once its event happened, whatever Meta
// answered.

import { fireReplied, fireDisqualified, syncFunnel } from './ctwa-capi.js';

export const DISQUALIFY_REASONS = ['nao_respondeu', 'fora_do_perfil', 'sem_orcamento', 'outro'];

export const STAGE_SQL = {
  novo: 'c.replied_status IS NULL AND c.qualified_lead_status IS NULL AND c.purchase_status IS NULL AND c.disqualified_at IS NULL',
  respondeu: 'c.replied_status IS NOT NULL AND c.qualified_lead_status IS NULL AND c.purchase_status IS NULL AND c.disqualified_at IS NULL',
  orcou: 'c.qualified_lead_status IS NOT NULL AND c.purchase_status IS NULL AND c.disqualified_at IS NULL',
  agendou: 'c.purchase_status IS NOT NULL',
  desqualificado: 'c.disqualified_at IS NOT NULL AND c.purchase_status IS NULL',
};

// CASE expression giving the stage key of a ctwa_conversions row aliased `c`.
export const STAGE_CASE = `CASE
  WHEN ${STAGE_SQL.agendou} THEN 'agendou'
  WHEN ${STAGE_SQL.desqualificado} THEN 'desqualificado'
  WHEN ${STAGE_SQL.orcou} THEN 'orcou'
  WHEN ${STAGE_SQL.respondeu} THEN 'respondeu'
  ELSE 'novo' END`;

// The clinic's automatic messages (WhatsApp Business greeting, out-of-hours
// notice, chatbot) must not count as "the clinic answered". Two layers:
//   1. auto_message rules: an outbound message containing one of these phrases;
//   2. time window: an outbound message sent less than AUTO_MSG_WINDOW_SECONDS
//      (default 10, 0 = off) after the contact's last message.
export async function loadAutoMessageRules(env) {
  const rs = await env.DB.prepare(
    "SELECT * FROM wa_auto_rules WHERE enabled = 1 AND event_type = 'auto_message' ORDER BY id",
  ).all();
  return rs?.results ?? [];
}

export function autoMessageRule(rules, text) {
  if (!text || typeof text !== 'string') return null;
  return (rules ?? []).find((r) => {
    if (r?.event_type !== 'auto_message' || !r.pattern) return false;
    const hay = r.case_sensitive ? text : text.toLowerCase();
    const needle = r.case_sensitive ? r.pattern : r.pattern.toLowerCase();
    return hay.includes(needle);
  }) ?? null;
}

export function autoMessageWindowMs(env) {
  const raw = env.AUTO_MSG_WINDOW_SECONDS;
  const n = raw === undefined || raw === null || raw === '' ? 10 : Number(raw);
  return Number.isFinite(n) && n > 0 ? n * 1000 : 0;
}

// Runs inside waitUntil() for every inbound 1:1 message (text or not: an audio
// reply counts). One indexed lookup per message when the contact has no CTWA
// click, which is the common case. AUTO_REPLIED=0 turns it off.
export async function detectReply(env, { chatId, contactPhone, eventRowId, eventTime }) {
  if (env.AUTO_REPLIED === '0' || env.AUTO_REPLIED === 'false') return { status: 'disabled' };
  if (!chatId || !contactPhone || !eventRowId) return { status: 'no_contact' };

  const conv = await env.DB.prepare(`
    SELECT id, ctwa_clid, ad_id, sender_pn, first_seen_at, replied_status, disqualified_at
    FROM ctwa_conversions WHERE sender_pn = ? ORDER BY first_seen_at DESC LIMIT 1
  `).bind(contactPhone).first();

  if (!conv?.ctwa_clid) return { status: 'no_conversion' };
  // 'failed' may retry on the next reply; anything else already settled it.
  if (conv.replied_status && conv.replied_status !== 'failed') return { status: `already_${conv.replied_status}` };
  if (conv.disqualified_at) return { status: 'disqualified' };

  // The chat since the click, oldest first; look for one human message of ours.
  const rs = await env.DB.prepare(`
    SELECT id, from_me, received_at, message_content FROM wa_webhook_events
    WHERE chat_id = ? AND received_at >= ? AND id < ?
    ORDER BY id LIMIT 500
  `).bind(chatId, conv.first_seen_at, eventRowId).all();

  const autoRules = await loadAutoMessageRules(env);
  const windowMs = autoMessageWindowMs(env);
  let lastInboundAt = conv.first_seen_at; // the CTWA message itself
  let human = false;
  for (const m of rs?.results ?? []) {
    if (!m.from_me) { lastInboundAt = m.received_at; continue; }
    if (autoMessageRule(autoRules, m.message_content)) continue;
    if (windowMs && m.received_at - lastInboundAt < windowMs) continue;
    human = true;
    break;
  }
  if (!human) return { status: 'no_outbound_yet' };

  return fireReplied(env, {
    conversionId: conv.id, ctwaClid: conv.ctwa_clid, adId: conv.ad_id, phone: conv.sender_pn,
    eventTime, source: 'auto',
  });
}

// Mark + send. conv needs id, ctwa_clid, ad_id, sender_pn, wa_conversation_id,
// disqualified_status. OrderCanceled goes once per contact: after an undo and a
// new mark only the reason changes (Meta would dedup the stable event_id anyway).
export async function disqualify(env, { conv, reason, note, source, markedBy, eventTime }) {
  await env.DB.prepare(`
    UPDATE ctwa_conversions
       SET disqualified_at=?, disqualified_reason=?, disqualified_note=?, disqualified_source=?
     WHERE id = ?`).bind(Date.now(), reason, note ?? null, source ?? null, conv.id).run();
  await syncFunnel(env, conv.wa_conversation_id, { kind: 'lost', markedBy: markedBy || source || 'funil' });
  if (conv.disqualified_status === 'sent' || conv.disqualified_status === 'sending') {
    return { status: 'already_sent', attempts: 0 };
  }
  return fireDisqualified(env, {
    conversionId: conv.id, ctwaClid: conv.ctwa_clid, adId: conv.ad_id, phone: conv.sender_pn,
    eventTime: eventTime ?? Math.floor(Date.now() / 1000),
  });
}

// Undo clears the mark only. An event already sent to Meta can't be unsent; the
// send columns stay as the record of it.
export async function clearDisqualified(env, { conv, markedBy }) {
  await env.DB.prepare(`
    UPDATE ctwa_conversions
       SET disqualified_at=NULL, disqualified_reason=NULL, disqualified_note=NULL, disqualified_source=NULL
     WHERE id = ?`).bind(conv.id).run();
  await syncFunnel(env, conv.wa_conversation_id, { kind: 'unlost', markedBy: markedBy || 'funil' });
}
