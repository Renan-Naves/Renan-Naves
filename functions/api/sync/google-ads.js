// POST /api/sync/google-ads
//
// Pulls Google Ads spend / clicks / impressions (into ad_spend, platform='google')
// and keyword-level performance (into google_keyword_stats) so the /dashboard can
// show Google investment, CPL and "palavras-chave de conversão". Meant to be
// called hourly by the cron Worker, exactly like /api/sync/meta-ads.
//
// API ASYMMETRY (important): uploading conversions uses the Data Manager API (no
// dev token); READING reports needs the regular **Google Ads API** (GAQL) with a
// developer token + login-customer-id. So this stays dormant until the reporting
// creds are set. Required env (separate from the GOOGLE_ADS_* upload creds, though
// it reuses the client id/secret + customer/login ids):
//   GOOGLE_ADS_DEVELOPER_TOKEN
//   GOOGLE_ADS_REPORTING_REFRESH_TOKEN  (scope https://www.googleapis.com/auth/adwords)
//   GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET
//   GOOGLE_ADS_CUSTOMER_ID        (advertiser / operating account, digits only)
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID  (MCC id, digits only; = customer id if no MCC)
//   GOOGLE_ADS_API_VERSION        (optional, default below — set to the current
//                                  stable version when Google sunsets it; Google now
//                                  ships monthly and keeps only the 3 latest majors)
//
// Auth: header `x-sync-secret: <env.SYNC_SECRET>` (same as meta-ads sync).
// Body: { date_from?: 'YYYY-MM-DD', date_to?: 'YYYY-MM-DD' } — defaults last 7 days.

const DEFAULT_API_VERSION = 'v24'; // current major as of 2026-06; v20 (2025) is sunset

export async function onRequestPost(context) {
  const { request, env } = context;

  const sentSecret = request.headers.get('x-sync-secret') || '';
  if (!env.SYNC_SECRET || sentSecret !== env.SYNC_SECRET) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const reportingReady = env.GOOGLE_ADS_DEVELOPER_TOKEN
    && env.GOOGLE_ADS_REPORTING_REFRESH_TOKEN
    && env.GOOGLE_ADS_CLIENT_ID && env.GOOGLE_ADS_CLIENT_SECRET
    && env.GOOGLE_ADS_CUSTOMER_ID && env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;

  if (!reportingReady) {
    return json({
      ok: true,
      skipped: true,
      reason: 'Google Ads reporting creds not set (needs GOOGLE_ADS_DEVELOPER_TOKEN + GOOGLE_ADS_REPORTING_REFRESH_TOKEN). Conversion upload is independent and already works via Data Manager.',
    });
  }

  let body = {};
  try { body = await request.json(); } catch (_) { body = {}; }
  const { dateFrom, dateTo } = resolveRange(body.date_from, body.date_to);

  const runStartedAt = Date.now();
  let status = 'ok';
  let errorMessage = null;
  let rowsUpserted = 0;

  try {
    const accessToken = await getAccessToken(env);
    const version = env.GOOGLE_ADS_API_VERSION || DEFAULT_API_VERSION;
    const customerId = digits(env.GOOGLE_ADS_CUSTOMER_ID);
    const loginCustomerId = digits(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID);

    // 1) Campaign-level spend/clicks/impressions per day → ad_spend (platform='google').
    const spendRows = await gaqlSearch(env, {
      accessToken, version, customerId, loginCustomerId,
      query:
        `SELECT segments.date, campaign.id, campaign.name, customer.currency_code, ` +
        `metrics.cost_micros, metrics.impressions, metrics.clicks ` +
        `FROM campaign ` +
        `WHERE segments.date BETWEEN '${dateFrom}' AND '${dateTo}' ` +
        `AND metrics.impressions > 0`,
    });

    // 2) Keyword-level performance per day → google_keyword_stats.
    const keywordRows = await gaqlSearch(env, {
      accessToken, version, customerId, loginCustomerId,
      query:
        `SELECT segments.date, campaign.id, campaign.name, ad_group.name, ` +
        `ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ` +
        `customer.currency_code, metrics.impressions, metrics.clicks, ` +
        `metrics.conversions, metrics.cost_micros ` +
        `FROM keyword_view ` +
        `WHERE segments.date BETWEEN '${dateFrom}' AND '${dateTo}' ` +
        `AND metrics.impressions > 0`,
    });

    rowsUpserted = await upsertSpend(env.DB, spendRows)
      + await upsertKeywords(env.DB, keywordRows);
  } catch (err) {
    status = 'error';
    errorMessage = err.message || String(err);
  }

  const durationMs = Date.now() - runStartedAt;
  const runAt = Math.floor(Date.now() / 1000);

  try {
    await env.DB.prepare(`
      INSERT INTO sync_log (platform, status, rows_upserted, date_from, date_to, error_message, duration_ms, run_at)
      VALUES ('google', ?, ?, ?, ?, ?, ?, ?)
    `).bind(status, rowsUpserted, dateFrom, dateTo, errorMessage, durationMs, runAt).run();
  } catch (_) { /* ignore */ }

  if (status === 'error') {
    return json({ ok: false, error: errorMessage, rows_upserted: rowsUpserted, duration_ms: durationMs }, 500);
  }
  return json({ ok: true, rows_upserted: rowsUpserted, duration_ms: durationMs, date_from: dateFrom, date_to: dateTo });
}

