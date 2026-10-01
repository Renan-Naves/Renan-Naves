// functions/lib/ctwa-capi.js
//
// CTWA tracker — Meta Conversions API for Business Messaging, ported from the
// KROB WhatsApp stack (krob-whats-stack v0.2, lib/capi.js) and wired to this
// repo's existing env vars:
//
//   KROB                     → here
//   META_DATASET_ID          → META_WA_PIXEL_ID     (the MESSAGING dataset, "Pixel WhatsApp")
//   META_SYSTEM_USER_TOKEN   → META_WA_ACCESS_TOKEN
//   META_PAGE_ID             → META_WA_PAGE_ID      (user_data.page_id — proven 2026-08-14)
//   META_TEST_EVENT_CODE     → META_WA_TEST_EVENT_CODE (keep UNSET in production)
//   Marketing API enrichment → META_ADS_ACCESS_TOKEN, falling back to META_WA_ACCESS_TOKEN
//
// Lifecycle per CTWA click (row in ctwa_conversions, keyed by ctwa_clid):
//   LeadSubmitted  → fired automatically by the uazapi webhook on the first message
//   QualifiedLead  → manual (dashboard / rastreador) or an auto-fire rule
//   Purchase       → manual (dashboard / rastreador) or an auto-fire rule
// Each fire: build → (send → log to ctwa_capi_log) × up to 5 with backoff → update row.
// Never throws on missing creds: the row records 'skipped_no_creds'.

const GRAPH_VERSION = 'v25.0';
const PARTNER_AGENT = 'krob-whatsapp-tracker/0.2-renan';
const AD_CACHE_TTL_MS = 7 * 24 * 3600_000;
const CTWA_WINDOW_MS = 7 * 24 * 3600_000; // Meta attributes a CTWA event up to 7 days after the click

const INLINE_ATTEMPTS = 5;
const INLINE_BACKOFF_MS = [1500, 4000, 10000, 20000];

// ---------- helpers -------------------------------------------------------

// Digits with country code, mirroring meta-conversions.js / tracker.js.
export function normalizePhone(ph, countryCode = '55') {
  if (!ph) return null;
  const cc = String(countryCode || '55');
  const digits = String(ph).split('@')[0].replace(/\D/g, '').replace(/^0+/, '');
  if (!digits) return null;
  if (digits.startsWith(cc) && digits.length >= cc.length + 8 && digits.length <= cc.length + 11) return digits;
  if (digits.length >= 8 && digits.length <= 11) return cc + digits;
  return digits;
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s).toLowerCase().trim()));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function creds(env) {
  return {
    datasetId: env.META_WA_PIXEL_ID || null,
    token: env.META_WA_ACCESS_TOKEN || null,
    pageId: env.META_WA_PAGE_ID || null,
    testCode: env.META_WA_TEST_EVENT_CODE || null,
    currency: env.META_CURRENCY || 'BRL',
  };
}

export function isWithinCtwaWindow(firstSeenAtMs) {
  return Date.now() - Number(firstSeenAtMs || 0) < CTWA_WINDOW_MS;
}

// ---------- event builders ------------------------------------------------

async function baseEvent(env, { eventName, eventId, ctwaClid, phone, eventTime }) {
  const c = creds(env);
  const userData = { ctwa_clid: ctwaClid };
  if (c.pageId) userData.page_id = String(c.pageId);
  if (phone) userData.ph = [await sha256Hex(phone)];
  return {
    event_name: eventName,
    event_time: eventTime || Math.floor(Date.now() / 1000),
    event_id: eventId,
    action_source: 'business_messaging',
    messaging_channel: 'whatsapp',
    user_data: userData,
  };
}

function wrap(env, event) {
  const body = { data: [event], partner_agent: PARTNER_AGENT };
  const { testCode } = creds(env);
  if (testCode) body.test_event_code = testCode;
  return body;
}

