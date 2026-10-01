// GET /api/ctwa/conversions?key=… — CTWA clicks (ctwa_conversions) joined with the
// cached ad/adset/campaign names. Filters: lead_status, campaign_id, ad_id, since
// (unix ms), limit, offset.

import { guard, json, clampInt } from '../../lib/ctwa-http.js';

export async function onRequestGet({ request, env }) {
  const denied = await guard(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
  const leadStatus = url.searchParams.get('lead_status');
  const campaignId = url.searchParams.get('campaign_id');
  const adId = url.searchParams.get('ad_id');
  const since = Number(url.searchParams.get('since'));

  const where = [];
  const params = [];
  if (leadStatus) { where.push('c.lead_status = ?'); params.push(leadStatus); }
  if (campaignId) { where.push('mac.campaign_id = ?'); params.push(campaignId); }
  if (adId) { where.push('c.ad_id = ?'); params.push(adId); }
  if (Number.isFinite(since) && since > 0) { where.push('c.first_seen_at >= ?'); params.push(since); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [list, count, summary] = await Promise.all([
    env.DB.prepare(`
      SELECT c.id, c.ctwa_clid, c.first_seen_at, c.webhook_event_id, c.wa_conversation_id,
             c.sender_pn, c.sender_name, c.ad_id, c.ad_source_url, c.ad_title, c.ad_body,
             c.entry_point_app, c.entry_point_source,
             c.lead_status, c.lead_event_id, c.lead_sent_at, c.lead_attempts, c.lead_last_error,
             c.purchase_status, c.purchase_sent_at, c.purchase_value, c.purchase_currency,
             c.qualified_lead_status, c.qualified_lead_sent_at,
             mac.ad_name, mac.adset_id, mac.adset_name, mac.campaign_id, mac.campaign_name,
             mac.campaign_objective, mac.effective_status AS ad_effective_status
      FROM ctwa_conversions c LEFT JOIN meta_ads_cache mac ON mac.ad_id = c.ad_id
      ${whereSql} ORDER BY c.first_seen_at DESC LIMIT ? OFFSET ?`).bind(...params, limit, offset).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM ctwa_conversions c LEFT JOIN meta_ads_cache mac ON mac.ad_id = c.ad_id ${whereSql}`)
      .bind(...params).first(),
    env.DB.prepare('SELECT lead_status, COUNT(*) AS n FROM ctwa_conversions GROUP BY lead_status').all(),
  ]);

  const byStatus = {};
  for (const r of summary.results ?? []) byStatus[r.lead_status] = r.n;
  return json({ conversions: list.results ?? [], count: count?.n ?? 0, limit, offset, summary: byStatus });
}
