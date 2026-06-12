// -----------------------------------------------------------------------------
// Webhook core — platform-agnostic purchase processing (Meta CAPI only).
//
// Each sales platform (Hotmart in this repo) has its own thin adapter file.
// The adapter is responsible for:
//   1. Reading the raw request body.
//   2. Guarding the URL slug via _utils.guardSlug.
//   3. Parsing the platform's payload shape into the normalized purchase
//      object described below.
//   4. Calling processPurchase() with that normalized object.
//
// Everything else — D1 lookup of the originating checkout_session, Meta CAPI
// fire, purchase_log + purchase_items persistence — lives in this file and is
// identical across platforms.
//
// Normalized purchase object (what each adapter must produce):
//
//   {
//     platform:      'hotmart' | string,
//     trk:           string,   // unique identifier threaded from page visit
//     email:         string,
//     name:          string,
//     phone:         string,
//     value:         number,
//     currency:      string,   // ISO code, e.g. 'BRL', 'USD'
//     transactionId: string,
//     productId:     string,
//     productName:   string,
//     items:         Array<{ productId, name, price: { value, currency } }>,
//     platformUtm:   { utm_source, utm_medium, utm_campaign, utm_content, utm_term },
//   }
//
// Simplified port of gustavokrob/krob-tracking-stack (functions/webhook/_core.js).
// The source fans out to Meta + GA4 + Google Ads + Encharge + ManyChat; this
// repo runs Meta-only (CLAUDE.md: "GA4 is off. Meta only."). The DB columns
// for the absent integrations exist (migrations 0004 / 0006 / 0007) and are
// written as empty/zero — easy to backfill later by adding handlers.
// -----------------------------------------------------------------------------

export async function processPurchase({ parsed, env, context }) {
  // Look up the originating checkout session (fbp, fbc, UTMs, ip, user_agent,
  // event_source_url, etc. — everything the sales page persisted before the
  // visitor left for pay.hotmart.com).
  let checkoutData = {};
  if (parsed.trk && env.DB) {
    try {
      const row = await env.DB.prepare(
        'SELECT * FROM checkout_sessions WHERE trk = ?'
      ).bind(parsed.trk).first();
      if (row) checkoutData = row;
    } catch (e) {
      console.error('D1 checkout lookup error:', e.message);
    }
  }

  const enriched = { ...parsed, checkoutData };
  const eventId = crypto.randomUUID();
  const eventTime = Math.floor(Date.now() / 1000);

  // Tracking handler only runs when we recovered the checkout snapshot —
  // without fbp/fbc the Meta event has weaker matching anyway, and the lookup
  // miss usually means the buyer never hit the sales page (e.g. direct Hotmart
  // affiliate link). Still log the purchase row so /dash sees the sale.
  let trackingResult = {};
  if (parsed.trk && checkoutData.trk) {
    try {
      trackingResult = await handleTracking({ parsed: enriched, eventId, eventTime, env });
    } catch (e) {
      console.error('Tracking handler error:', e.message);
      trackingResult = { error: e.message };
    }
  }

  // purchase_log + purchase_items run in the background so the webhook
  // response isn't blocked. Hotmart treats slow responses as failed and
  // retries — keep the foreground path short.
  context.waitUntil(
    handlePurchaseLog({ parsed: enriched, eventId, eventTime, trackingResult, env })
  );

  return { eventId };
}

// -----------------------------------------------------------------------------
// TRACKING — Meta CAPI Purchase (needs checkoutData for fbp/fbc/ip/ua)
// -----------------------------------------------------------------------------
async function handleTracking({ parsed, eventId, eventTime, env }) {
  const { email, name, phone, value, currency, productName, items, productId, checkoutData } = parsed;

  const hashedEm = await sha256(email);
  const nameParts = splitName(name);
  const hashedFn = await sha256(normalizeName(nameParts.fn));
  const hashedLn = await sha256(normalizeName(nameParts.ln));
  const hashedPh = await sha256(normalizePhone(phone, env.DEFAULT_COUNTRY_CODE));
  const hashedExternalId = await sha256(checkoutData.external_id || '');

  // Build the contents list both Meta consumes. Adapters should always ship
  // items[]; if one slips through empty we synthesize a single-item fallback
  // from the top-level product fields so `contents` / `content_ids` stay
  // non-empty for catalog attribution.
  const itemList = (Array.isArray(items) && items.length)
    ? items
    : [{ productId: productId || '', name: productName || '', price: { value, currency } }];
  const contents = itemList.map(it => ({
    id: String(it.productId || ''),
    quantity: parseInt(it.quantity, 10) || 1,
    item_price: parseFloat(it?.price?.value) || 0,
  }));

  const metaResult = await sendToMeta({
    checkoutData, hashedEm, hashedFn, hashedLn, hashedPh, hashedExternalId,
    eventId, eventTime, value, currency, productName, contents, env,
  }).catch(e => ({ error: e.message, payload: null, response: null }));

  let metaStatusCode = 0, metaResponseOk = 0, metaResponseBody = '', metaPayloadSent = null;
  if (metaResult) {
    metaPayloadSent = metaResult.payload;
    if (metaResult.skipped) {
      metaResponseBody = `skipped: ${metaResult.skipped}`;
    } else if (metaResult.error) {
      metaResponseBody = `Fetch error: ${metaResult.error}`;
    } else if (metaResult.response) {
      metaStatusCode = metaResult.response.status;
      metaResponseOk = metaResult.response.ok ? 1 : 0;
      try { metaResponseBody = await metaResult.response.text(); }
      catch (e) { metaResponseBody = `Read error: ${e.message}`; }
    }
  }

  return {
    metaStatusCode, metaResponseOk, metaResponseBody, metaPayloadSent,
    hashedEm, hashedFn, hashedLn, hashedPh, hashedExternalId,
  };
}

