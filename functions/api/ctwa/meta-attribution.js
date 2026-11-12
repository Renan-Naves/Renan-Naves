// GET /api/ctwa/meta-attribution?key=…&since=YYYY-MM-DD&until=YYYY-MM-DD
//
// What Ads Manager counts as "conversas por mensagem iniciadas" for the WhatsApp
// ad sets, split by HOW Meta credits them. Explains the gap between Ads Manager
// and the tracker (checked 2026-11-12, Agenda Aberta 01/10-12/11: 32 conversations
// = 23 one-day VIEW + 9 seven-day click, of which 4 same-day click; the tracker
// caught those 4):
//
//   1d_click  clicked the ad's WhatsApp button and wrote the same day: arrives
//             with the ad's click id (or the "Vi o anuncio" text) -> tracked here
//   7d_click  clicked, wrote up to 7 days later, usually through another path
//             (bio, site, number search) -> arrives WITHOUT ad context
//   1d_view   saw the ad, did not click, wrote within a day through another path
//             -> arrives WITHOUT ad context; no tracker can link it to the ad
//
// Reads Meta's Insights API with META_ADS_ACCESS_TOKEN (ads_read). Display only.

import { guard, json } from '../../lib/ctwa-http.js';

const ACTION = 'onsite_conversion.messaging_conversation_started_7d';
const DEFAULT_ACCOUNT = '971138310494506';

export async function onRequestGet({ request, env }) {
  const denied = await guard(request, env);
  if (denied) return denied;

  const token = env.META_ADS_ACCESS_TOKEN || env.META_WA_ACCESS_TOKEN;
  if (!token) return json({ ok: false, error: 'missing META_ADS_ACCESS_TOKEN' });

  const url = new URL(request.url);
  const ymd = /^\d{4}-\d{2}-\d{2}$/;
  const since = url.searchParams.get('since');
  const until = url.searchParams.get('until');
  if (!ymd.test(since || '') || !ymd.test(until || '')) return json({ ok: false, error: 'since/until must be YYYY-MM-DD' }, 400);

  const account = String(env.META_ADS_ACCOUNT_ID || DEFAULT_ACCOUNT).replace(/^act_/, '');
  const q = new URLSearchParams({
    level: 'adset',
    fields: 'adset_id,adset_name,campaign_name,actions',
    time_range: JSON.stringify({ since, until }),
    action_attribution_windows: JSON.stringify(['1d_click', '7d_click', '1d_view']),
    limit: '200',
  });
  let resp, data;
  try {
    resp = await fetch(`https://graph.facebook.com/v22.0/act_${account}/insights?${q}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    data = await resp.json();
  } catch (err) {
    return json({ ok: false, error: `fetch_error: ${err?.message ?? err}` });
  }
  if (!resp.ok) return json({ ok: false, error: data?.error?.message || `meta_${resp.status}` });

  const adsets = [];
  const total = { click_1d: 0, click_7d: 0, view_1d: 0, total: 0 };
  for (const row of data?.data ?? []) {
    const a = (row.actions ?? []).find((x) => x.action_type === ACTION);
    if (!a) continue;
    const c1 = Number(a['1d_click'] || 0);
    const c7 = Number(a['7d_click'] || 0);
    const v1 = Number(a['1d_view'] || 0);
    const t = c7 + v1;
    adsets.push({ adset_id: row.adset_id, adset_name: row.adset_name, campaign_name: row.campaign_name,
      click_1d: c1, click_7d: c7, view_1d: v1, total: t });
    total.click_1d += c1; total.click_7d += c7; total.view_1d += v1; total.total += t;
  }
  return json({ ok: true, since, until, total, adsets });
}
