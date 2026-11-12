// functions/lib/ctwa-rules.js
//
// Auto-fire rules (KROB stack v0.3, lib/rules.js): "if a message contains
// <phrase>, mark the contact". Evaluated on every 1:1 text message the uazapi
// webhook captures, inside waitUntil() (never delays the webhook's 200). A match
// acts on the contact's most recent CTWA conversion and mirrors the mark onto the
// dashboard funnel (wa_conversations), exactly like a manual mark.
//
// Rule types:
//   replied        -> Respondeu      (ViewContent)
//   qualified_lead -> Orcou          (QualifiedLead)
//   purchase       -> Agendou        (Purchase, fixed value)
//   disqualified   -> Desqualificado (OrderCanceled, with a reason)
//   auto_message   -> fires nothing: marks the clinic's greeting / out-of-hours
//                     text so it doesn't count as "the clinic answered"
// Manual-first: wa_auto_rules starts empty.

import { fireQualifiedLead, firePurchase, fireReplied, syncFunnel } from './ctwa-capi.js';
import { DISQUALIFY_REASONS, disqualify } from './ctwa-funnel.js';

export const RULE_EVENT_TYPES = ['replied', 'qualified_lead', 'purchase', 'disqualified', 'auto_message'];

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
    SELECT id, ctwa_clid, sender_pn, ad_id, wa_conversation_id, qualified_lead_status, purchase_status,
           replied_status, disqualified_at, disqualified_status
    FROM ctwa_conversions WHERE sender_pn = ? ORDER BY first_seen_at DESC LIMIT 1
  `).bind(phone).first();
}

const busy = (s) => s === 'sent' || s === 'sending';

// Why this rule can't fire for this contact now, or null.
export function ruleBlockedBy(eventType, conv) {
  if (eventType === 'replied') {
    if (busy(conv.replied_status)) return `already_${conv.replied_status}`;
    return conv.disqualified_at ? 'disqualified' : null;
  }
  if (eventType === 'qualified_lead') {
    if (busy(conv.qualified_lead_status)) return `already_${conv.qualified_lead_status}`;
    return conv.disqualified_at ? 'disqualified' : null;
  }
  if (eventType === 'purchase') return busy(conv.purchase_status) ? `already_${conv.purchase_status}` : null;
  if (eventType === 'disqualified') return conv.disqualified_at ? 'already_disqualified' : null;
  if (eventType === 'auto_message') return 'auto_message';
  return 'unknown_event_type';
}

// load -> match -> guard -> dispatch. At most one fire per event type per message
// (lowest rule id wins). Disqualified runs first, so a message that disqualifies
// also blocks the Respondeu/Orcou rules it matched.
export async function evaluateAutoRules(env, { text, contactPhone, fromMe, eventTime }) {
  const summary = { matched: 0, fired: [], skipped: [] };
  const rules = await loadEnabledRules(env);
  if (!rules.length) return summary;
  const matched = matchRules(rules, { text, fromMe });
  summary.matched = matched.length;
  if (!matched.length) return summary;

  // The clinic's automatic message: counted, nothing else fires on it.
  const auto = matched.find((r) => r.event_type === 'auto_message');
  if (auto) {
    await bumpFiredCount(env, auto.id);
    summary.auto_message = auto.id;
    return summary;
  }

  const conv = await findConversionForPhone(env, contactPhone);
  if (!conv?.ctwa_clid) { summary.skipped.push({ reason: 'no_conversion' }); return summary; }

  const firstPerType = {};
  for (const r of matched) firstPerType[r.event_type] ??= r;
  const ordered = Object.values(firstPerType)
    .sort((a, b) => (b.event_type === 'disqualified') - (a.event_type === 'disqualified'));

  for (const rule of ordered) {
    const blocked = ruleBlockedBy(rule.event_type, conv);
    if (blocked) { summary.skipped.push({ rule_id: rule.id, reason: blocked }); continue; }
    const markedBy = `regra #${rule.id}`;
    const base = { conversionId: conv.id, ctwaClid: conv.ctwa_clid, phone: conv.sender_pn, eventTime };
    let status;

    if (rule.event_type === 'replied') {
      ({ status } = await fireReplied(env, { ...base, adId: conv.ad_id, source: 'rule' }));
    } else if (rule.event_type === 'qualified_lead') {
      ({ status } = await fireQualifiedLead(env, { ...base, adId: conv.ad_id }));
      await syncFunnel(env, conv.wa_conversation_id, { kind: 'qualified', markedBy });
    } else if (rule.event_type === 'purchase') {
      const value = Number(rule.value);
      if (!(value > 0)) { summary.skipped.push({ rule_id: rule.id, reason: 'no_value' }); continue; }
      const currency = rule.currency || env.META_CURRENCY || 'BRL';
      ({ status } = await firePurchase(env, { ...base, value, currency }));
      await syncFunnel(env, conv.wa_conversation_id, { kind: 'sale', valueCents: Math.round(value * 100), currency, markedBy });
    } else if (rule.event_type === 'disqualified') {
      ({ status } = await disqualify(env, {
        conv, reason: rule.reason || 'outro', note: `regra #${rule.id}: "${rule.pattern}"`,
        source: 'rule', markedBy, eventTime,
      }));
      conv.disqualified_at = Date.now();
    } else {
      continue;
    }
    if (status === 'sent') await bumpFiredCount(env, rule.id);
    summary.fired.push({ rule_id: rule.id, event_type: rule.event_type, status });
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
  if (!RULE_EVENT_TYPES.includes(eventType)) return { error: 'invalid_event_type' };
  const matchType = body?.match_type ?? 'contains';
  if (matchType !== 'contains') return { error: 'unsupported_match_type' };
  const pattern = typeof body?.pattern === 'string' ? body.pattern.trim() : '';
  if (pattern.length < 2) return { error: 'pattern_too_short' };
  // an automatic message is always one the clinic sent
  const direction = eventType === 'auto_message' ? 'out' : (body?.direction ?? 'any');
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
  let reason = null;
  if (eventType === 'disqualified') {
    reason = typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'outro';
    if (!DISQUALIFY_REASONS.includes(reason)) return { error: 'invalid_reason' };
  }
  const notes = typeof body?.notes === 'string' && body.notes.trim() ? body.notes.trim().slice(0, 500) : null;
  return {
    rule: {
      enabled: body?.enabled === false || body?.enabled === 0 ? 0 : 1,
      event_type: eventType, match_type: matchType, pattern,
      case_sensitive: body?.case_sensitive === true || body?.case_sensitive === 1 ? 1 : 0,
      direction, value, currency, reason, notes,
    },
  };
}