export async function buildLeadEvent(env, { ctwaClid, adId, phone, eventTime }) {
  // business_messaging lead event: LeadSubmitted (Meta rejects plain 'Lead').
  const ev = await baseEvent(env, { eventName: env.META_LEAD_EVENT_NAME || 'LeadSubmitted', eventId: ctwaClid, ctwaClid, phone, eventTime });
  ev.custom_data = { currency: creds(env).currency, value: 0, ...(adId ? { ad_id: adId } : {}) };
  return wrap(env, ev);
}

export async function buildQualifiedLeadEvent(env, { ctwaClid, adId, phone, eventTime }) {
  const ev = await baseEvent(env, { eventName: 'QualifiedLead', eventId: `${ctwaClid}:qualified`, ctwaClid, phone, eventTime });
  if (adId) ev.custom_data = { ad_id: adId };
  return wrap(env, ev);
}

export async function buildPurchaseEvent(env, { ctwaClid, phone, value, currency, orderId, eventTime }) {
  const ev = await baseEvent(env, {
    eventName: 'Purchase', eventId: `${ctwaClid}:purchase${orderId ? ':' + orderId : ''}`, ctwaClid, phone, eventTime,
  });
  ev.custom_data = { currency: currency || creds(env).currency, value };
  return wrap(env, ev);
}

// ---------- HTTP to Meta --------------------------------------------------

export async function sendCapiEvent(env, body) {
  const t0 = Date.now();
  const { datasetId, token } = creds(env);
  if (!datasetId || !token) {
    const missing = [!datasetId && 'META_WA_PIXEL_ID', !token && 'META_WA_ACCESS_TOKEN'].filter(Boolean).join(',');
    return { ok: false, status: 0, body: `skipped: missing ${missing}`, duration_ms: 0 };
  }
  try {
    const resp = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(datasetId)}/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    return { ok: resp.ok, status: resp.status, body: text, duration_ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, status: 0, body: `fetch_error: ${err?.message ?? err}`, duration_ms: Date.now() - t0 };
  }
}

// ---------- Marketing API enrichment --------------------------------------

export async function enrichAd(env, adId) {
  const token = env.META_ADS_ACCESS_TOKEN || env.META_WA_ACCESS_TOKEN;
  if (!token) return { ok: false, status: 0, body: 'skipped: missing META_ADS_ACCESS_TOKEN' };
  const fields = 'name,effective_status,adset{id,name},campaign{id,name,objective}';
  let resp, text;
  try {
    resp = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(adId)}?fields=${encodeURIComponent(fields)}`,
      { headers: { authorization: `Bearer ${token}` } });
    text = await resp.text();
  } catch (err) {
    return { ok: false, status: 0, body: `fetch_error: ${err?.message ?? err}` };
  }
  if (!resp.ok) return { ok: false, status: resp.status, body: text };
  let p;
  try { p = JSON.parse(text); } catch { return { ok: false, status: resp.status, body: `parse_error: ${text}` }; }
  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO meta_ads_cache (ad_id, fetched_at, expires_at, ad_name, adset_id, adset_name, campaign_id, campaign_name, campaign_objective, effective_status, raw_response)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ad_id) DO UPDATE SET
      fetched_at=excluded.fetched_at, expires_at=excluded.expires_at, ad_name=excluded.ad_name,
      adset_id=excluded.adset_id, adset_name=excluded.adset_name, campaign_id=excluded.campaign_id,
      campaign_name=excluded.campaign_name, campaign_objective=excluded.campaign_objective,
      effective_status=excluded.effective_status, raw_response=excluded.raw_response
  `).bind(adId, now, now + AD_CACHE_TTL_MS, p.name ?? null, p.adset?.id ?? null, p.adset?.name ?? null,
    p.campaign?.id ?? null, p.campaign?.name ?? null, p.campaign?.objective ?? null, p.effective_status ?? null, text).run();
  return { ok: true, status: resp.status, body: text };
}

export async function enrichAdIfStale(env, adId) {
  if (!adId) return { ok: false, body: 'no_ad_id' };
  const cached = await env.DB.prepare('SELECT expires_at FROM meta_ads_cache WHERE ad_id = ?').bind(adId).first();
  if (cached && cached.expires_at > Date.now()) return { ok: true, cached: true };
  return enrichAd(env, adId);
}

// ---------- D1 helpers ----------------------------------------------------

