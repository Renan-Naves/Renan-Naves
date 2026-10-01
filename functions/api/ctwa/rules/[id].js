// PUT    /api/ctwa/rules/:id?key=… — partial update (merged over the row, re-validated whole).
// DELETE /api/ctwa/rules/:id?key=… — hard delete.

import { guard, json, readJson } from '../../../lib/ctwa-http.js';
import { validateRuleFields } from '../../../lib/ctwa-rules.js';

export async function onRequestPut({ request, env, params }) {
  const denied = await guard(request, env);
  if (denied) return denied;

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return json({ ok: false, error: 'invalid_id' }, 400);
  const patch = await readJson(request);
  if (!patch) return json({ ok: false, error: 'invalid_json' }, 400);

  const existing = await env.DB.prepare('SELECT * FROM wa_auto_rules WHERE id = ?').bind(id).first();
  if (!existing) return json({ ok: false, error: 'rule_not_found' }, 404);

  const merged = {
    event_type: patch.event_type ?? existing.event_type,
    match_type: patch.match_type ?? existing.match_type,
    pattern: patch.pattern ?? existing.pattern,
    case_sensitive: patch.case_sensitive ?? existing.case_sensitive,
    direction: patch.direction ?? existing.direction,
    value: patch.value ?? existing.value,
    currency: patch.currency ?? existing.currency,
    notes: patch.notes ?? existing.notes,
    enabled: patch.enabled ?? (existing.enabled === 1),
  };
  const { rule, error } = validateRuleFields(merged, env);
  if (error) return json({ ok: false, error }, 400);

  await env.DB.prepare(`
    UPDATE wa_auto_rules SET enabled=?, event_type=?, match_type=?, pattern=?, case_sensitive=?,
           direction=?, value=?, currency=?, notes=? WHERE id=?`).bind(
    rule.enabled, rule.event_type, rule.match_type, rule.pattern, rule.case_sensitive,
    rule.direction, rule.value, rule.currency, rule.notes, id,
  ).run();
  const row = await env.DB.prepare('SELECT * FROM wa_auto_rules WHERE id = ?').bind(id).first();
  return json({ ok: true, rule: row });
}

export async function onRequestDelete({ request, env, params }) {
  const denied = await guard(request, env);
  if (denied) return denied;

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return json({ ok: false, error: 'invalid_id' }, 400);
  const res = await env.DB.prepare('DELETE FROM wa_auto_rules WHERE id = ?').bind(id).run();
  if ((res.meta?.changes ?? 0) === 0) return json({ ok: false, error: 'rule_not_found' }, 404);
  return json({ ok: true });
}
