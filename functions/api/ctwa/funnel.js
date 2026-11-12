// GET /api/ctwa/funnel?key=…&since=&until=&stage=&limit=&offset=
// KROB v0.3 clinic funnel for the /dashboard "Funil Meta" tab: CTWA clicks
// (ctwa_conversions) in the period, each with its current stage, plus the count
// per stage. since/until are unix ms on first_seen_at (until exclusive).
// stage: novo | respondeu | orcou | agendou | desqualificado.

import { guard, json, clampInt } from '../../lib/ctwa-http.js';
import { STAGE_SQL, STAGE_CASE } from '../../lib/ctwa-funnel.js';

export async function onRequestGet({ request, env }) {
  const denied = await guard(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const limit = clampInt(url.searchParams.get('limit'), 100, 1, 500);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
  const stage = url.searchParams.get('stage') || '';
  const since = Number(url.searchParams.get('since'));
  const until = Number(url.searchParams.get('until'));
  if (stage && !STAGE_SQL[stage]) return json({ error: 'invalid_stage' }, 400);

  const range = [];
  const params = [];
  if (Number.isFinite(since) && since > 0) { range.push('c.first_seen_at >= ?'); params.push(since); }
  if (Number.isFinite(until) && until > 0) { range.push('c.first_seen_at < ?'); params.push(until); }
  const where = stage ? [...range, `(${STAGE_SQL[stage]})`] : range;
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rangeSql = range.length ? `WHERE ${range.join(' AND ')}` : '';

  const [list, counts] = await Promise.all([
    env.DB.prepare(`
      SELECT c.id, c.first_seen_at, c.wa_conversation_id, c.sender_pn, c.sender_name, c.ad_id, c.ad_title,
             c.lead_status, c.lead_sent_at,
             c.replied_status, c.replied_sent_at, c.replied_source,
             c.qualified_lead_status, c.qualified_lead_sent_at,
             c.purchase_status, c.purchase_sent_at, c.purchase_value, c.purchase_currency,
             c.disqualified_at, c.disqualified_reason, c.disqualified_source, c.disqualified_status,
             ${STAGE_CASE} AS stage,
             mac.ad_name, mac.adset_name, mac.campaign_name
      FROM ctwa_conversions c LEFT JOIN meta_ads_cache mac ON mac.ad_id = c.ad_id
      ${whereSql} ORDER BY c.first_seen_at DESC LIMIT ? OFFSET ?`).bind(...params, limit, offset).all(),
    env.DB.prepare(`SELECT ${STAGE_CASE} AS stage, COUNT(*) AS n FROM ctwa_conversions c ${rangeSql} GROUP BY 1`)
      .bind(...params).all(),
  ]);

  const byStage = { novo: 0, respondeu: 0, orcou: 0, agendou: 0, desqualificado: 0 };
  let total = 0;
  for (const r of counts.results ?? []) { byStage[r.stage] = r.n; total += r.n; }
  return json({ rows: list.results ?? [], stages: byStage, total, limit, offset });
}
