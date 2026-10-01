// functions/lib/ctwa-rules.js
//
// Auto-fire rules (KROB stack v0.2, lib/rules.js): "if a message contains <phrase>,
// fire QualifiedLead / Purchase". Evaluated on every 1:1 message the uazapi webhook
// captures, inside waitUntil() (never delays the webhook's 200). A match fires
// against the contact's most recent CTWA conversion and mirrors the mark onto the
// dashboard funnel (wa_conversations), exactly like a manual mark. Manual-first:
// wa_auto_rules starts empty; rules are added in /rastreador → Regras.

import { fireQualifiedLead, firePurchase, syncFunnel } from './ctwa-capi.js';

export async function loadEnabledRules(env) {
  const rs = await env.DB.prepare('SELECT * FROM wa_auto_rules WHERE enabled = 1 ORDER BY id').all();
  return rs?.results ?? [];
}

// Pure: the rules whose phrase + direction match this message.
export function matchRules(rules, { text, fromMe }) {
  if (!text || typeof text !== 'string') return [];
  return (rules ?? []).filter((r) => {
    if (!r?.pattern || r.match_type !== 'contains') return false;
    if (r.direction === 'in' && fromMe) return false;
    if (r.direction === 'out' && !fromMe) return false;
    const hay = r.case_sensitive ? text : text.toLowerCase();
    const needle = r.case_sensitive ? r.pattern : r.pattern.toLowerCase();
    return hay.includes(needle);
  });
}

// Most recent CTWA conversion for this contact (phone = normalized digits).
export async function findConversionForPhone(env, phone) {
  if (!phone) return null;
  return env.DB.prepare(`
    SELECT id, ctwa_clid, sender_pn, ad_id, wa_conversation_id, qualified_lead_status, purchase_status
    FROM ctwa_conversions WHERE sender_pn = ? ORDER BY first_seen_at DESC LIMIT 1
  `).bind(phone).first();
}

// load → match → guard → dispatch. At most one QualifiedLead and one Purchase per
// message (lowest rule id wins); a contact already sent/sending is skipped.
export async function evaluateAutoRules(env, { text, contactPhone, fromMe, eventTime }) {
  const summary = { matched: 0, fired: [], skipped: [] };
  const rules = await loadEnabledRules(env);
  if (!rules.length) return summary;
  const matched = matchRules(rules, { text, fromMe });
  summary.matched = matched.length;
  if (!matched.length) return summary;

  const conv = await findConversionForPhone(env, contactPhone);
  if (!conv?.ctwa_clid) { summary.skipped.push({ reason: 'no_conversion' }); return summary; }

  const firstPerType = {};
  for (const r of matched) firstPerType[r.event_type] ??= r;

  for (const rule of Object.values(firstPerType)) {
    const markedBy = `regra #${rule.id}`;
    if (rule.event_type === 'qualified_lead') {
      if (conv.qualified_lead_status === 'sent' || conv.qualified_lead_status === 'sending') {
        summary.skipped.push({ rule_id: rule.id, reason: `already_${conv.qualified_lead_status}` });
        continue;
      }
      const r = await fireQualifiedLead(env, {
        conversionId: conv.id, ctwaClid: conv.ctwa_clid, adId: conv.ad_id, phone: conv.sender_pn, eventTime,
      });
      if (r.status === 'sent') await bumpFiredCount(env, rule.id);
      await syncFunnel(env, conv.wa_conversation_id, { kind: 'qualified', markedBy });
      summary.fired.push({ rule_id: rule.id, event_type: rule.event_type, status: r.status });
    } else if (rule.event_type === 'purchase') {
      if (conv.purchase_status === 'sent' || conv.purchase_status === 'sending') {
        summary.skipped.push({ rule_id: rule.id, reason: `already_${conv.purchase_status}` });
        continue;
      }
      const value = Number(rule.value);
      if (!(value > 0)) { summary.skipped.push({ rule_id: rule.id, reason: 'no_value' }); continue; }
      const currency = rule.currency || env.META_CURRENCY || 'BRL';
      const r = await firePurchase(env, {
        conversionId: conv.id, ctwaClid: conv.ctwa_clid, phone: conv.sender_pn, value, currency, eventTime,
      });
      if (r.status === 'sent') await bumpFiredCount(env, rule.id);
      await syncFunnel(env, conv.wa_conversation_id, { kind: 'sale', valueCents: Math.round(value * 100), currency, markedBy });
      summary.fired.push({ rule_id: rule.id, event_type: rule.event_type, status: r.status });
    }
  }
  return summary;
}

async function bumpFiredCount(env, ruleId) {
  await env.DB.prepare('UPDATE wa_auto_rules SET fired_count = fired_count + 1, last_fired_at = ? WHERE id = ?')
    .bind(Date.now(), ruleId).run();
}

// Validate a full set of rule fields (create, or existing row merged with a patch).
export function validateRuleFields(body, env) {
  const eventType = body?.event_type;
  if (eventType !== 'qualified_lead' && eventType !== 'purchase') return { error: 'invalid_event_type' };
  const matchType = body?.match_type ?? 'contains';
  if (matchType !== 'contains') return { error: 'unsupported_match_type' };
  const pattern = typeof body?.pattern === 'string' ? body.pattern.trim() : '';
  if (pattern.length < 2) return { error: 'pattern_too_short' };
  const direction = body?.direction ?? 'any';
  if (!['in', 'out', 'any'].includes(direction)) return { error: 'invalid_direction' };

  let value = null;
  let currency = null;
  if (eventType === 'purchase') {
    value = Number(body?.value);
    if (!Number.isFinite(value) || value <= 0) return { error: 'purchase_requires_value' };
    currency = typeof body?.currency === 'string' && body.currency.trim()
      ? body.currency.trim().toUpperCase() : (env.META_CURRENCY || 'BRL');
    if (!/^[A-Z]{3}$/.test(currency)) return { error: 'invalid_currency' };
  }
  const notes = typeof body?.notes === 'string' && body.notes.trim() ? body.notes.trim().slice(0, 500) : null;
  return {
    rule: {
      enabled: body?.enabled === false || body?.enabled === 0 ? 0 : 1,
      event_type: eventType, match_type: matchType, pattern,
      case_sensitive: body?.case_sensitive === true || body?.case_sensitive === 1 ? 1 : 0,
      direction, value, currency, notes,
    },
  };
}