// -----------------------------------------------------------------------------
// PURCHASE_LOG — D1 insert (always runs, background via waitUntil)
//
// Encharge / ManyChat / GA4 / Google Ads columns are present in the schema
// (migrations 0004 / 0006 / 0007) but get zero/empty values here — those
// integrations aren't wired in this repo.
// -----------------------------------------------------------------------------
async function handlePurchaseLog({ parsed, eventId, eventTime, trackingResult, env }) {
  if (!env.DB) return;

  const { trk, email, name, phone, value, currency, transactionId, productId, productName, checkoutData, platformUtm, items } = parsed;
  const t = trackingResult || {};

  const createdAt = Math.floor(Date.now() / 1000);
  let purchaseId = null;

  try {
    const result = await env.DB.prepare(`
      INSERT INTO purchase_log (
        trk, event_id, event_time,
        raw_email, raw_name, raw_phone,
        hashed_em, hashed_fn, hashed_ln, hashed_ph, hashed_external_id,
        client_ip_address, client_user_agent, fbp, fbc,
        value, currency, transaction_id,
        event_source_url,
        meta_status_code, meta_response_ok, meta_response_body, meta_payload_sent,
        ga4_status_code, ga4_response_ok, ga4_response_body, ga4_payload_sent,
        google_ads_status_code, google_ads_response_ok, google_ads_response_body, google_ads_payload_sent,
        gclid, gbraid, wbraid,
        utm_source, utm_medium, utm_campaign, utm_content, utm_term,
        product_id, product_name,
        encharge_status_code, encharge_response_ok, encharge_response_body,
        manychat_status_code, manychat_response_ok, manychat_response_body,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      trk || '', eventId, eventTime,
      email, name, phone,
      t.hashedEm || '', t.hashedFn || '', t.hashedLn || '',
      t.hashedPh || '', t.hashedExternalId || '',
      checkoutData.ip_address || '', checkoutData.user_agent || '',
      checkoutData.fbp || '', checkoutData.fbc || '',
      parseFloat(value) || 0, currency, transactionId,
      checkoutData.event_source_url || '',
      t.metaStatusCode || 0, t.metaResponseOk || 0, t.metaResponseBody || '', t.metaPayloadSent ?? null,
      // GA4 — not wired in this repo (CLAUDE.md: "GA4 is off. Meta only.")
      0, 0, '', null,
      // Google Ads — not wired in this repo
      0, 0, '', null,
      checkoutData.gclid || '', checkoutData.gbraid || '', checkoutData.wbraid || '',
      // UTMs prefer what the sales platform echoes back in the webhook
      // (platformUtm, authoritative when present), then fall back to the
      // sales-page snapshot in checkout_sessions. Hotmart doesn't carry UTMs
      // natively — the adapter recovers them from the sck pipe-bundle.
      platformUtm.utm_source || checkoutData.utm_source || '',
      platformUtm.utm_medium || checkoutData.utm_medium || '',
      platformUtm.utm_campaign || checkoutData.utm_campaign || '',
      platformUtm.utm_content || checkoutData.utm_content || '',
      platformUtm.utm_term || checkoutData.utm_term || '',
      productId || '', productName || '',
      // Encharge — not wired
      0, 0, '',
      // ManyChat — not wired
      0, 0, '',
      createdAt
    ).run();

    purchaseId = result.meta?.last_row_id ?? null;
  } catch (e) {
    // UNIQUE constraint on transaction_id (migration 0012) means a Hotmart
    // retry storm for the same purchase no-ops here — desired.
    console.error('D1 purchase_log error:', e.message);
    return;
  }

  if (purchaseId == null) {
    console.error('D1 purchase_log: no last_row_id, skipping purchase_items insert', { transactionId });
    return;
  }

  const itemList = Array.isArray(items) ? items : [];
  if (itemList.length === 0) return;

  try {
    const itemStmt = env.DB.prepare(`
      INSERT INTO purchase_items (
        purchase_id, transaction_id, product_id, product_name,
        value, currency, created_at,
        utm_source, utm_campaign, utm_medium, utm_content, utm_term
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const batch = itemList.map(item => itemStmt.bind(
      purchaseId,
      transactionId || null,
      String(item.productId || ''),
      item.name || null,
      parseFloat(item?.price?.value) || 0,
      item?.price?.currency || currency || 'BRL',
      createdAt,
      platformUtm.utm_source || checkoutData.utm_source || null,
      platformUtm.utm_campaign || checkoutData.utm_campaign || null,
      platformUtm.utm_medium || checkoutData.utm_medium || null,
      platformUtm.utm_content || checkoutData.utm_content || null,
      platformUtm.utm_term || checkoutData.utm_term || null,
    ));

    await env.DB.batch(batch);
  } catch (e) {
    // Items failed but parent succeeded — roll back parent so the
    // SUM(items.value) == purchase_log.value invariant holds.
    console.error('D1 purchase_items error, rolling back purchase_log row', {
      transactionId, purchaseId, error: e.message,
    });
    try {
      await env.DB.prepare('DELETE FROM purchase_log WHERE id = ?').bind(purchaseId).run();
    } catch (rollbackErr) {
      console.error('CRITICAL: purchase_log rollback failed — manual reconciliation needed', {
        transactionId, purchaseId, error: rollbackErr.message,
      });
    }
  }
}

// -----------------------------------------------------------------------------
// META CAPI — Purchase with full navigation data from D1
// -----------------------------------------------------------------------------
async function sendToMeta({ checkoutData, hashedEm, hashedFn, hashedLn, hashedPh, hashedExternalId, eventId, eventTime, value, currency, productName, contents, env }) {
  if (!env.META_PIXEL_ID || !env.META_ACCESS_TOKEN) {
    return { skipped: 'missing meta env', payload: null, response: null };
  }

  const metaUserData = {
    client_ip_address: checkoutData.ip_address || '',
    client_user_agent: checkoutData.user_agent || '',
  };

  if (hashedEm) metaUserData.em = [hashedEm];
  if (hashedFn) metaUserData.fn = [hashedFn];
  if (hashedLn) metaUserData.ln = [hashedLn];
  if (hashedPh) metaUserData.ph = [hashedPh];
  if (hashedExternalId) metaUserData.external_id = [hashedExternalId];
  if (checkoutData.fbp) metaUserData.fbp = checkoutData.fbp;
  if (checkoutData.fbc) metaUserData.fbc = checkoutData.fbc;

  // Purchase custom_data per Meta spec: currency + value are required.
  // content_type + content_ids + contents + content_name + num_items are
  // strongly recommended so catalog attribution and product-level ROAS work.
  const customData = {
    value: parseFloat(value) || 0,
    currency: currency,
    content_type: 'product',
  };
  if (contents && contents.length) {
    customData.contents = contents;
    const ids = contents.map(c => c.id).filter(Boolean);
    if (ids.length) customData.content_ids = ids;
    customData.num_items = contents.length;
  }
  if (productName) customData.content_name = productName;

  const metaPayload = {
    data: [{
      event_name: 'Purchase',
      event_time: eventTime,
      event_id: eventId,
      event_source_url: checkoutData.event_source_url || '',
      action_source: 'website',
      user_data: metaUserData,
      custom_data: customData,
    }],
  };

  if (env.META_TEST_EVENT_CODE) {
    metaPayload.test_event_code = env.META_TEST_EVENT_CODE;
  }

  const payloadJson = JSON.stringify(metaPayload);
  const response = await fetch(
    `https://graph.facebook.com/v25.0/${env.META_PIXEL_ID}/events?access_token=${env.META_ACCESS_TOKEN}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payloadJson,
    }
  );
  return { payload: payloadJson, response };
}

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------
async function sha256(value) {
  if (!value) return '';
  const normalized = value.toLowerCase().trim();
  const encoded = new TextEncoder().encode(normalized);
  const buffer = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// Meta CAPI expects phone digits INCLUDING country code + area code
// (e.g. `5511987654321`). Sales platforms sometimes ship the number already
// prefixed, sometimes not; detect and prepend as needed. `countryCode`
// defaults to 55 (Brazil) via env.DEFAULT_COUNTRY_CODE.
function normalizePhone(ph, countryCode) {
  if (!ph) return '';
  const cc = String(countryCode || '55');
  const digits = ph.replace(/\D/g, '').replace(/^0+/, '');
  if (!digits) return '';
  if (digits.startsWith(cc) && digits.length >= cc.length + 8 && digits.length <= cc.length + 11) {
    return digits;
  }
  if (digits.length >= 8 && digits.length <= 11) {
    return cc + digits;
  }
  return digits;
}

// Meta Advanced Matching spec for fn/ln is lowercase only — do NOT strip
// punctuation/accents. Meta preserves apostrophes, hyphens, diacritics;
// stripping them breaks hash matches for names like "O'Brien", "João".
function normalizeName(name) {
  if (!name) return '';
  return name.trim().toLowerCase();
}

function splitName(fullName) {
  const parts = (fullName || '').trim().split(/\s+/);
  return { fn: parts[0] || '', ln: parts.slice(1).join(' ') || '' };
}
