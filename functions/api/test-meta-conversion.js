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
  // ?no_test_code=1 fires the event for REAL (no Test Events routing), exactly as
  // mark-conversion does in production. Needed because META_WA_TEST_EVENT_CODE in
  // the environment would otherwise always win — which is also what silently sends
  // every dashboard conversion to Test Events instead of counting it.
  const noTestCode = url.searchParams.get('no_test_code') === '1';
  const testEventCode = noTestCode ? null : (url.searchParams.get('test_event_code') || undefined);

  // Probe: can this token even LOAD the dataset object (read-only GET)? This
  // disambiguates the subcode-33 error: if the GET succeeds, the token has
  // access and the /events POST failing means the operation/structure isn't
  // supported on that dataset; if the GET also fails, the token lacks access.
  let objectProbe = null;
  const waPixel = env.META_WA_PIXEL_ID || env.META_PIXEL_ID;
  const waToken = env.META_WA_ACCESS_TOKEN || env.META_ACCESS_TOKEN;
  if (waPixel && waToken) {
    try {
      const p = await fetch(`https://graph.facebook.com/v25.0/${waPixel}?fields=id,name,is_unavailable&access_token=${waToken}`);
      objectProbe = { status: p.status, body: (await p.text().catch(() => '')).slice(0, 400) };
    } catch (e) { objectProbe = { error: e.message }; }
  }

  // Who IS this token, and can it see the WhatsApp Business Account? A real
  // ctwa_clid is resolved against the WABA that owns the conversation, so a
  // token that can't even read the WABA can't attribute the conversion.
  const probes = {};
  if (waToken) {
    for (const [name, path] of [
      ['identidade', 'me?fields=id,name'],
      ['waba', `${env.META_WA_BUSINESS_ACCOUNT_ID || ''}?fields=id,name,currency,owner_business_info`],
      ['page', `${env.META_WA_PAGE_ID || ''}?fields=id,name`],
    ]) {
      if (path.startsWith('?')) continue;
      try {
        const r = await fetch(`https://graph.facebook.com/v25.0/${path}${path.includes('?') ? '&' : '?'}access_token=${waToken}`);
        probes[name] = { status: r.status, body: (await r.text().catch(() => '')).slice(0, 300) };
      } catch (e) { probes[name] = { error: e.message }; }
    }
  }

  // Identifier overrides, to isolate WHICH account id Meta accepts for a real
  // ctwa_clid: ?ids=waba|page|none (default: env behaviour), plus explicit
  // ?waba=<id> / ?page_id=<id>. A real clid that clears the 2804087 clid check
  // but then fails generically usually means the id doesn't own that conversation.
  const ids = (url.searchParams.get('ids') || '').toLowerCase();
  const wabaParam = url.searchParams.get('waba') || undefined;
  const pageParam = url.searchParams.get('page_id') || undefined;
  // event_time can be overridden too — CTWA conversions older than Meta's window
  // are rejected, which looks like a wiring failure but isn't.
  const ageDays = parseFloat(url.searchParams.get('age_days') || '');
  const eventTime = Math.floor(Date.now() / 1000) - (Number.isNaN(ageDays) ? 0 : Math.round(ageDays * 86400));

  const result = await sendMetaMessagingConversion({
    env,
    eventName,
    ctwaClid,
    phone: url.searchParams.get('phone') || '',
    valueCents,
    currency: 'BRL',
    eventId: `test-meta-${type}-${Date.now()}`,
    eventTime,
    testEventCode,
    wabaIdOverride: wabaParam,
    pageIdOverride: pageParam,
    omitAccountIds: ids === 'none',
    preferPageId: ids === 'page',
    suppressEnvTestCode: noTestCode,
    // ?pixel=<dataset id> — a real ctwa_clid only resolves against the dataset
    // that actually owns the conversation, so this tells us whether the
    // configured messaging dataset is the right one.
    pixelIdOverride: url.searchParams.get('pixel') || undefined,
  });

  return json({
    type,
    event_name: eventName,
    pixel_used: env.META_WA_PIXEL_ID || env.META_PIXEL_ID || null,
    using_wa_pixel: !!env.META_WA_PIXEL_ID,
    object_probe: objectProbe,
    token_probes: probes,
    waba_id: env.META_WA_BUSINESS_ACCOUNT_ID || null,
    page_id: env.META_WA_PAGE_ID || null,
    ctwa_clid_used: ctwaClid,
    test_event_code: testEventCode || env.META_WA_TEST_EVENT_CODE || env.META_TEST_EVENT_CODE || null,
    skipped: result.skipped || null,
    status: result.response?.status ?? null,
    ok: result.response?.ok ?? null,
    // the exact event we sent, with the clid trimmed (it's ~430 chars)
    payload_sent: (result.payload || '').replace(/("ctwa_clid":")([^"]{20})[^"]*/, '$1$2…').slice(0, 700),
    meta_response: (result.body || '').slice(0, 1500),
  });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
