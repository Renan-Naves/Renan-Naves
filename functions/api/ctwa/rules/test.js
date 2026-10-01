// POST /api/ctwa/rules/test?key=… — dry-run a text against the enabled rules. Fires NOTHING.
// Body: { text, from_me?, phone? } → which rules match, whether the phone has a CTWA
// conversion, and what would actually fire after the per-contact guards.

import { guard, json, readJson } from '../../../lib/ctwa-http.js';
import { loadEnabledRules, matchRules, findConversionForPhone } from '../../../lib/ctwa-rules.js';
import { normalizePhone } from '../../../lib/ctwa-capi.js';

export async function onRequestPost({ request, env }) {
  const denied = await guard(request, env);
  if (denied) return denied;

  const body = await readJson(request);
  if (!body) return json({ ok: false, error: 'invalid_json' }, 400);
  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) return json({ ok: false, error: 'text_required' }, 400);
  const fromMe = body.from_me === true || body.from_me === 1 ? 1 : 0;

  const rules = await loadEnabledRules(env);
  const matches = matchRules(rules, { text, fromMe });
  const phone = normalizePhone(body.phone, env.DEFAULT_COUNTRY_CODE);
  const conv = phone ? await findConversionForPhone(env, phone) : null;

  const firstPerType = {};
  for (const r of matches) firstPerType[r.event_type] ??= r;
  const wouldFire = Object.values(firstPerType).map((rule) => {
    let blocked = null;
    if (conv) {
      const s = rule.event_type === 'qualified_lead' ? conv.qualified_lead_status : conv.purchase_status;
      if (s === 'sent' || s === 'sending') blocked = `already_${s}`;
    }
    return { rule_id: rule.id, event_type: rule.event_type, value: rule.value, currency: rule.currency, blocked_by_guard: blocked };
  });

  return json({
    ok: true,
    enabled_rules: rules.length,
    matches: matches.map((r) => ({ id: r.id, event_type: r.event_type, pattern: r.pattern, direction: r.direction })),
    conversion_found: conv ? { id: conv.id, ctwa_clid: conv.ctwa_clid } : null,
    would_fire: wouldFire,
  });
}
