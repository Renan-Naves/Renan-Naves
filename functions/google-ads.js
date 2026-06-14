// -------------------------------------------------------------------------
// Google Ads — offline lead conversion via the Data Manager API.
//
// This LP has no form: a "lead" is a WhatsApp-CTA click, so we can't collect
// an email/phone before the redirect and enhanced-conversions-for-leads
// (hashed PII) doesn't apply. Instead we attribute by the Google click id
// (gclid) that the edge middleware captured into `sessions`, and ingest a
// click-conversion event for the configured conversion action.
//
// NOTE ON THE API: Google is sunsetting the legacy Google Ads API
// `ConversionUploadService.UploadClickConversions` for new adopters — from
// 2026-06-15 a developer token with no prior offline-conversion history is
// rejected (CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE). The replacement is the
// **Data Manager API** (`datamanager.googleapis.com/v1/events:ingest`), which
// needs NO developer token and NO login-customer-id header — the Google Ads
// operating account (the advertiser) and login account (the MCC) travel in the
// request body's `destinations`. OAuth scope is `.../auth/datamanager`.
//
// Like every other integration in this stack, it stays SILENT until fully
// configured — it fires only when ALL of these env vars are set:
//   GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN,
//   GOOGLE_ADS_CUSTOMER_ID (advertiser / operating account, digits only),
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID (MCC, digits only),
//   GOOGLE_ADS_LEAD_CONVERSION_ACTION_ID (a WEBPAGE conversion action id)
// ...and the visitor's session carries a gclid (i.e. they came from a Google
// ad). No gclid → nothing to attribute → skip. Organic / Meta / direct leads
// are simply not sent to Google Ads, which is correct.
// -------------------------------------------------------------------------

const DATA_MANAGER_ENDPOINT = 'https://datamanager.googleapis.com/v1/events:ingest';

const REQUIRED_ENV = [
  'GOOGLE_ADS_CLIENT_ID',
  'GOOGLE_ADS_CLIENT_SECRET',
  'GOOGLE_ADS_REFRESH_TOKEN',
  'GOOGLE_ADS_CUSTOMER_ID',
  'GOOGLE_ADS_LOGIN_CUSTOMER_ID',
  'GOOGLE_ADS_LEAD_CONVERSION_ACTION_ID',
];

export async function sendToGoogleAds({ body, sessionData, env }) {
  const eventName = (body.event_name || '').toLowerCase();
  if (eventName !== 'lead') return { skipped: 'not a lead event' };

  if (REQUIRED_ENV.some((k) => !env[k])) return { skipped: 'missing google ads env' };

  const gclid = sessionData && sessionData.gclid;
  if (!gclid) return { skipped: 'no gclid on session' };

  const accessToken = await getAccessToken(env);
  if (!accessToken.ok) return { skipped: accessToken.reason };

  return ingestEvent({
    env,
    accessToken: accessToken.token,
    conversionActionId: env.GOOGLE_ADS_LEAD_CONVERSION_ACTION_ID,
    gclid,
    eventTime: body.event_time,
    transactionId: body.event_id,
  });
}

// -------------------------------------------------------------------------
// General offline-conversion upload, keyed by gclid. Used by the manual
// WhatsApp marking flow (functions/api/mark-conversion.js) to fire
// QualifiedLead / Purchase for Google-originated leads, against a DIFFERENT
// conversion action than the automatic Lead. Caller supplies the
// conversionActionId (e.g. env.GOOGLE_ADS_QUALIFIED_CONVERSION_ACTION_ID or
// env.GOOGLE_ADS_PURCHASE_CONVERSION_ACTION_ID) and, for Purchase, a value.
// Stays silent unless the OAuth + account env vars are set and a gclid is given.
// -------------------------------------------------------------------------
export async function sendGoogleOfflineConversion({
  env, conversionActionId, gclid, valueCents, currency, eventTime, transactionId, phone,
}) {
  const REQUIRED_OAUTH = [
    'GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_REFRESH_TOKEN',
    'GOOGLE_ADS_CUSTOMER_ID', 'GOOGLE_ADS_LOGIN_CUSTOMER_ID',
  ];
  if (REQUIRED_OAUTH.some((k) => !env[k])) return { skipped: 'missing google ads env' };
  if (!conversionActionId) return { skipped: 'missing conversion action id' };
  if (!gclid) return { skipped: 'no gclid' };

  const accessToken = await getAccessToken(env);
  if (!accessToken.ok) return { skipped: accessToken.reason };

  // Enhanced matching (2026): include the hashed phone as an extra identifier
  // alongside the gclid when available (manual WhatsApp marks carry a phone).
  // gclid stays the primary key; this only helps if enhanced conversions for
  // leads is enabled on the account — it's ignored otherwise, never harmful.
  let userIdentifiers;
  const hashedPhone = await sha256Hex(normalizePhoneE164(phone, env.DEFAULT_COUNTRY_CODE));
  if (hashedPhone) userIdentifiers = [{ phoneNumber: hashedPhone }];

  return ingestEvent({
    env,
    accessToken: accessToken.token,
    conversionActionId,
    gclid,
    valueCents,
    currency,
    eventTime,
    transactionId,
    userIdentifiers,
  });
}

