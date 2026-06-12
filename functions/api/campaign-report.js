// GET /api/campaign-report?key=...&from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Powers the /dashboard page: a clean campaign-results view for Meta Ads.
// Everything is read from D1 — spend comes from `ad_spend` (populated hourly
// by the cron Worker in cron-worker/), conversions come from the tracking
// tables. No call to the Meta API happens in the request path.
//
// CPL / CPA convention (see CLAUDE.md):
//   A conversion counts as "Meta Ads" when utm_source = 'meta-ads'.
//   - leads   → event_log Lead events (is_bot=0) joined to sessions for UTMs
//   - sales   → purchase_log rows (utm_source lives on the row itself)
//   - quiz    → captura_responses + quiz_responses joined to sessions
//   CPL = spend / leads, CPA = spend / sales, ROAS = revenue / spend.
//
// CPL por criativo: spend is grouped by ad_spend.ad_name and leads are
// grouped by sessions.utm_content; the two are matched by normalised name
// (lowercase + trim) because utm_content is filled with the Meta {{ad.name}}
// macro. Creatives with spend but no leads, and leads with no matched spend,
// both appear in the list.
//
// Auth: ?key=<DASH_KEY>, same as the other /api/* dashboard endpoints.

const META_SOURCE = 'meta-ads';

