// GET  /api/ctwa/rules?key=… — every auto-fire rule (newest first).
// POST /api/ctwa/rules?key=… — create one. Body: { event_type: 'qualified_lead'|'purchase',
//   pattern, direction?: 'in'|'out'|'any', case_sensitive?, value?, currency?, notes?, enabled? }

import { guard, json, readJson } from '../../lib/ctwa-http.js';
import { validateRuleFields } from '../../lib/ctwa-rules.js';

export async function onRequestGet({ request, env }) {
  const denied = await guard(request, env);
  if (denied) return denied;
  const rs = await env.DB.prepare('SELECT * FROM wa_auto_rules ORDER BY id DESC').all();
  return json({ rules: rs?.results ?? [], count: rs?.results?.length ?? 0 });
}

export async function onRequestPost({ request, env }) {
  const denied = await guard(request, env);
  if (denied) return denied;

  const body = await readJson(request);
  if (!body) return json({ ok: false, error: 'invalid_json' }, 400);
  const { rule, error } = validateRuleFields(body, env);
  if (error) return json({ ok: false, error }, 400);

  const res = await env.DB.prepare(`
    INSERT INTO wa_auto_rules (enabled, event_type, match_type, pattern, case_sensitive, direction, value, currency, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    rule.enabled, rule.event_type, rule.match_type, rule.pattern, rule.case_sensitive,
    rule.direction, rule.value, rule.currency, rule.notes, Date.now(),
  ).run();
  const row = await env.DB.prepare('SELECT * FROM wa_auto_rules WHERE id = ?').bind(res.meta.last_row_id).first();
  return json({ ok: true, rule: row }, 201);
}