// OAuth: exchange the refresh token (datamanager scope) for an access token.
async function getAccessToken(env) {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_ADS_CLIENT_ID,
      client_secret: env.GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: env.GOOGLE_ADS_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!tokenRes.ok) {
    const t = await tokenRes.text().catch(() => '');
    return { ok: false, reason: `oauth failed: ${tokenRes.status} ${t}` };
  }
  const { access_token: token } = await tokenRes.json();
  if (!token) return { ok: false, reason: 'oauth: no access_token' };
  return { ok: true, token };
}

// Shared Data Manager ingest. `valueCents` is optional (Purchase only);
// `userIdentifiers` is optional (hashed PII for enhanced matching).
async function ingestEvent({ env, accessToken, conversionActionId, gclid, valueCents, currency, eventTime, transactionId, userIdentifiers }) {
  const operatingAccountId = String(env.GOOGLE_ADS_CUSTOMER_ID).replace(/\D/g, '');
  const loginAccountId = String(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID).replace(/\D/g, '');
  const actionId = String(conversionActionId).replace(/\D/g, '');

  const event = {
    eventTimestamp: formatRfc3339(eventTime, env.TIMEZONE_OFFSET),
    transactionId: transactionId || crypto.randomUUID(),
    eventSource: 'WEB',
    adIdentifiers: { gclid },
    // Consent signals (Feb 2026): required for EEA, recommended everywhere.
    // Configurable via env; defaults to GRANTED (typical for non-EEA / BR).
    consent: {
      adUserData: consentValue(env.GOOGLE_ADS_CONSENT_AD_USER_DATA),
      adPersonalization: consentValue(env.GOOGLE_ADS_CONSENT_AD_PERSONALIZATION),
    },
  };
  if (typeof valueCents === 'number' && valueCents > 0) {
    event.conversionValue = valueCents / 100;
    event.currency = currency || 'BRL';
  }
  if (userIdentifiers && userIdentifiers.length) {
    event.userData = { userIdentifiers };
  }

  const payload = {
    destinations: [{
      operatingAccount: { accountType: 'GOOGLE_ADS', accountId: operatingAccountId },
      loginAccount: { accountType: 'GOOGLE_ADS', accountId: loginAccountId },
      productDestinationId: actionId,
    }],
    // Tells Data Manager how the hashed userIdentifiers are encoded.
    ...(event.userData ? { encoding: 'HEX' } : {}),
    events: [event],
    validateOnly: false,
  };

  const payloadJson = JSON.stringify(payload);
  const response = await fetch(DATA_MANAGER_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: payloadJson,
  });
  const respBody = await response.text().catch(() => '');
  return {
    response: { status: response.status, ok: response.ok },
    body: respBody,
    payload: payloadJson,
  };
}

// Data Manager API wants an RFC 3339 timestamp (e.g. "2026-06-14T15:07:01-03:00").
// We shift the event's epoch by the configured offset and read the UTC fields of
// the shifted instant — that yields the wall-clock at that offset — then append
// the same offset string. The instant stays exact; only the displayed wall-clock
// is localized. `env.TIMEZONE_OFFSET` should match the Google Ads account
// timezone (default -03:00, São Paulo).
function formatRfc3339(epochSeconds, offset) {
  const tz = (offset || '-03:00').trim();
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(tz);
  const normalizedOffset = m ? tz : '-03:00';
  const sign = m && m[1] === '-' ? -1 : 1;
  const offMin = m ? sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10)) : -180;
  const secs = Number(epochSeconds) || Math.floor(Date.now() / 1000);
  const d = new Date(secs * 1000 + offMin * 60000);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return `${stamp}${normalizedOffset}`;
}

// Map an env value to a valid Data Manager consent enum. Default GRANTED
// (typical for non-EEA / Brazil). Set the env to DENIED/UNSPECIFIED to change.
function consentValue(v) {
  const s = String(v || '').trim().toUpperCase();
  if (s === 'DENIED' || s === 'CONSENT_DENIED') return 'CONSENT_DENIED';
  if (s === 'UNSPECIFIED' || s === 'CONSENT_UNSPECIFIED') return 'CONSENT_UNSPECIFIED';
  return 'CONSENT_GRANTED';
}

// SHA-256 → lowercase hex (Data Manager `encoding: HEX`).
async function sha256Hex(value) {
  if (!value) return '';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// E.164-ish phone for hashing: digits, prepend country code if missing.
// (Google wants E.164, e.g. +5511999999999 → hash the string WITHOUT the '+'.)
function normalizePhoneE164(ph, countryCode) {
  if (!ph) return '';
  const cc = String(countryCode || '55');
  const digits = String(ph).replace(/\D/g, '').replace(/^0+/, '');
  if (!digits) return '';
  let full = digits;
  if (!(digits.startsWith(cc) && digits.length >= cc.length + 8)) {
    if (digits.length >= 8 && digits.length <= 11) full = cc + digits;
  }
  return '+' + full;
}