// Idempotent upsert keyed by ctwa_clid. Returns { wasNew, conversionId }.
export async function upsertConversion(env, f) {
  const insert = await env.DB.prepare(`
    INSERT OR IGNORE INTO ctwa_conversions (
      ctwa_clid, first_seen_at, webhook_event_id, wa_conversation_id, sender_pn, sender_name,
      ad_id, ad_source_url, ad_title, ad_body, entry_point_app, entry_point_source, lead_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    f.ctwa_clid, f.first_seen_at ?? Date.now(), f.webhook_event_id ?? null, f.wa_conversation_id ?? null,
    f.sender_pn ?? null, f.sender_name ?? null, f.ad_id ?? null, f.ad_source_url ?? null,
    f.ad_title ?? null, f.ad_body ?? null, f.entry_point_app ?? null, f.entry_point_source ?? null,
    f.lead_status || 'pending',
  ).run();
  const wasNew = (insert.meta?.changes ?? 0) > 0;
  if (!wasNew && f.wa_conversation_id) {
    await env.DB.prepare('UPDATE ctwa_conversions SET wa_conversation_id = COALESCE(wa_conversation_id, ?) WHERE ctwa_clid = ?')
      .bind(f.wa_conversation_id, f.ctwa_clid).run();
  }
  const row = await env.DB.prepare('SELECT id FROM ctwa_conversions WHERE ctwa_clid = ?').bind(f.ctwa_clid).first();
  return { wasNew, conversionId: row?.id ?? null };
}

// The ctwa_conversions row for a wa_conversations row (created from its clid if
// missing — e.g. a conversation captured before the tracker existed).
export async function conversionForWaConversation(env, conv) {
  if (!conv?.ctwa_clid) return null;
  let row = await env.DB.prepare('SELECT * FROM ctwa_conversions WHERE ctwa_clid = ?').bind(conv.ctwa_clid).first();
  if (!row) {
    const firstSeen = (conv.first_message_at || conv.created_at || Math.floor(Date.now() / 1000)) * 1000;
    await upsertConversion(env, {
      ctwa_clid: conv.ctwa_clid, first_seen_at: firstSeen, wa_conversation_id: conv.id,
      sender_pn: normalizePhone(conv.wa_phone, env.DEFAULT_COUNTRY_CODE), sender_name: conv.wa_contact_name,
      ad_id: /^\d+$/.test(String(conv.utm_content || '')) ? conv.utm_content : null,
      ad_title: conv.utm_campaign || null,
      // a click older than the attribution window can't take a Lead anymore
      lead_status: isWithinCtwaWindow(firstSeen) ? 'pending' : 'expired',
    });
    row = await env.DB.prepare('SELECT * FROM ctwa_conversions WHERE ctwa_clid = ?').bind(conv.ctwa_clid).first();
  }
  return row;
}

async function logCapiAttempt(env, { conversionId, eventName, eventId, requestBody, response }) {
  await env.DB.prepare(`
    INSERT INTO ctwa_capi_log (conversion_id, attempted_at, event_name, event_id, request_body,
      response_status, response_body, duration_ms, was_test)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(conversionId ?? null, Date.now(), eventName, eventId ?? null,
    requestBody ? JSON.stringify(requestBody) : null, response.status ?? null,
    response.body ?? null, response.duration_ms ?? null, requestBody?.test_event_code ? 1 : 0).run();
}

function isRetryable(r) {
  if (r.status === 0) return !String(r.body || '').startsWith('skipped:');
  return r.status === 429 || r.status >= 500;
}

// Shared fire loop. `prefix` is the column family: lead | qualified_lead | purchase.
// The column names come from this fixed set, never from input.
const PREFIXES = new Set(['lead', 'qualified_lead', 'purchase']);

async function fireWithRetry(env, { conversionId, prefix, body, extraSentSets = '', extraSentBinds = [] }) {
  if (!PREFIXES.has(prefix)) throw new Error('bad prefix');
  const eventName = body.data[0].event_name;
  const eventId = body.data[0].event_id;
  await env.DB.prepare(`UPDATE ctwa_conversions SET ${prefix}_status='sending' WHERE id = ?`).bind(conversionId).run();

  let response;
  let attempts = 0;
  while (attempts < INLINE_ATTEMPTS) {
    if (attempts > 0) await sleep(INLINE_BACKOFF_MS[Math.min(attempts - 1, INLINE_BACKOFF_MS.length - 1)]);
    response = await sendCapiEvent(env, body);
    attempts++;
    await logCapiAttempt(env, { conversionId, eventName, eventId, requestBody: body, response });

    if (response.ok) {
      await env.DB.prepare(`
        UPDATE ctwa_conversions
           SET ${prefix}_status='sent', ${prefix}_event_id=?, ${prefix}_sent_at=?,
               ${prefix}_attempts=${prefix}_attempts+?, ${prefix}_last_error=NULL ${extraSentSets}
         WHERE id = ?`).bind(eventId, Date.now(), attempts, ...extraSentBinds, conversionId).run();
      return { status: 'sent', attempts, response };
    }
    if (response.status === 0 && String(response.body).startsWith('skipped:')) {
      await env.DB.prepare(`UPDATE ctwa_conversions SET ${prefix}_status='skipped_no_creds',
        ${prefix}_attempts=${prefix}_attempts+?, ${prefix}_last_error=? WHERE id = ?`)
        .bind(attempts, response.body, conversionId).run();
      return { status: 'skipped_no_creds', attempts, response };
    }
    if (!isRetryable(response)) break; // 4xx won't fix itself
  }
  await env.DB.prepare(`UPDATE ctwa_conversions SET ${prefix}_status='failed',
    ${prefix}_attempts=${prefix}_attempts+?, ${prefix}_last_error=? WHERE id = ?`)
    .bind(attempts, String(response?.body || '').slice(0, 500), conversionId).run();
  return { status: 'failed', attempts, response };
}

export async function fireLead(env, { conversionId, ctwaClid, adId, phone, eventTime }) {
  const body = await buildLeadEvent(env, { ctwaClid, adId, phone, eventTime });
  return fireWithRetry(env, { conversionId, prefix: 'lead', body });
}

export async function fireQualifiedLead(env, { conversionId, ctwaClid, adId, phone, eventTime }) {
  const body = await buildQualifiedLeadEvent(env, { ctwaClid, adId, phone, eventTime });
  return fireWithRetry(env, { conversionId, prefix: 'qualified_lead', body });
}

export async function firePurchase(env, { conversionId, ctwaClid, phone, value, currency, orderId, eventTime }) {
  const cur = currency || creds(env).currency;
  const body = await buildPurchaseEvent(env, { ctwaClid, phone, value, currency: cur, orderId, eventTime });
  return fireWithRetry(env, {
    conversionId, prefix: 'purchase', body,
    extraSentSets: ', purchase_value=?, purchase_currency=?', extraSentBinds: [value, cur],
  });
}

// Mirror a QualifiedLead / Purchase fired from the rastreador or an auto rule onto
// the dashboard's wa_conversations funnel (the same columns /api/mark-conversion
// sets), so both screens agree. Never downgrades a sale back to qualified.
export async function syncFunnel(env, waConversationId, { kind, valueCents, currency, markedBy }) {
  if (!waConversationId) return;
  const now = Math.floor(Date.now() / 1000);
  if (kind === 'qualified') {
    await env.DB.prepare(`
      UPDATE wa_conversations
         SET status = CASE WHEN status = 'sale' THEN 'sale' ELSE 'qualified' END,
             is_qualified = 1, qualified_at = COALESCE(qualified_at, ?), marked_by = ?, updated_at = ?
       WHERE id = ?`).bind(now, markedBy, now, waConversationId).run();
  } else if (kind === 'sale') {
    await env.DB.prepare(`
      UPDATE wa_conversations
         SET status = 'sale', is_qualified = 1, sale_value_cents = ?, sale_currency = ?,
             qualified_at = COALESCE(qualified_at, ?), sale_at = ?, marked_by = ?, updated_at = ?
       WHERE id = ?`).bind(valueCents, currency || 'BRL', now, now, markedBy, now, waConversationId).run();
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