// -----------------------------------------------------------------------------
// Google Ads API helpers
// -----------------------------------------------------------------------------

// Exchange the long-lived refresh token (adwords scope) for a short-lived access
// token. Same OAuth dance as the Data Manager uploader, different refresh token.
async function getAccessToken(env) {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_ADS_CLIENT_ID,
      client_secret: env.GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: env.GOOGLE_ADS_REPORTING_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`OAuth token ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = await resp.json();
  if (!data.access_token) throw new Error('OAuth token response had no access_token');
  return data.access_token;
}

// Run a GAQL query via googleAds:search and follow nextPageToken to the end.
async function gaqlSearch(env, { accessToken, version, customerId, loginCustomerId, query }) {
  const url = `https://googleads.googleapis.com/${version}/customers/${customerId}/googleAds:search`;
  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'developer-token': env.GOOGLE_ADS_DEVELOPER_TOKEN,
    'Content-Type': 'application/json',
  };
  if (loginCustomerId) headers['login-customer-id'] = loginCustomerId;

  const all = [];
  let pageToken = null;
  let safety = 50; // guard against runaway pagination
  do {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(pageToken ? { query, pageToken } : { query }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Google Ads API ${resp.status}: ${text.slice(0, 400)}`);
    }
    const data = await resp.json();
    if (Array.isArray(data.results)) all.push(...data.results);
    pageToken = data.nextPageToken || null;
  } while (pageToken && safety-- > 0);

  return all;
}

// -----------------------------------------------------------------------------
// D1 upserts
// -----------------------------------------------------------------------------

async function upsertSpend(db, rows) {
  if (!db || rows.length === 0) return 0;
  const now = Math.floor(Date.now() / 1000);

  // Campaign-level (ad_id=''): the dashboard only needs Google totals + per-day,
  // so we don't break Google spend down to the ad level like Meta does.
  const stmt = db.prepare(`
    INSERT INTO ad_spend
      (platform, date, campaign_id, campaign_name, ad_id, ad_name, spend_cents, currency, impressions, clicks, synced_at)
    VALUES ('google', ?, ?, ?, '', '', ?, ?, ?, ?, ?)
    ON CONFLICT(platform, date, campaign_id, COALESCE(ad_id, ''))
    DO UPDATE SET
      campaign_name = excluded.campaign_name,
      spend_cents   = excluded.spend_cents,
      currency      = excluded.currency,
      impressions   = excluded.impressions,
      clicks        = excluded.clicks,
      synced_at     = excluded.synced_at
  `);

  const batch = rows.map(r => stmt.bind(
    r.segments?.date,
    String(r.campaign?.id || ''),
    r.campaign?.name || '',
    microsToCents(r.metrics?.costMicros),
    r.customer?.currencyCode || 'BRL',
    intOf(r.metrics?.impressions),
    intOf(r.metrics?.clicks),
    now,
  ));

  await db.batch(batch);
  return rows.length;
}

async function upsertKeywords(db, rows) {
  if (!db || rows.length === 0) return 0;
  const now = Math.floor(Date.now() / 1000);

  const stmt = db.prepare(`
    INSERT INTO google_keyword_stats
      (date, campaign_id, campaign_name, ad_group_name, keyword, match_type,
       impressions, clicks, conversions, spend_cents, currency, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, COALESCE(campaign_id, ''), keyword, COALESCE(match_type, ''))
    DO UPDATE SET
      campaign_name = excluded.campaign_name,
      ad_group_name = excluded.ad_group_name,
      impressions   = excluded.impressions,
      clicks        = excluded.clicks,
      conversions   = excluded.conversions,
      spend_cents   = excluded.spend_cents,
      currency      = excluded.currency,
      synced_at     = excluded.synced_at
  `);

  const batch = rows.map(r => stmt.bind(
    r.segments?.date,
    String(r.campaign?.id || ''),
    r.campaign?.name || '',
    r.adGroup?.name || '',
    r.adGroupCriterion?.keyword?.text || '(sem palavra-chave)',
    r.adGroupCriterion?.keyword?.matchType || '',
    intOf(r.metrics?.impressions),
    intOf(r.metrics?.clicks),
    floatOf(r.metrics?.conversions),
    microsToCents(r.metrics?.costMicros),
    r.customer?.currencyCode || 'BRL',
    now,
  ));

  await db.batch(batch);
  return rows.length;
}

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------

// Google returns money as micros (1 unit = 1,000,000 micros). cents = micros / 10_000.
function microsToCents(micros) {
  const n = parseInt(micros || '0', 10);
  return Math.round((Number.isFinite(n) ? n : 0) / 10000);
}
function intOf(v) { const n = parseInt(v || '0', 10); return Number.isFinite(n) ? n : 0; }
function floatOf(v) { const n = parseFloat(v || '0'); return Number.isFinite(n) ? n : 0; }
function digits(s) { return String(s || '').replace(/[^0-9]/g, ''); }

function resolveRange(dateFrom, dateTo) {
  const today = new Date();
  const fallbackFrom = addDays(today, -7);
  const from = isYmd(dateFrom) ? dateFrom : ymd(fallbackFrom);
  const to = isYmd(dateTo) ? dateTo : ymd(today);
  return { dateFrom: from, dateTo: to };
}
function isYmd(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
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
