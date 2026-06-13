// -------------------------------------------------------------------------
// Google Ads — offline click-conversion upload (leads).
//
// This LP has no form: a "lead" is a WhatsApp-CTA click, so we can't collect
// an email/phone before the redirect and enhanced-conversions-for-leads
// (hashed PII) doesn't apply. Instead we attribute by the Google click id
// (gclid) that the edge middleware captured into `sessions`, and upload a
// ClickConversion to the configured conversion action.
//
// Like every other integration in this stack, it stays SILENT until fully
// configured — it fires only when ALL of these env vars are set:
//   GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN,
//   GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CUSTOMER_ID,
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID, GOOGLE_ADS_LEAD_CONVERSION_ACTION_ID
// ...and the visitor's session carries a gclid (i.e. they came from Google Ads).
// No gclid → nothing to attribute → skip. Organic / Meta / direct leads are
// simply not uploaded to Google Ads, which is correct.
// -------------------------------------------------------------------------

const GOOGLE_ADS_API_VERSION = 'v18';

const REQUIRED_ENV = [
  'GOOGLE_ADS_CLIENT_ID',
  'GOOGLE_ADS_CLIENT_SECRET',
  'GOOGLE_ADS_REFRESH_TOKEN',
  'GOOGLE_ADS_DEVELOPER_TOKEN',
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

  // OAuth: exchange the long-lived refresh token for a short-lived access token.
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
    return { skipped: `oauth failed: ${tokenRes.status} ${t}` };
  }
  const { access_token: accessToken } = await tokenRes.json();
  if (!accessToken) return { skipped: 'oauth: no access_token' };

  const customerId = String(env.GOOGLE_ADS_CUSTOMER_ID).replace(/\D/g, '');
  const loginCustomerId = String(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID).replace(/\D/g, '');
  const conversionAction =
    `customers/${customerId}/conversionActions/${String(env.GOOGLE_ADS_LEAD_CONVERSION_ACTION_ID).replace(/\D/g, '')}`;

  const payload = {
    conversions: [{
      gclid,
      conversionAction,
      conversionDateTime: formatGoogleAdsDateTime(body.event_time, env.TIMEZONE_OFFSET),
    }],
    // partialFailure lets Google accept the request and report per-conversion
    // problems in the body instead of 4xx-ing the whole call.
    partialFailure: true,
  };

  const payloadJson = JSON.stringify(payload);
  const response = await fetch(
    `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${customerId}:uploadClickConversions`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'developer-token': env.GOOGLE_ADS_DEVELOPER_TOKEN,
        'login-customer-id': loginCustomerId,
        'Content-Type': 'application/json',
      },
      body: payloadJson,
    }
  );
  const respBody = await response.text().catch(() => '');
  return {
    response: { status: response.status, ok: response.ok },
    body: respBody,
    payload: payloadJson,
  };
}

// Google Ads wants "yyyy-mm-dd hh:mm:ss+hh:mm" in the conversion-action
// account's timezone. We shift the event's epoch by the configured offset and
// read the UTC fields of the shifted instant — that yields the wall-clock at
// that offset — then append the same offset string. The instant stays exact;
// only the displayed wall-clock is localized, which is what Google expects.
// `env.TIMEZONE_OFFSET` must match the Google Ads account timezone (default
// -03:00, São Paulo).
function formatGoogleAdsDateTime(epochSeconds, offset) {
  const tz = (offset || '-03:00').trim();
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(tz);
  const normalizedOffset = m ? tz : '-03:00';
  const sign = m && m[1] === '-' ? -1 : 1;
  const offMin = m ? sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10)) : -180;
  const secs = Number(epochSeconds) || Math.floor(Date.now() / 1000);
  const d = new Date(secs * 1000 + offMin * 60000);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return `${stamp}${normalizedOffset}`;
}
