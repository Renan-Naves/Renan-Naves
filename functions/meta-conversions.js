// -------------------------------------------------------------------------
// Meta CAPI — manual WhatsApp conversions (QualifiedLead / Purchase).
//
// Fired from the dashboard's manual marking flow (functions/api/mark-conversion.js)
// for leads that originated on Meta. Because Meta runs Click-to-WhatsApp (CTWA),
// the lead skips the LP entirely — there is no pixel PageView, no website Lead,
// no session. The only identifier is the `ctwa_clid` that travels in the inbound
// message's `referral` object (captured by the uazapi webhook into
// wa_conversations). So these are `business_messaging` conversions keyed by
// `ctwa_clid`, NOT website conversions.
//
// `QualifiedLead` is a CUSTOM event (Meta has no standard qualified-lead event);
// build the Meta custom conversion / optimization on the event name 'QualifiedLead'.
// `Purchase` is the standard event, with value + currency.
//
// Advanced Matching: the attendant knows the contact's phone, so we hash it
// (SHA-256, digits-only with country code) for better matching — this is the
// one PII signal available for a WhatsApp lead.
//
// CTWA conversions belong to the MESSAGING dataset — the pixel the WhatsApp
// Business account / CTWA ads run on — which is a DIFFERENT dataset from the
// website pixel that tracker.js uses for the LP Lead. So this prefers the
// messaging-specific creds (META_WA_PIXEL_ID / META_WA_ACCESS_TOKEN) and only
// falls back to the website pixel when they are unset (backward compatible).
//
// Stays silent unless a pixel id + access token resolve.
// -------------------------------------------------------------------------

const GRAPH_VERSION = 'v25.0';

export async function sendMetaMessagingConversion({
  env, eventName, ctwaClid, phone, valueCents, currency, eventId, eventTime,
}) {
  const pixelId = env.META_WA_PIXEL_ID || env.META_PIXEL_ID;
  const accessToken = env.META_WA_ACCESS_TOKEN || env.META_ACCESS_TOKEN;
  if (!pixelId || !accessToken) {
    return { skipped: 'missing meta env' };
  }
  if (!ctwaClid) {
    return { skipped: 'no ctwa_clid' };
  }

  const userData = { ctwa_clid: ctwaClid };
  const hashedPh = await sha256(normalizePhone(phone, env.DEFAULT_COUNTRY_CODE));
  if (hashedPh) userData.ph = [hashedPh];

  const customData = {};
  if (typeof valueCents === 'number' && valueCents > 0) {
    customData.value = valueCents / 100;
    customData.currency = currency || 'BRL';
  }

  const payload = {
    data: [{
      event_name: eventName,                 // 'QualifiedLead' | 'Purchase'
      event_time: eventTime || Math.floor(Date.now() / 1000),
      event_id: eventId,
      action_source: 'business_messaging',
      messaging_channel: 'whatsapp',
      user_data: userData,
      ...(Object.keys(customData).length ? { custom_data: customData } : {}),
    }],
  };
  // Test Events code for the messaging dataset (falls back to the web one).
  const testEventCode = env.META_WA_TEST_EVENT_CODE || env.META_TEST_EVENT_CODE;
  if (testEventCode) {
    payload.test_event_code = testEventCode;
  }

  const payloadJson = JSON.stringify(payload);
  const response = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${pixelId}/events?access_token=${accessToken}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payloadJson },
  );
  const respBody = await response.text().catch(() => '');
  return {
    response: { status: response.status, ok: response.ok },
    body: respBody,
    payload: payloadJson,
  };
}

// --- helpers (kept local; mirror tracker.js so behaviour matches) ---

async function sha256(value) {
  if (!value) return '';
  const normalized = value.toLowerCase().trim();
  const encoded = new TextEncoder().encode(normalized);
  const buffer = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function normalizePhone(ph, countryCode) {
  if (!ph) return '';
  const cc = String(countryCode || '55');
  const digits = String(ph).replace(/\D/g, '').replace(/^0+/, '');
  if (!digits) return '';
  if (digits.startsWith(cc) && digits.length >= cc.length + 8 && digits.length <= cc.length + 11) {
    return digits;
  }
  if (digits.length >= 8 && digits.length <= 11) {
    return cc + digits;
  }
  return digits;
}
