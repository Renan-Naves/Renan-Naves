// GET /api/ctwa/export?key=…&stage=&reason=&since=&until=
// CSV of contact phones for a Meta "customer list" Custom Audience: the sure
// route to an exclusion audience (Ads Manager -> Audiences -> Custom Audience ->
// Customer list -> upload). One column, `phone`, digits with country code; Meta
// hashes on upload. Downloaded by the dashboard user, never stored anywhere.

import { guard, json } from '../../lib/ctwa-http.js';
import { STAGE_SQL, DISQUALIFY_REASONS } from '../../lib/ctwa-funnel.js';

export async function onRequestGet({ request, env }) {
  const denied = await guard(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const stage = url.searchParams.get('stage');
  const reason = url.searchParams.get('reason');
  const since = Number(url.searchParams.get('since'));
  const until = Number(url.searchParams.get('until'));

  const where = ['c.sender_pn IS NOT NULL'];
  const params = [];
  if (stage) {
    if (!STAGE_SQL[stage]) return json({ error: 'invalid_stage' }, 400);
    where.push(`(${STAGE_SQL[stage]})`);
  }
  if (reason) {
    if (!DISQUALIFY_REASONS.includes(reason)) return json({ error: 'invalid_reason' }, 400);
    where.push('c.disqualified_reason = ?'); params.push(reason);
  }
  if (Number.isFinite(since) && since > 0) { where.push('c.first_seen_at >= ?'); params.push(since); }
  if (Number.isFinite(until) && until > 0) { where.push('c.first_seen_at < ?'); params.push(until); }

  const rs = await env.DB.prepare(`
    SELECT DISTINCT c.sender_pn AS phone FROM ctwa_conversions c
    WHERE ${where.join(' AND ')} ORDER BY c.sender_pn`).bind(...params).all();

  const lines = ['phone', ...(rs.results ?? []).map((r) => r.phone)];
  const day = new Date().toISOString().slice(0, 10);
  const name = `publico-${stage || 'todos'}${reason ? '-' + reason : ''}-${day}.csv`;
  return new Response(lines.join('\n') + '\n', {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'no-store',
    },
  });
}
