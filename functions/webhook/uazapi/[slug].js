// POST /webhook/uazapi/<slug>
//
// Inbound WhatsApp webhook for uazapi. INFRA STUB — fully wired so it can be
// turned on later by setting UAZAPI_WEBHOOK_SECRET (and pointing uazapi at this
// URL with the secret). Until then it answers 200 {skipped:true} so a probe
// from uazapi doesn't look broken.
//
// What it does once enabled: for each inbound message it upserts a row into
// wa_conversations (one per chat) and RESOLVES attribution with the hybrid model:
//   1. Meta CTWA  → the message carries a `referral` object with `ctwa_clid`
//                   (+ source_id / ad name). platform='meta', link_method='ctwa'.
//   2. Google/LP  → the first message text carries our "#xxxxxxxx" token (legacy: "(ref: xxxxxxxx)")
//                   (set by shared/renan.js). We look up the matching session,
//                   pull gclid/fbc/utms. platform='google' (or by utm_source),
//                   link_method='token'.
//   3. Text       → no clid/token but a known pre-filled text (CTWA default
//                   greeting → meta/'ctwa-text'; bio links → organic). See
//                   originFromText() in functions/origins.js.
//   4. Neither    → store raw; platform='unknown', link_method='unresolved'
//                   (the attendant links it by hand in the dashboard).
//
// IMPORTANT: uazapi's exact payload shape must be confirmed against a real
// sample before go-live. The normalise() function below isolates that mapping —
// adjust the field paths there once we have a captured payload.

//
// CTWA TRACKER (ported from the KROB WhatsApp stack v0.2 — see functions/lib/ctwa-*.js):
//   - every webhook is stored raw in wa_webhook_events FIRST (source of truth,
//     browsable at /rastreador → Eventos);
//   - a message carrying a ctwa_clid upserts ctwa_conversions and, on the first
//     sight of that click, fires Meta CAPI LeadSubmitted (+ ad-name enrichment)
//     via waitUntil() — uazapi never waits on Meta;
//   - every 1:1 text message is checked against the auto-fire rules (wa_auto_rules).

