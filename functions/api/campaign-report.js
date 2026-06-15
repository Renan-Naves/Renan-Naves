// GET /api/campaign-report?key=...&from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Powers the /dashboard page: a dual-platform results view (Meta Ads + Google Ads)
// for Dr. Renan. Everything is read from D1 — never the ad APIs in the request path.
//
// Funnel model (this LP has NO form; a lead is a WhatsApp conversation):
//   Meta   = Click-to-WhatsApp (CTWA). The lead skips the LP; the conversation
//            is captured by the uazapi webhook into wa_conversations (platform='meta').
//   Google = the ad lands on the LP (utm_source='google-ads'), the visitor clicks
//            the WhatsApp CTA → a website 'Lead' event in event_log. That click is
//            the conversa.
//   Qualified leads + sales are MANUAL: set by the attendant on wa_conversations.
//
// Metric sources:
//   investimento / cliques  → ad_spend (platform 'meta' | 'google')
//   conversas Meta          → wa_conversations (platform='meta')
//   conversas Google        → event_log Lead (is_bot=0) ⋈ sessions (utm_source='google-ads')
//   LP view                 → sessions (count); LP view Google = sessions w/ utm_source='google-ads'
//   top anúncios Meta       → ad_spend (platform='meta') grouped by ad_name
//   top palavras-chave Goog → google_keyword_stats if synced, else sessions.utm_term (lead side)
//   funil (qual./vendas)    → wa_conversations (manual marks)
//
// Resilient by design: the wa_conversations / google_keyword_stats tables may not
// be migrated yet (infra-first rollout), so their queries are wrapped and default
// to empty — the dashboard still renders with the live Meta/Google-lead data.
//
// Auth: ?key=<DASH_KEY>, same as the other /api/* dashboard endpoints.

import { resolveOrigin } from '../origins.js';

const META_SOURCE = 'meta-ads';
const GOOGLE_SOURCE = 'google-ads';

