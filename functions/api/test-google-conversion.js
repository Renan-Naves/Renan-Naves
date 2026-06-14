// GET /api/test-google-conversion?key=...&type=qualified|purchase|lead&gclid=...&value=...
//
// Diagnostic ONLY. Fires a Google Ads Data Manager conversion with
// `validateOnly:true` — Google validates auth + account ids + conversion action
// id + payload shape but RECORDS NOTHING. Use it to confirm the GOOGLE_ADS_*
// env vars and the conversion-action ids are wired correctly before real fires.
//
// Safe to keep in prod: gated by DASH_KEY, never records a conversion.
//
// Auth: ?key=<DASH_KEY>.

import { sendGoogleOfflineConversion } from '../google-ads.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (!env.DASH_KEY || url.searchParams.get('key') !== env.DASH_KEY) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const type = (url.searchParams.get('type') || 'qualified').toLowerCase();
  const actionMap = {
    lead: env.GOOGLE_ADS_LEAD_CONVERSION_ACTION_ID,
    qualified: env.GOOGLE_ADS_QUALIFIED_CONVERSION_ACTION_ID,
    purchase: env.GOOGLE_ADS_PURCHASE_CONVERSION_ACTION_ID,
  };
  const conversionActionId = actionMap[type];
  if (!conversionActionId) {
    return json({ error: `no conversion action id configured for type='${type}'` }, 400);
  }

  // A throwaway gclid is fine — validateOnly checks structure/auth/action, not
  // gclid ownership. Pass a real one via ?gclid= for a fuller check.
  const gclid = url.searchParams.get('gclid') || 'TEST_GCLID_VALIDATE_ONLY';
  const value = parseFloat(url.searchParams.get('value') || '');
  const valueCents = type === 'purchase' ? Math.round((Number.isNaN(value) ? 1 : value) * 100) : undefined;

  const result = await sendGoogleOfflineConversion({
    env,
    conversionActionId,
    gclid,
    valueCents,
    currency: 'BRL',
    eventTime: Math.floor(Date.now() / 1000),
    transactionId: `validate-${type}-${Date.now()}`,
    validateOnly: true,
  });

  return json({
    type,
    conversion_action_id: String(conversionActionId),
    gclid_used: gclid,
    validate_only: true,
    skipped: result.skipped || null,
    status: result.response?.status ?? null,
    ok: result.response?.ok ?? null,
    google_response: (result.body || '').slice(0, 2000),
  });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