export async function onRequestGet(context) {
  const { request, env } = context;

  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!env.DASH_KEY || key !== env.DASH_KEY) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const { from, to } = resolveRange(url.searchParams.get('from'), url.searchParams.get('to'));
  // ad_spend.date is TEXT 'YYYY-MM-DD' → compare as strings.
  // Conversions use unix seconds → cover the full local-ish day span in UTC.
  const fromTs = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000);
  const toTs = Math.floor(Date.parse(`${to}T23:59:59Z`) / 1000);

  try {
    const db = env.DB;

    const [
      spendRow, leadsRow, salesRow, capturaRow, quizRow,
      spendByCreative, leadsByCreative, dailySpend, dailyLeads, syncRow,
    ] = await Promise.all([
      db.prepare(`
        SELECT COALESCE(SUM(spend_cents), 0) AS cents,
               COALESCE(SUM(impressions), 0) AS impressions,
               COALESCE(SUM(clicks), 0) AS clicks,
               COALESCE(MAX(currency), 'BRL') AS currency
        FROM ad_spend
        WHERE platform = 'meta' AND date >= ? AND date <= ?
      `).bind(from, to).first(),

      db.prepare(`
        SELECT COUNT(*) AS n
        FROM event_log e
        JOIN sessions s ON e.session_id = s.session_id
        WHERE e.event_name = 'Lead' AND e.is_bot = 0
          AND s.utm_source = ?
          AND e.timestamp >= ? AND e.timestamp <= ?
      `).bind(META_SOURCE, fromTs, toTs).first(),

      db.prepare(`
        SELECT COUNT(*) AS n, COALESCE(SUM(value), 0) AS revenue
        FROM purchase_log
        WHERE utm_source = ?
          AND created_at >= ? AND created_at <= ?
      `).bind(META_SOURCE, fromTs, toTs).first(),

      db.prepare(`
        SELECT COUNT(*) AS n
        FROM captura_responses c
        JOIN sessions s ON c.session_id = s.session_id
        WHERE s.utm_source = ?
          AND c.created_at >= ? AND c.created_at <= ?
      `).bind(META_SOURCE, fromTs, toTs).first(),

      db.prepare(`
        SELECT COUNT(*) AS n
        FROM quiz_responses q
        JOIN sessions s ON q.session_id = s.session_id
        WHERE s.utm_source = ?
          AND q.created_at >= ? AND q.created_at <= ?
      `).bind(META_SOURCE, fromTs, toTs).first(),

      db.prepare(`
        SELECT COALESCE(NULLIF(TRIM(ad_name), ''), '(sem nome)') AS name,
               SUM(spend_cents) AS cents,
               SUM(impressions) AS impressions,
               SUM(clicks) AS clicks
        FROM ad_spend
        WHERE platform = 'meta' AND date >= ? AND date <= ?
        GROUP BY LOWER(TRIM(ad_name))
      `).bind(from, to).all(),

      db.prepare(`
        SELECT COALESCE(NULLIF(TRIM(s.utm_content), ''), '(sem criativo)') AS name,
               COUNT(*) AS leads
        FROM event_log e
        JOIN sessions s ON e.session_id = s.session_id
        WHERE e.event_name = 'Lead' AND e.is_bot = 0
          AND s.utm_source = ?
          AND e.timestamp >= ? AND e.timestamp <= ?
        GROUP BY LOWER(TRIM(s.utm_content))
      `).bind(META_SOURCE, fromTs, toTs).all(),

      db.prepare(`
        SELECT date, COALESCE(SUM(spend_cents), 0) AS cents
        FROM ad_spend
        WHERE platform = 'meta' AND date >= ? AND date <= ?
        GROUP BY date
      `).bind(from, to).all(),

      db.prepare(`
        SELECT date(e.timestamp, 'unixepoch') AS date, COUNT(*) AS n
        FROM event_log e
        JOIN sessions s ON e.session_id = s.session_id
        WHERE e.event_name = 'Lead' AND e.is_bot = 0
          AND s.utm_source = ?
          AND e.timestamp >= ? AND e.timestamp <= ?
        GROUP BY date(e.timestamp, 'unixepoch')
      `).bind(META_SOURCE, fromTs, toTs).all(),

      db.prepare(`
        SELECT MAX(run_at) AS last_synced_at
        FROM sync_log
        WHERE platform = 'meta' AND status = 'ok'
      `).first(),
    ]);

    const spend = Number(spendRow?.cents || 0) / 100;
    const leads = Number(leadsRow?.n || 0);
    const sales = Number(salesRow?.n || 0);
    const revenue = Number(salesRow?.revenue || 0);
    const quizResponses = Number(capturaRow?.n || 0) + Number(quizRow?.n || 0);

    return json({
      from,
      to,
      currency: spendRow?.currency || 'BRL',
      spend,
      impressions: Number(spendRow?.impressions || 0),
      clicks: Number(spendRow?.clicks || 0),
      leads,
      cpl: leads > 0 ? spend / leads : null,
      sales,
      revenue,
      cpa: sales > 0 ? spend / sales : null,
      roas: spend > 0 ? revenue / spend : null,
      quiz_responses: quizResponses,
      creatives: mergeCreatives(spendByCreative.results || [], leadsByCreative.results || []),
      daily: buildDaily(from, to, dailySpend.results || [], dailyLeads.results || []),
      last_synced_at: syncRow?.last_synced_at || null,
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// Match spend rows (keyed by ad_name) against lead rows (keyed by utm_content)
// on a normalised name. Either side may be missing for a given creative.
function mergeCreatives(spendRows, leadRows) {
  const byKey = new Map();
  const norm = s => String(s || '').trim().toLowerCase();

  for (const r of spendRows) {
    const key = norm(r.name);
    byKey.set(key, {
      name: r.name,
      spend: Number(r.cents || 0) / 100,
      impressions: Number(r.impressions || 0),
      clicks: Number(r.clicks || 0),
      leads: 0,
    });
  }
  for (const r of leadRows) {
    const key = norm(r.name);
    const existing = byKey.get(key);
    if (existing) {
      existing.leads = Number(r.leads || 0);
    } else {
      byKey.set(key, {
        name: r.name,
        spend: 0,
        impressions: 0,
        clicks: 0,
        leads: Number(r.leads || 0),
      });
    }
  }

  return [...byKey.values()]
    .map(c => ({ ...c, cpl: c.leads > 0 ? c.spend / c.leads : null }))
    .sort((a, b) => b.spend - a.spend || b.leads - a.leads);
}

// One entry per calendar day in [from, to], spend/leads zero-filled.
function buildDaily(from, to, spendRows, leadRows) {
  const spendMap = new Map(spendRows.map(r => [r.date, Number(r.cents || 0) / 100]));
  const leadMap = new Map(leadRows.map(r => [r.date, Number(r.n || 0)]));

  const out = [];
  let cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  let safety = 400;
  while (cursor <= end && safety-- > 0) {
    const date = ymd(cursor);
    out.push({
      date,
      spend: spendMap.get(date) || 0,
      leads: leadMap.get(date) || 0,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function resolveRange(rawFrom, rawTo) {
  const today = new Date();
  const fallbackTo = ymd(today);
  const fallbackFrom = ymd(addDays(today, -6)); // last 7 days inclusive

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
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
