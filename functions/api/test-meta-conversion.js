// GET /api/test-meta-conversion?key=...&type=qualified|purchase&ctwa_clid=...&value=...&test_event_code=...&phone=...
//
// Diagnostic ONLY. Fires a Meta `business_messaging` conversion to the MESSAGING
// dataset (META_WA_PIXEL_ID, e.g. the CTWA / WhatsApp pixel) so you can confirm
// the dataset id + access token are wired correctly BEFORE a real CTWA lead
// arrives. Reports which pixel it used so you can see the web-pixel fallback.
//
// Meta CAPI has NO validateOnly (unlike Google Data Manager), so this DOES send
// a real event. Pass a `test_event_code` (or set META_WA_TEST_EVENT_CODE) and a
// throwaway `ctwa_clid` so it lands in Events Manager → Test Events and
// attributes to nothing. A 200 + events_received:1 proves the token authenticates
// against the pixel; an OAuth/permission error means the token/pixel id is wrong.
//
// Safe to keep in prod: gated by DASH_KEY.
//
// Auth: ?key=<DASH_KEY>.

import { sendMetaMessagingConversion } from '../meta-conversions.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (!env.DASH_KEY || url.searchParams.get('key') !== env.DASH_KEY) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const type = (url.searchParams.get('type') || 'qualified').toLowerCase();
  const eventName = type === 'purchase' ? 'Purchase' : 'QualifiedLead';
  const ctwaClid = url.searchParams.get('ctwa_clid') || 'TEST_CTWA_CLID_DIAGNOSTIC';
  const value = parseFloat(url.searchParams.get('value') || '');
  const valueCents = type === 'purchase' ? Math.round((Number.isNaN(value) ? 1 : value) * 100) : undefined;
  const testEventCode = url.searchParams.get('test_event_code') || undefined;

  const result = await sendMetaMessagingConversion({
    env,
    eventName,
    ctwaClid,
    phone: url.searchParams.get('phone') || '',
    valueCents,
    currency: 'BRL',
    eventId: `test-meta-${type}-${Date.now()}`,
    eventTime: Math.floor(Date.now() / 1000),
    testEventCode,
  });

  return json({
    type,
    event_name: eventName,
    pixel_used: env.META_WA_PIXEL_ID || env.META_PIXEL_ID || null,
    using_wa_pixel: !!env.META_WA_PIXEL_ID,
    ctwa_clid_used: ctwaClid,
    test_event_code: testEventCode || env.META_WA_TEST_EVENT_CODE || env.META_TEST_EVENT_CODE || null,
    skipped: result.skipped || null,
    status: result.response?.status ?? null,
    ok: result.response?.ok ?? null,
    meta_response: (result.body || '').slice(0, 1500),
  });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