// Canonical origins that count as PAID traffic for the revenue split / ROAS.
// Everything else (organico-site, google-meu-negocio, instagram-bio, tiktok-bio,
// indicacao, remarketing, outro) counts as organic.
const TRAFFIC_ORIGINS = new Set([GOOGLE_SOURCE, META_SOURCE]);

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
  const db = env.DB;

  try {
    const [
      metaSpend, googleSpend,
      googleLeads, googleLeadsDaily, googleKeywordsLead,
      lpViewTotal, lpViewGoogle,
      metaSpendByAd, metaSpendDaily,
      metaSync, googleSync,
    ] = await Promise.all([
      // --- ad spend (per platform) ---
      db.prepare(`
        SELECT COALESCE(SUM(spend_cents),0) AS cents, COALESCE(SUM(impressions),0) AS impressions,
               COALESCE(SUM(clicks),0) AS clicks, COALESCE(MAX(currency),'BRL') AS currency
        FROM ad_spend WHERE platform='meta' AND date >= ? AND date <= ?
      `).bind(from, to).first(),

      db.prepare(`
        SELECT COALESCE(SUM(spend_cents),0) AS cents, COALESCE(SUM(impressions),0) AS impressions,
               COALESCE(SUM(clicks),0) AS clicks, COALESCE(MAX(currency),'BRL') AS currency
        FROM ad_spend WHERE platform='google' AND date >= ? AND date <= ?
      `).bind(from, to).first(),

      // --- Google leads (LP WhatsApp clicks) ---
      db.prepare(`
        SELECT COUNT(*) AS n FROM event_log e JOIN sessions s ON e.session_id = s.session_id
        WHERE e.event_name='Lead' AND e.is_bot=0 AND s.utm_source=? AND e.timestamp >= ? AND e.timestamp <= ?
      `).bind(GOOGLE_SOURCE, fromTs, toTs).first(),

      db.prepare(`
        SELECT date(e.timestamp,'unixepoch') AS date, COUNT(*) AS n
        FROM event_log e JOIN sessions s ON e.session_id = s.session_id
        WHERE e.event_name='Lead' AND e.is_bot=0 AND s.utm_source=? AND e.timestamp >= ? AND e.timestamp <= ?
        GROUP BY date(e.timestamp,'unixepoch')
      `).bind(GOOGLE_SOURCE, fromTs, toTs).all(),

      db.prepare(`
        SELECT COALESCE(NULLIF(TRIM(s.utm_term),''),'(sem palavra-chave)') AS keyword, COUNT(*) AS leads
        FROM event_log e JOIN sessions s ON e.session_id = s.session_id
        WHERE e.event_name='Lead' AND e.is_bot=0 AND s.utm_source=? AND e.timestamp >= ? AND e.timestamp <= ?
        GROUP BY LOWER(TRIM(s.utm_term)) ORDER BY leads DESC LIMIT 10
      `).bind(GOOGLE_SOURCE, fromTs, toTs).all(),

      // --- LP views (sessions) ---
      db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE created_at >= ? AND created_at <= ?`)
        .bind(fromTs, toTs).first(),
      db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE utm_source=? AND created_at >= ? AND created_at <= ?`)
        .bind(GOOGLE_SOURCE, fromTs, toTs).first(),

      // --- Meta ads (per creative + daily spend) ---
      db.prepare(`
        SELECT COALESCE(NULLIF(TRIM(ad_name),''),'(sem nome)') AS name, SUM(spend_cents) AS cents,
               SUM(impressions) AS impressions, SUM(clicks) AS clicks
        FROM ad_spend WHERE platform='meta' AND date >= ? AND date <= ?
        GROUP BY LOWER(TRIM(ad_name)) HAVING SUM(spend_cents) > 0 ORDER BY cents DESC LIMIT 10
      `).bind(from, to).all(),

      db.prepare(`
        SELECT date, COALESCE(SUM(spend_cents),0) AS cents
        FROM ad_spend WHERE platform='meta' AND date >= ? AND date <= ? GROUP BY date
      `).bind(from, to).all(),

      db.prepare(`SELECT MAX(run_at) AS t FROM sync_log WHERE platform='meta' AND status='ok'`).first(),
      db.prepare(`SELECT MAX(run_at) AS t FROM sync_log WHERE platform='google' AND status='ok'`).first(),
    ]);

    // --- wa_conversations + google_keyword_stats (may be unmigrated → default) ---
    // `deleted_at IS NULL` keeps soft-deleted conversations out of every metric;
    // archived ones DO still count (a sale filed away is still revenue).
    const metaLeads = await safeFirst(db,
      `SELECT COUNT(*) AS n FROM wa_conversations WHERE platform='meta' AND deleted_at IS NULL AND created_at >= ? AND created_at <= ?`,
      [fromTs, toTs], { n: 0 });
    const metaLeadsDaily = await safeAll(db,
      `SELECT date(created_at,'unixepoch') AS date, COUNT(*) AS n FROM wa_conversations
       WHERE platform='meta' AND deleted_at IS NULL AND created_at >= ? AND created_at <= ? GROUP BY date(created_at,'unixepoch')`,
      [fromTs, toTs], []);
    const funnelRow = await safeFirst(db,
      `SELECT COUNT(*) AS leads,
              COALESCE(SUM(is_qualified),0) AS qualified,
              COALESCE(SUM(CASE WHEN status='sale' THEN 1 ELSE 0 END),0) AS sales,
              COALESCE(SUM(CASE WHEN status='sale' THEN sale_value_cents ELSE 0 END),0) AS revenue_cents
       FROM wa_conversations WHERE deleted_at IS NULL AND created_at >= ? AND created_at <= ?`,
      [fromTs, toTs], { leads: 0, qualified: 0, sales: 0, revenue_cents: 0 });
    const metaLeadsByAd = await safeAll(db,
      `SELECT COALESCE(NULLIF(TRIM(utm_content),''),'') AS name, COUNT(*) AS leads
       FROM wa_conversations WHERE platform='meta' AND deleted_at IS NULL AND created_at >= ? AND created_at <= ?
       GROUP BY LOWER(TRIM(utm_content))`,
      [fromTs, toTs], []);
    // sales rows (with the fields resolveOrigin needs) → revenue split traffic vs organic
    const saleRows = await safeAll(db,
      `SELECT w.sale_value_cents, w.manual_origin, w.utm_source, w.gclid, w.ctwa_clid,
              s.referrer AS s_referrer, s.utm_source AS s_utm_source, s.gclid AS s_gclid
       FROM wa_conversations w LEFT JOIN sessions s ON w.session_id = s.session_id
       WHERE w.status='sale' AND w.deleted_at IS NULL AND w.created_at >= ? AND w.created_at <= ?`,
      [fromTs, toTs], []);
    const googleKeywordsSynced = await safeAll(db,
      `SELECT keyword, SUM(clicks) AS clicks, SUM(conversions) AS conversions, SUM(spend_cents) AS cents
       FROM google_keyword_stats WHERE date >= ? AND date <= ?
       GROUP BY LOWER(keyword) ORDER BY conversions DESC, clicks DESC LIMIT 10`,
      [from, to], []);

    // --- assemble ---
    const meta = platformBlock(metaSpend, num(metaLeads.n));
    const google = platformBlock(googleSpend, num(googleLeads?.n));

    const totalsSpend = meta.spend + google.spend;
    const totalsLeads = meta.leads + google.leads;

    // --- revenue split (traffic = paid origins, organic = the rest) + ROAS ---
    let revTraffic = 0, revOrganic = 0;
    for (const r of saleRows) {
      const utm_source = r.utm_source || r.s_utm_source || '';
      const origin = resolveOrigin({
        manual_origin: r.manual_origin, utm_source, gclid: r.gclid || r.s_gclid,
        ctwa_clid: r.ctwa_clid, referrer: r.s_referrer,
      });
      const val = num(r.sale_value_cents) / 100;
      if (TRAFFIC_ORIGINS.has(origin)) revTraffic += val; else revOrganic += val;
    }
    const revenueTotal = num(funnelRow.revenue_cents) / 100;
    const roas = totalsSpend > 0 ? revTraffic / totalsSpend : null;
    const profitTraffic = revTraffic - totalsSpend; // lucro do tráfego (receita − investimento)

    return json({
      from, to,
      currency: metaSpend?.currency || googleSpend?.currency || 'BRL',
      meta,
      google,
      totals: {
        spend: totalsSpend,
        clicks: meta.clicks + google.clicks,
        impressions: meta.impressions + google.impressions,
        leads: totalsLeads,
        cpl: totalsLeads > 0 ? totalsSpend / totalsLeads : null,
      },
      revenue: {
        total: revenueTotal,
        traffic: revTraffic,
        organic: revOrganic,
      },
      roas,                       // receita do tráfego ÷ investimento (ratio, ex 4.2)
      profit_traffic: profitTraffic, // receita do tráfego − investimento (lucro em R$)
      lp_view: num(lpViewTotal?.n),
      lp_view_google: num(lpViewGoogle?.n),
      daily: buildDaily(from, to, {
        metaSpend: metaSpendDaily.results || [],
        googleLeads: googleLeadsDaily.results || [],
        metaLeads: metaLeadsDaily,
      }),
      top_ads_meta: mergeMetaAds(metaSpendByAd.results || [], metaLeadsByAd),
      top_keywords_google: googleKeywordsSynced.length
        ? googleKeywordsSynced.map(k => ({
            keyword: k.keyword, clicks: num(k.clicks), conversions: num(k.conversions),
            spend: num(k.cents) / 100, leads: null, source: 'google',
          }))
        : (googleKeywordsLead.results || []).map(k => ({
            keyword: k.keyword, leads: num(k.leads), clicks: null, conversions: null,
            spend: null, source: 'lead',
          })),
      funnel: {
        leads: totalsLeads,
        qualified: num(funnelRow.qualified),
        sales: num(funnelRow.sales),
        revenue: num(funnelRow.revenue_cents) / 100,
      },
      sync: {
        meta_last_synced_at: metaSync?.t || null,
        google_last_synced_at: googleSync?.t || null,
      },
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function platformBlock(spendRow, leads) {
  const spend = num(spendRow?.cents) / 100;
  return {
    spend,
    impressions: num(spendRow?.impressions),
    clicks: num(spendRow?.clicks),
    leads,
    cpl: leads > 0 ? spend / leads : null,
  };
}

// Top Meta ads by spend, leads matched on normalised name vs wa_conversations.utm_content.
function mergeMetaAds(spendRows, leadRows) {
  const norm = s => String(s || '').trim().toLowerCase();
  const leadByKey = new Map();
  for (const r of leadRows) {
    if (!r.name) continue;
    leadByKey.set(norm(r.name), num(r.leads));
  }
  return spendRows.map(r => {
    const spend = num(r.cents) / 100;
    const leads = leadByKey.get(norm(r.name)) || 0;
    return {
      name: r.name,
      spend,
      impressions: num(r.impressions),
      clicks: num(r.clicks),
      leads,
      cpl: leads > 0 ? spend / leads : null,
    };
  });
}

// One entry per calendar day in [from, to], all series zero-filled.
function buildDaily(from, to, src) {
  const metaSpendMap = new Map(src.metaSpend.map(r => [r.date, num(r.cents) / 100]));
  const googleLeadMap = new Map(src.googleLeads.map(r => [r.date, num(r.n)]));
  const metaLeadMap = new Map(src.metaLeads.map(r => [r.date, num(r.n)]));
  // ad_spend has no google rows yet → google spend daily zero-fills.

  const out = [];
  let cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  let safety = 400;
  while (cursor <= end && safety-- > 0) {
    const date = ymd(cursor);
    const metaSpend = metaSpendMap.get(date) || 0;
    const googleSpend = 0;
    const metaLeads = metaLeadMap.get(date) || 0;
    const googleLeads = googleLeadMap.get(date) || 0;
    out.push({
      date,
      meta_spend: metaSpend,
      google_spend: googleSpend,
      meta_leads: metaLeads,
      google_leads: googleLeads,
      meta_cpl: metaLeads > 0 ? metaSpend / metaLeads : null,
      google_cpl: googleLeads > 0 ? googleSpend / googleLeads : null,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

// Run a query that may hit a not-yet-migrated table; default on any error.
async function safeFirst(db, sql, binds, fallback) {
  try { return (await db.prepare(sql).bind(...binds).first()) || fallback; }
  catch (_) { return fallback; }
}
async function safeAll(db, sql, binds, fallback) {
  try { return (await db.prepare(sql).bind(...binds).all()).results || fallback; }
  catch (_) { return fallback; }
}

function num(v) { return Number(v || 0); }

function resolveRange(rawFrom, rawTo) {
  const today = new Date();
  const fallbackTo = ymd(today);
  const fallbackFrom = ymd(addDays(today, -6));
  let from = isYmd(rawFrom) ? rawFrom : fallbackFrom;
  let to = isYmd(rawTo) ? rawTo : fallbackTo;
  if (from > to) [from, to] = [to, from];
  return { from, to };
}

function isYmd(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

function ymd(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function addDays(d, n) {
  const nd = new Date(d);
  nd.setUTCDate(nd.getUTCDate() + n);
  return nd;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