import { originFromText } from '../../origins.js';
import { ensureCtwaSchema } from '../../lib/ctwa-schema.js';
import { upsertConversion, fireLead, enrichAdIfStale, normalizePhone } from '../../lib/ctwa-capi.js';
import { evaluateAutoRules } from '../../lib/ctwa-rules.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.UAZAPI_WEBHOOK_SECRET) {
    return json({ ok: true, skipped: true, reason: 'UAZAPI_WEBHOOK_SECRET not set' });
  }
  const sent = request.headers.get('x-uazapi-token')
    || new URL(request.url).searchParams.get('token') || '';
  if (sent !== env.UAZAPI_WEBHOOK_SECRET) {
    return json({ error: 'Unauthorized' }, 401);
  }

  let payload;
  try { payload = await request.json(); } catch (_) { return json({ error: 'Invalid JSON' }, 400); }

  const msg = normalise(payload);
  // capture first — even connection/status events, so nothing uazapi sends is lost
  const eventId = await captureEvent(env, payload, msg);
  if (!msg || !msg.chatId) {
    // connection / qrcode / status events (no chat) land here harmlessly
    return json({ ok: true, skipped: true, reason: 'no inbound message in payload' });
  }

  const now = Math.floor(Date.now() / 1000);
  const msgAt = msg.msgAt || now;
  const clidIn = msg.referral && (msg.referral.ctwa_clid || msg.referral.ctwaClid || msg.referral.clickId);

  // auto-fire rules on every 1:1 text message, both directions (after the 200)
  if (msg.text && msg.phone) {
    context.waitUntil(evaluateAutoRules(env, {
      text: msg.text, contactPhone: normalizePhone(msg.phone, env.DEFAULT_COUNTRY_CODE),
      fromMe: msg.fromMe ? 1 : 0, eventTime: msgAt,
    }).catch(() => {}));
  }

  // Outgoing messages (a reply sent FROM the phone, fromMe): never let them
  // create or re-attribute a conversation — but record them so the CRM thread
  // stays complete and last_outbound_at is accurate.
  if (msg.fromMe) {
    let enriched = false;
    try {
      const conv = await env.DB.prepare('SELECT id, ctwa_clid FROM wa_conversations WHERE wa_chat_id = ?')
        .bind(msg.chatId).first();
      if (conv) {
        await insertMessage(env, { conversationId: conv.id, chatId: msg.chatId, messageId: msg.messageId, direction: 'out', body: msg.text, senderName: msg.name, msgAt, now });
        await env.DB.prepare('UPDATE wa_conversations SET last_outbound_at = ?, updated_at = ? WHERE id = ?')
          .bind(msgAt, now, conv.id).run();

        // Safety net: WhatsApp keeps the ad's contextInfo on OUR replies in a
        // CTWA thread too. If the inbound message somehow arrived without it
        // (payload truncated, webhook retry, thread started before this fix),
        // an outbound echo can still recover the ctwa_clid. Never creates a
        // conversation and never overwrites attribution we already have.
        const clid = clidIn;
        if (clid && !conv.ctwa_clid) {
          await env.DB.prepare(`
            UPDATE wa_conversations
               SET ctwa_clid = ?,
                   platform    = CASE WHEN platform IN ('unknown','') OR platform IS NULL THEN 'meta' ELSE platform END,
                   link_method = CASE WHEN link_method IN ('unresolved','') OR link_method IS NULL THEN 'ctwa' ELSE link_method END,
                   utm_source  = COALESCE(utm_source, 'meta-ads'),
                   referral_raw = COALESCE(referral_raw, ?),
                   updated_at  = ?
             WHERE id = ?`)
            .bind(clid, msg.referralRaw, now, conv.id).run();
          enriched = true;
          await trackCtwa(context, { msg, clid, conversationId: conv.id, eventId, eventTime: msgAt });
        }
        await linkEvent(env, eventId, conv.id);
      }
    } catch (_) { /* best-effort: thread completeness must not 500 the webhook */ }
    return json({ ok: true, chat_id: msg.chatId, recorded: 'outbound', ctwa_enriched: enriched });
  }

  const resolved = await resolveAttribution(env, msg);

  let conversationId = null;
  try {
    await env.DB.prepare(`
      INSERT INTO wa_conversations
        (wa_phone, wa_contact_name, wa_chat_id, first_message, platform, link_method,
         ctwa_clid, session_id, gclid, fbc, fbp, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
         referral_raw, status, first_message_at, last_inbound_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?)
      ON CONFLICT(wa_chat_id) DO UPDATE SET
        wa_contact_name = COALESCE(excluded.wa_contact_name, wa_conversations.wa_contact_name),
        -- only fill attribution if we didn't have it yet (first touch wins)
        platform    = CASE WHEN wa_conversations.platform IN ('unknown','') OR wa_conversations.platform IS NULL THEN excluded.platform ELSE wa_conversations.platform END,
        link_method = CASE WHEN wa_conversations.link_method IN ('unresolved','') OR wa_conversations.link_method IS NULL THEN excluded.link_method ELSE wa_conversations.link_method END,
        ctwa_clid   = COALESCE(wa_conversations.ctwa_clid, excluded.ctwa_clid),
        session_id  = COALESCE(wa_conversations.session_id, excluded.session_id),
        gclid       = COALESCE(wa_conversations.gclid, excluded.gclid),
        last_inbound_at = excluded.last_inbound_at,
        updated_at  = excluded.updated_at
    `).bind(
      resolved.phone, resolved.name, msg.chatId, msg.text, resolved.platform, resolved.linkMethod,
      resolved.ctwaClid, resolved.sessionId, resolved.gclid, resolved.fbc, resolved.fbp,
      resolved.utmSource, resolved.utmMedium, resolved.utmCampaign, resolved.utmContent, resolved.utmTerm,
      msg.referralRaw, msgAt, msgAt, now, now,
    ).run();
    const conv = await env.DB.prepare('SELECT id FROM wa_conversations WHERE wa_chat_id = ?')
      .bind(msg.chatId).first();
    conversationId = conv && conv.id;
  } catch (e) {
    return json({ error: 'DB write failed: ' + e.message }, 500);
  }

  // record the inbound message in the thread (best-effort: wa_messages may be
  // unmigrated — the conversation row is still captured above)
  if (conversationId) {
    try {
      await insertMessage(env, { conversationId, chatId: msg.chatId, messageId: msg.messageId, direction: 'in', body: msg.text, senderName: msg.name, msgAt, now });
    } catch (_) { /* wa_messages not migrated yet */ }
    await linkEvent(env, eventId, conversationId);
  }

  // CTWA: one ctwa_conversions row per click; the first sight fires LeadSubmitted.
  // A returning contact who clicks a NEW ad gets a new row (new clid) even though
  // wa_conversations keeps its first-touch attribution.
  let ctwa = null;
  if (resolved.ctwaClid) {
    ctwa = await trackCtwa(context, { msg, clid: resolved.ctwaClid, conversationId, eventId, eventTime: msgAt });
  }

  return json({
    ok: true, chat_id: msg.chatId, platform: resolved.platform, link_method: resolved.linkMethod,
    event_id: eventId, ...(ctwa ? { ctwa_conversion_id: ctwa.conversionId, new_ctwa_click: ctwa.wasNew } : {}),
  });
}

