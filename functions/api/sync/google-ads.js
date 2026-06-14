// POST /api/sync/google-ads
//
// Pulls Google Ads spend / clicks / impressions (into ad_spend, platform='google')
// and keyword-level performance (into google_keyword_stats) so the /dashboard can
// show Google investment, CPL and "palavras-chave de conversão". Meant to be
// called hourly by the cron Worker, exactly like /api/sync/meta-ads.
//
// INFRA STUB. Unlike conversion UPLOAD (Data Manager API, no dev token), READING
// reports requires the regular **Google Ads API** (GAQL) with a developer token
// and login-customer-id. So this stays dormant until those reporting creds are
// set. Required env (separate from the GOOGLE_ADS_* upload creds):
//   GOOGLE_ADS_DEVELOPER_TOKEN
//   GOOGLE_ADS_REPORTING_REFRESH_TOKEN  (scope https://www.googleapis.com/auth/adwords)
//   (reuses GOOGLE_ADS_CLIENT_ID / CLIENT_SECRET / CUSTOMER_ID / LOGIN_CUSTOMER_ID)
//
// Auth: header `x-sync-secret: <env.SYNC_SECRET>` (same as meta-ads sync).
//
// TODO(go-live): implement the GAQL queries:
//   1) campaign/ad spend  → SELECT segments.date, campaign.id, ad_group_ad.ad.id,
//        metrics.cost_micros, metrics.impressions, metrics.clicks FROM ad_group_ad
//   2) keywords           → SELECT segments.date, ad_group_criterion.keyword.text,
//        ad_group_criterion.keyword.match_type, metrics.clicks, metrics.conversions,
//        metrics.cost_micros FROM keyword_view
//   then UPSERT into ad_spend (platform='google') and google_keyword_stats.

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

  // Reporting credentials are present but the GAQL pull isn't implemented yet.
  // Log a no-op sync run so the dashboard shows the platform as "configured,
  // awaiting implementation" rather than silently absent.
  const runAt = Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(`
      INSERT INTO sync_log (platform, status, rows_upserted, date_from, date_to, error_message, duration_ms, run_at)
      VALUES ('google', 'error', 0, NULL, NULL, ?, 0, ?)
    `).bind('GAQL reporting pull not implemented yet', runAt).run();
  } catch (_) { /* ignore */ }

  return json({ ok: true, skipped: true, reason: 'GAQL reporting pull not implemented yet' });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
