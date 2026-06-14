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
  env, conversionActionId, gclid, valueCents, currency, eventTime, transactionId,
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

  return ingestEvent({
    env,
    accessToken: accessToken.token,
    conversionActionId,
    gclid,
    valueCents,
    currency,
    eventTime,
    transactionId,
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

// Shared Data Manager ingest. `valueCents` is optional (Purchase only).
async function ingestEvent({ env, accessToken, conversionActionId, gclid, valueCents, currency, eventTime, transactionId }) {
  const operatingAccountId = String(env.GOOGLE_ADS_CUSTOMER_ID).replace(/\D/g, '');
  const loginAccountId = String(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID).replace(/\D/g, '');
  const actionId = String(conversionActionId).replace(/\D/g, '');

  const event = {
    eventTimestamp: formatRfc3339(eventTime, env.TIMEZONE_OFFSET),
    transactionId: transactionId || crypto.randomUUID(),
    eventSource: 'WEB',
    adIdentifiers: { gclid },
  };
  if (typeof valueCents === 'number' && valueCents > 0) {
    event.conversionValue = valueCents / 100;
    event.currency = currency || 'BRL';
  }

  const payload = {
    destinations: [{
      operatingAccount: { accountType: 'GOOGLE_ADS', accountId: operatingAccountId },
      loginAccount: { accountType: 'GOOGLE_ADS', accountId: loginAccountId },
      productDestinationId: actionId,
    }],
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