// KROB "capture first": the whole uazapi payload goes to wa_webhook_events before
// any attribution work. Best-effort — a capture failure must never lose the
// message for the CRM, so it returns null instead of throwing.
async function captureEvent(env, payload, msg) {
  try {
    await ensureCtwaSchema(env);
    const ref = msg?.referral || null;
    const clid = ref && (ref.ctwa_clid || ref.ctwaClid || ref.clickId);
    const m = payload?.message || {};
    // an ad message that arrived WITHOUT a click id — what /rastreador "sem clid" lists
    const adHint = !clid && msg && !msg.fromMe
      && (!!ref || originFromText(msg.text)?.platform === 'meta') ? 1 : 0;
    const res = await env.DB.prepare(`
      INSERT INTO wa_webhook_events (
        received_at, event_type, instance_name, message_id, chat_id, sender_pn, sender_name,
        from_me, is_group, message_type, message_content, message_ts,
        ctwa_clid, entry_point_source, entry_point_app, ad_source_id, ad_source_url, ad_title,
        is_ctwa, ad_hint, raw_payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      Date.now(), payload?.EventType ?? null, payload?.instanceName ?? null,
      msg?.messageId ?? null, msg?.chatId || null, msg?.phone || null, msg?.name || null,
      msg?.fromMe ? 1 : 0, m.isGroup ? 1 : 0, m.messageType ?? m.type ?? null,
      msg?.text ? msg.text.slice(0, 2000) : null, msg?.msgAt ? msg.msgAt * 1000 : null,
      clid || null, ref?.entry_point ?? null, ref?.entry_point_app ?? null,
      ref?.source_id ?? null, ref?.source_url ?? null, ref?.title ?? null,
      clid ? 1 : 0, adHint, JSON.stringify(payload),
    ).run();
    return res.meta?.last_row_id ?? null;
  } catch (_) {
    return null;
  }
}

async function linkEvent(env, eventId, conversationId) {
  if (!eventId || !conversationId) return;
  try {
    await env.DB.prepare('UPDATE wa_webhook_events SET wa_conversation_id = ? WHERE id = ?')
      .bind(conversationId, eventId).run();
  } catch (_) { /* best-effort */ }
}

// Upsert the CTWA click and, if it's new, fire LeadSubmitted + enrich the ad name
// after the response. Never throws.
async function trackCtwa(context, { msg, clid, conversationId, eventId, eventTime }) {
  const { env } = context;
  try {
    const ref = msg.referral || {};
    const phone = normalizePhone(msg.phone, env.DEFAULT_COUNTRY_CODE);
    const adId = ref.source_id || ref.ad_id || null;
    const up = await upsertConversion(env, {
      ctwa_clid: clid, first_seen_at: Date.now(), webhook_event_id: eventId,
      wa_conversation_id: conversationId, sender_pn: phone, sender_name: msg.name || null,
      ad_id: adId, ad_source_url: ref.source_url || null, ad_title: ref.title || null,
      ad_body: ref.body || null, entry_point_app: ref.entry_point_app || null,
      entry_point_source: ref.entry_point || null,
    });
    if (up.wasNew && up.conversionId) {
      context.waitUntil(Promise.allSettled([
        fireLead(env, { conversionId: up.conversionId, ctwaClid: clid, adId, phone, eventTime }),
        enrichAdIfStale(env, adId),
      ]));
    }
    return up;
  } catch (_) {
    return null;
  }
}

// Insert one message into the thread. INSERT OR IGNORE dedups on wa_message_id
// (uazapi message id) so a webhook retry — or a reply we already stored locally
// from /api/send-message — doesn't double up.
async function insertMessage(env, m) {
  await env.DB.prepare(`
    INSERT OR IGNORE INTO wa_messages
      (conversation_id, wa_chat_id, wa_message_id, direction, body, status, sender_name, msg_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    m.conversationId, m.chatId, m.messageId || null, m.direction, m.body || '',
    m.direction === 'out' ? 'sent' : null, m.senderName || null, m.msgAt, m.now,
  ).run();
}

// Map uazapi's payload to our internal shape. Tuned for the uazapi (uazapiGO v2)
// "messages" event — that shape uses an all-lowercase `message` object with
// `chatid` / `sender` / `senderName` / `text` / `fromMe` / `messageType`, and the
// webhook envelope carries `EventType`. The reads below stay permissive (older
// camelCase / Baileys `key.remoteJid` shapes still resolve) so a wiring mistake
// degrades to 'unresolved' instead of dropping the message.
// CONFIRMED against real captured payloads on 2026-08-14 (including a real
// click-to-WhatsApp ad message) — see extractReferral() for the CTWA shape.
function normalise(p) {
  const m = p.message || p.data || p.messages?.[0] || p;
  if (!m) return null;
  // uazapi v2 nests the message body under `content` (an object: { text, contextInfo, ... }).
  const content = (m.content && typeof m.content === 'object') ? m.content : null;
  // uazapi v2 uses lowercase `chatid`; keep camelCase + Baileys fallbacks too
  const chatId = m.chatid || m.chatId || m.chat_id || m.from || m.key?.remoteJid || p.chatId || '';
  const text = m.text || content?.text || (typeof m.content === 'string' ? m.content : '')
    || m.body || m.caption || m.message?.conversation
    || m.message?.extendedTextMessage?.text || '';
  // The dialable phone lives in the @s.whatsapp.net / @c.us JID (chatid). uazapi
  // v2's `sender` is frequently the privacy @lid (a non-dialable WhatsApp id), so
  // prefer the JID user-part, then `sender_pn` (the phone-number JID uazapi sends
  // alongside the @lid), and only then fall back to sender/from.
  const phoneJid = /@(?:s\.whatsapp\.net|c\.us)$/i.test(chatId) ? chatId.split('@')[0] : '';
  const senderPn = /@(?:s\.whatsapp\.net|c\.us)$/i.test(m.sender_pn || '') ? String(m.sender_pn).split('@')[0] : '';
  const phone = String(phoneJid || senderPn || m.sender || m.from || m.author || '').replace(/[^0-9]/g, '');
  const name = m.senderName || m.pushName || m.notifyName || m.contact?.name || '';
  // skip our own / API-sent messages (uazapi: fromMe, wasSentByApi)
  const fromMe = !!(m.fromMe || m.fromme || m.wasSentByApi || m.key?.fromMe);
  const referral = extractReferral(m, content);
  // message id (dedup) and timestamp — permissive across uazapi v2 / Baileys shapes
  const messageId = m.id || m.messageid || m.messageId || m.key?.id || p.id || null;
  const tsRaw = m.messageTimestamp || m.messagetimestamp || m.messageTimestampMs || m.timestamp || m.t || null;
  let msgAt = null;
  if (tsRaw != null) {
    const n = Number(tsRaw);
    if (!Number.isNaN(n) && n > 0) msgAt = n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  }
  return {
    chatId,
    text: String(text || ''),
    phone,
    name,
    fromMe,
    messageId: messageId ? String(messageId) : null,
    msgAt,
    referral,
    referralRaw: referral ? JSON.stringify(referral) : null,
  };
}

// Pull the Click-to-WhatsApp ad data out of a uazapi message.
//
// CONFIRMED shape (real payloads + a 200 from Meta, 2026-08-14). uazapi carries it
// in the message's contextInfo — NOT in a `referral` object (that's the WhatsApp
// Cloud API shape, still accepted below as a fallback):
//
//   message.content.contextInfo = {
//     conversionSource: "FB_Ads",
//     conversionData / ctwaPayload: "<base64 blob>",    // NOT the clid — see below
//     entryPointConversionSource: "ctwa_ad",
//     entryPointConversionApp:    "instagram",
//     externalAdReply: {
//       title, body, mediaURL, thumbnail,
//       sourceID:  "<ad id>",
//       sourceURL: "<ad destination>",
//       ctwaClid:  "<THE CLICK ID>"     <-- ~138 chars, this is what Meta wants
//     }
//   }
//
// TRAP: `conversionData` base64-decodes to a plausible-looking ~426-char "Af…"
// string, but it is NOT the ctwa_clid — Meta rejects it. The real clid is
// `externalAdReply.ctwaClid`, and it sits AFTER the multi-KB base64 `thumbnail`,
// so it is easy to miss when eyeballing a truncated payload.
//
// We return a COMPACT object: the thumbnail must never reach referral_raw.
function extractReferral(m, content) {
  // WhatsApp Cloud API / older shapes first — if one carries a clid, trust it.
  const legacy = m.referral || m.message?.referral || null;
  if (legacy && (legacy.ctwa_clid || legacy.ctwaClid || legacy.clickId)) return legacy;

  const ctx = content?.contextInfo || m.contextInfo || m.message?.contextInfo || null;
  if (!ctx) return legacy;

  const ext = ctx.externalAdReply || null;
  // the clid lives INSIDE externalAdReply; fall back to the contextInfo top level
  // in case Meta ever surfaces it there.
  const clid = str(ext?.ctwaClid) || str(ctx.ctwaClid);
  if (!clid && !ext && !ctx.conversionSource) return legacy;

  return {
    ctwa_clid: clid,
    conversion_source: ctx.conversionSource || null,          // "FB_Ads"
    entry_point: ctx.entryPointConversionSource || null,      // "ctwa_ad"
    entry_point_app: ctx.entryPointConversionApp || null,     // "instagram" | "facebook"
    title: str(ext?.title),
    body: ext?.body ? String(ext.body).slice(0, 300) : null,
    source_url: str(ext?.sourceURL) || str(ext?.sourceUrl),
    source_id: str(ext?.sourceID) || str(ext?.sourceId),      // the ad id
    media_url: str(ext?.mediaURL) || str(ext?.mediaUrl),
    // kept for the record only — deliberately NOT used as the clid
    ctwa_payload_b64: str(ctx.ctwaPayload) || str(ctx.conversionData),
  };
}

function str(v) {
  if (v === undefined || v === null) return null;
  const s = String(v);
  return s.length ? s : null;
}

async function resolveAttribution(env, msg) {
  const base = {
    phone: msg.phone, name: msg.name, platform: 'unknown', linkMethod: 'unresolved',
    ctwaClid: null, sessionId: null, gclid: null, fbc: null, fbp: null,
    utmSource: null, utmMedium: null, utmCampaign: null, utmContent: null, utmTerm: null,
  };

  // 1) Meta CTWA referral
  const ref = msg.referral || null;
  const ctwa = ref && (ref.ctwa_clid || ref.ctwaClid || ref.clickId);
  if (ctwa) {
    return {
      ...base, platform: 'meta', linkMethod: 'ctwa', ctwaClid: ctwa,
      // tag it like the rest of the Meta traffic so resolveOrigin() and the
      // attribution table read the same way for CTWA and for LP-routed Meta.
      utmSource: 'meta-ads',
      utmMedium: ref.entry_point_app ? 'ctwa-' + ref.entry_point_app : 'ctwa',
      utmCampaign: ref.title || ref.headline || null,
      utmContent: ref.source_id || ref.ad_id || (ref.body ? String(ref.body).slice(0, 120) : null),
    };
  }

  // 2) Google/LP token: current "#xxxxxxxx" or legacy "(ref: xxxxxxxx)"
  const m = /(?:ref:\s*|#)([0-9a-fA-F]{8})/.exec(msg.text || '');
  if (m && env.DB) {
    const prefix = m[1].toLowerCase();
    try {
      const s = await env.DB.prepare(
        `SELECT session_id, gclid, fbc, fbp, utm_source, utm_medium, utm_campaign, utm_content, utm_term
         FROM sessions WHERE lower(replace(session_id,'-','')) LIKE ? LIMIT 1`
      ).bind(prefix + '%').first();
      if (s) {
        return {
          ...base, platform: s.utm_source === 'meta-ads' ? 'meta' : (s.utm_source === 'google-ads' || s.gclid ? 'google' : 'organic'),
          linkMethod: 'token', sessionId: s.session_id, gclid: s.gclid, fbc: s.fbc, fbp: s.fbp,
          utmSource: s.utm_source, utmMedium: s.utm_medium, utmCampaign: s.utm_campaign, utmContent: s.utm_content, utmTerm: s.utm_term,
        };
      }
    } catch (_) { /* fall through to unresolved */ }
  }

  // 3) pre-filled text (CTWA default greeting without ad context, bio links)
  const byText = originFromText(msg.text);
  if (byText) return { ...base, ...byText };

  return base;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
