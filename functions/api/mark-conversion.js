// POST /api/mark-conversion?key=...
//
// The manual marking flow: the attendant flags a WhatsApp conversation as
// QualifiedLead, Sale (with value) or Lost. Updates wa_conversations and, for
// qualified/sale, fires an offline conversion back to the ORIGIN platform:
//   Meta   (CTWA) → Meta CAPI business_messaging, keyed by ctwa_clid
//   Google (LP)   → Google Ads Data Manager, keyed by gclid
//
// The dashboard asks the attendant to CONFIRM before calling this (especially
// QualifiedLead); the server additionally requires `confirm:true` as a guard.
//
// Idempotent: a conversation won't re-fire the same event to the same platform
// once it has an ok row in conversion_fires.
//
// Body: { conversation_id, action: 'qualified'|'sale'|'lost'|'reset',
//         value?, confirm: true, marked_by? }
//
// Auth: ?key=<DASH_KEY>.

import { sendGoogleOfflineConversion } from '../google-ads.js';
import { sendMetaMessagingConversion } from '../meta-conversions.js';
import { isValidOrigin } from '../origins.js';

const ACTIONS = ['qualified', 'sale', 'lost', 'reset', 'origin', 'archive', 'unarchive', 'delete'];

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
  const action = String(body.action || '').toLowerCase();
  if (!conversationId || !ACTIONS.includes(action)) {
    return json({ error: 'conversation_id and a valid action are required' }, 400);
  }

  // --- manual origin tagging (Indicação / Remarketing / override) ---
  // No funnel change, no conversion fire — just sets/clears manual_origin.
  if (action === 'origin') {
    const origin = String(body.origin || '').trim();
    if (origin && !isValidOrigin(origin)) return json({ error: 'invalid origin' }, 400);
    // Optional referral fields — set ONLY when the key is present in the body
    // (so a plain origin change doesn't wipe them). Column names are a fixed
    // allowlist (not user input), so interpolating them into SET is safe.
    const optional = {
      referral_name: v => String(v || '').trim().slice(0, 120) || null,        // indicado (novo paciente) clean name
      referral_by_name: v => String(v || '').trim().slice(0, 120) || null,      // indicador (quem indicou) name
      referral_by_phone: v => String(v || '').replace(/\D/g, '').slice(0, 20) || null, // indicador WhatsApp (digits)
    };
    const sets = ['manual_origin = ?'];
    const binds = [origin || null];
    for (const [col, clean] of Object.entries(optional)) {
      if (Object.prototype.hasOwnProperty.call(body, col)) { sets.push(`${col} = ?`); binds.push(clean(body[col])); }
    }
    sets.push('updated_at = ?'); binds.push(Math.floor(Date.now() / 1000));
    binds.push(conversationId);
    try {
      const res = await env.DB.prepare(`UPDATE wa_conversations SET ${sets.join(', ')} WHERE id = ?`)
        .bind(...binds).run();
      if (!res.meta || res.meta.changes === 0) return json({ error: 'conversation not found' }, 404);
    } catch (_) {
      return json({ error: 'wa_conversations not migrated yet' }, 503);
    }
    return json({ ok: true, conversation_id: conversationId, manual_origin: origin || null });
  }

  // --- lifecycle: archive / unarchive / soft-delete ---
  // No funnel change, no conversion fire — just sets/clears archived_at / deleted_at.
  // 'delete' is a SOFT delete (attribution + audit preserved) and requires confirm:true.
  if (action === 'archive' || action === 'unarchive' || action === 'delete') {
    if (action === 'delete' && body.confirm !== true) {
      return json({ error: 'confirmation required (confirm:true)' }, 400);
    }
    const nowTs = Math.floor(Date.now() / 1000);
    const col = action === 'delete' ? 'deleted_at' : 'archived_at';
    const val = action === 'unarchive' ? null : nowTs;
    try {
      const res = await env.DB.prepare(
        `UPDATE wa_conversations SET ${col} = ?, updated_at = ? WHERE id = ?`
      ).bind(val, nowTs, conversationId).run();
      if (!res.meta || res.meta.changes === 0) return json({ error: 'conversation not found' }, 404);
    } catch (_) {
      return json({ error: 'wa_conversations not migrated yet (apply migration 0023)' }, 503);
    }
    return json({ ok: true, conversation_id: conversationId, action });
  }

  if ((action === 'qualified' || action === 'sale') && body.confirm !== true) {
    return json({ error: 'confirmation required (confirm:true)' }, 400);
  }

  const valueCents = action === 'sale' ? toCents(body.value) : null;
  if (action === 'sale' && (valueCents == null || valueCents <= 0)) {
    return json({ error: 'a positive sale value is required' }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const markedBy = String(body.marked_by || 'atendente').slice(0, 80);

  // --- load conversation ---
  let conv;
  try {
    conv = await env.DB.prepare('SELECT * FROM wa_conversations WHERE id = ?').bind(conversationId).first();
  } catch (_) {
    return json({ error: 'wa_conversations not migrated yet — apply migration 0018 first' }, 503);
  }
  if (!conv) return json({ error: 'conversation not found' }, 404);

  // --- update status on the conversation ---
  const updates = applyAction(action, valueCents, conv, now, markedBy);
  await env.DB.prepare(`
    UPDATE wa_conversations
       SET status = ?, is_qualified = ?, sale_value_cents = ?, sale_currency = ?,
           qualified_at = ?, sale_at = ?, marked_by = ?, updated_at = ?
     WHERE id = ?
  `).bind(
    updates.status, updates.is_qualified, updates.sale_value_cents, updates.sale_currency,
    updates.qualified_at, updates.sale_at, markedBy, now, conversationId,
  ).run();

  // --- fire conversion (qualified/sale only) ---
  let fire = { skipped: 'no fire for this action' };
  if (action === 'qualified' || action === 'sale') {
    const eventName = action === 'sale' ? 'Purchase' : 'QualifiedLead';
    fire = await fireConversion({ env, conv, eventName, valueCents, now });
  }

  return json({ ok: true, conversation_id: conversationId, status: updates.status, fire });
}

// Decide the new column values for each action.
function applyAction(action, valueCents, conv, now, _markedBy) {
  const base = {
    status: conv.status, is_qualified: conv.is_qualified ? 1 : 0,
    sale_value_cents: conv.sale_value_cents ?? null, sale_currency: conv.sale_currency || 'BRL',
    qualified_at: conv.qualified_at ?? null, sale_at: conv.sale_at ?? null,
  };
  if (action === 'qualified') {
    return { ...base, status: conv.status === 'sale' ? 'sale' : 'qualified', is_qualified: 1,
      qualified_at: conv.qualified_at || now };
  }
  if (action === 'sale') {
    return { ...base, status: 'sale', is_qualified: 1, sale_value_cents: valueCents,
      qualified_at: conv.qualified_at || now, sale_at: now };
  }
  if (action === 'lost') return { ...base, status: 'lost' };
  // reset
  return { status: 'new', is_qualified: 0, sale_value_cents: null, sale_currency: 'BRL',
    qualified_at: null, sale_at: null };
}

async function fireConversion({ env, conv, eventName, valueCents, now }) {
  const platform = conv.platform === 'meta' ? 'meta' : conv.platform === 'google' ? 'google' : null;
  if (!platform) return { skipped: `unresolved platform (${conv.platform || 'unknown'})` };

  // idempotency: already fired ok?
  try {
    const existing = await env.DB.prepare(`
      SELECT id FROM conversion_fires
      WHERE conversation_id = ? AND event_name = ? AND platform = ? AND response_ok = 1 LIMIT 1
    `).bind(conv.id, eventName, platform).first();
    if (existing) return { skipped: 'already fired' };
  } catch (_) { /* conversion_fires not migrated → proceed best-effort */ }

  const eventId = `conv-${conv.id}-${eventName.toLowerCase()}`;
  let result, clickId = null, clickIdType = null;

  if (platform === 'google') {
    const gclid = await resolveGclid(env, conv);
    clickId = gclid; clickIdType = 'gclid';
    const conversionActionId = eventName === 'Purchase'
      ? env.GOOGLE_ADS_PURCHASE_CONVERSION_ACTION_ID
      : env.GOOGLE_ADS_QUALIFIED_CONVERSION_ACTION_ID;
    result = await sendGoogleOfflineConversion({
      env, conversionActionId, gclid, valueCents, currency: conv.sale_currency || 'BRL',
      eventTime: now, transactionId: eventId, phone: conv.wa_phone,
    });
  } else {
    clickId = conv.ctwa_clid; clickIdType = 'ctwa_clid';
    result = await sendMetaMessagingConversion({
      env, eventName, ctwaClid: conv.ctwa_clid, phone: conv.wa_phone,
      valueCents, currency: conv.sale_currency || 'BRL', eventId, eventTime: now,
    });
  }

  // audit (best-effort)
  try {
    await env.DB.prepare(`
      INSERT INTO conversion_fires
        (conversation_id, event_name, platform, click_id, click_id_type, value_cents, currency,
         event_id, status_code, response_ok, response_body, fired_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      conv.id, eventName, platform, clickId, clickIdType, valueCents ?? null,
      conv.sale_currency || 'BRL', eventId,
      result.response?.status ?? null, result.response?.ok ? 1 : 0,
      result.skipped ? `skipped: ${result.skipped}` : (result.body || '').slice(0, 1000), now,
    ).run();
  } catch (_) { /* ignore audit failure */ }

  return result.skipped
    ? { fired: false, platform, reason: result.skipped }
    : { fired: result.response?.ok || false, platform, status: result.response?.status };
}

// Prefer the gclid stored on the conversation; fall back to the linked session.
async function resolveGclid(env, conv) {
  if (conv.gclid) return conv.gclid;
  if (conv.session_id) {
    try {
      const s = await env.DB.prepare('SELECT gclid FROM sessions WHERE session_id = ?')
        .bind(conv.session_id).first();
      if (s && s.gclid) return s.gclid;
    } catch (_) { /* ignore */ }
  }
  return '';
}

function toCents(v) {
  const n = Number(v);
  if (Number.isNaN(n)) return null;
  return Math.round(n * 100);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
