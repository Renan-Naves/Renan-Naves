// GET /api/utm-attribution?key=...&from=YYYY-MM-DD&to=YYYY-MM-DD&origin=...
//
// Lead-by-lead attribution, keyed to the WhatsApp number. Each row is a
// wa_conversations entry enriched with its full UTM set + resolved canonical
// origin (see functions/origins.js). For LP/token leads it LEFT JOINs sessions
// to recover utm_medium / referrer (organic detection). Also returns a summary
// aggregated by origin (leads / qualified / sales / revenue).
//
// Returns empty (not an error) if wa_conversations isn't migrated yet.
//
// Auth: ?key=<DASH_KEY>.

import { resolveOrigin, originLabel, ORIGINS } from '../origins.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!env.DASH_KEY || key !== env.DASH_KEY) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const { from, to } = resolveRange(url.searchParams.get('from'), url.searchParams.get('to'));
  const fromTs = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000);
  const toTs = Math.floor(Date.parse(`${to}T23:59:59Z`) / 1000);
  const originFilter = url.searchParams.get('origin') || '';
  const archived = url.searchParams.get('archived') === '1';

  let results;
  try {
    const r = await env.DB.prepare(`
      SELECT w.id, w.wa_phone, w.wa_contact_name, w.platform, w.link_method,
             w.ctwa_clid, w.gclid, w.session_id, w.manual_origin,
             w.utm_source, w.utm_medium, w.utm_campaign, w.utm_content, w.utm_term,
             w.status, w.is_qualified, w.sale_value_cents, w.sale_currency, w.created_at,
             w.archived_at,
             s.referrer AS s_referrer, s.utm_medium AS s_utm_medium, s.utm_source AS s_utm_source,
             s.utm_campaign AS s_utm_campaign, s.utm_content AS s_utm_content, s.utm_term AS s_utm_term,
             s.gclid AS s_gclid
      FROM wa_conversations w
      LEFT JOIN sessions s ON w.session_id = s.session_id
      WHERE w.created_at >= ? AND w.created_at <= ?
        AND w.deleted_at IS NULL
        AND w.archived_at IS ${archived ? 'NOT NULL' : 'NULL'}
      ORDER BY w.created_at DESC
    `).bind(fromTs, toTs).all();
    results = r.results || [];
  } catch (_) {
    return json({ from, to, origins: emptySummary(), rows: [], count: 0, pending_migration: true });
  }

  const rows = results.map(r => {
    const utm_source = r.utm_source || r.s_utm_source || '';
    const origin = resolveOrigin({
      manual_origin: r.manual_origin, utm_source, gclid: r.gclid || r.s_gclid,
      ctwa_clid: r.ctwa_clid, referrer: r.s_referrer,
    });
    return {
      id: r.id,
      phone: maskPhone(r.wa_phone),
      name: r.wa_contact_name || '',
      origin,
      origin_label: originLabel(origin),
      origin_manual: !!r.manual_origin,
      platform: r.platform || 'unknown',
      link_method: r.link_method || 'unresolved',
      utm_source,
      utm_medium: r.utm_medium || r.s_utm_medium || '',
      utm_campaign: r.utm_campaign || r.s_utm_campaign || '',
      utm_content: r.utm_content || r.s_utm_content || '',
      utm_term: r.utm_term || r.s_utm_term || '',
      gclid: r.gclid || r.s_gclid || '',
      ctwa_clid: r.ctwa_clid || '',
      status: r.status || 'new',
      is_qualified: !!r.is_qualified,
      sale_value: r.sale_value_cents != null ? r.sale_value_cents / 100 : null,
      created_at: r.created_at,
      archived: !!r.archived_at,
    };
  });

  // summary by origin
  const byOrigin = new Map(ORIGINS.map(o => [o.key, { origin: o.key, label: o.label, leads: 0, qualified: 0, sales: 0, revenue: 0 }]));
  for (const row of rows) {
    const agg = byOrigin.get(row.origin) || byOrigin.get('outro');
    agg.leads += 1;
    if (row.is_qualified) agg.qualified += 1;
    if (row.status === 'sale') { agg.sales += 1; agg.revenue += row.sale_value || 0; }
  }
  const origins = [...byOrigin.values()].filter(o => o.leads > 0).sort((a, b) => b.leads - a.leads);

  const filtered = originFilter ? rows.filter(r => r.origin === originFilter) : rows;
  return json({ from, to, origins, rows: filtered, count: filtered.length });
}

function emptySummary() { return []; }

function maskPhone(p) {
  if (!p) return '';
  const d = String(p).replace(/\D/g, '');
  if (d.length < 4) return d;
  return d.slice(0, -4).replace(/\d/g, '•') + d.slice(-4);
}

function resolveRange(rawFrom, rawTo) {
  const today = new Date();
  const fallbackTo = ymd(today);
  const fallbackFrom = ymd(addDays(today, -29));
  let from = isYmd(rawFrom) ? rawFrom : fallbackFrom;
  let to = isYmd(rawTo) ? rawTo : fallbackTo;
  if (from > to) [from, to] = [to, from];
  return { from, to };
}
function isYmd(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function ymd(d) { const p = n => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`; }
function addDays(d, n) { const nd = new Date(d); nd.setUTCDate(nd.getUTCDate() + n); return nd; }

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
