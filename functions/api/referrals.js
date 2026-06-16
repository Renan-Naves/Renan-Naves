// GET /api/referrals?key=<DASH_KEY>
//
// The referral graph for the main dashboard: one row per referred patient
// (indicado), joined to WHO referred them (indicador). All-time, no date range —
// the goal is to track every referral from the start and see who generates the
// most business through indicações.
//
// Each line carries both sides + their revenue, e.g.:
//   "Paulo (Google Ads, R$1200)  →  indicou  Ana (R$700)"
//
// How it's built:
//   * group every non-deleted conversation by WhatsApp number (dedup: oldest
//     record wins the name; revenue = sum of that number's sales);
//   * a referral = any number with a conversation tagged origin 'indicacao';
//   * the indicador is resolved from referral_by_phone (cross-referenced against
//     the base for THEIR origin + revenue), falling back to referral_by_name;
//   * rows are sorted alphabetically by the indicador's name.
//
// Auth: ?key=<DASH_KEY>.

import { resolveOrigin, originLabel } from '../origins.js';

const PAID_ORIGINS = new Set(['google-ads', 'meta-ads']);

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!env.DASH_KEY || key !== env.DASH_KEY) {
    return json({ error: 'Unauthorized' }, 401);
  }

  let rows;
  try {
    const r = await env.DB.prepare(`
      SELECT w.id, w.wa_phone, w.wa_contact_name, w.referral_name,
             w.referral_by_name, w.referral_by_phone, w.manual_origin,
             w.platform, w.link_method, w.gclid, w.ctwa_clid, w.session_id,
             w.utm_source, w.status, w.is_qualified, w.sale_value_cents, w.created_at,
             s.referrer AS s_referrer, s.utm_source AS s_utm_source, s.gclid AS s_gclid
      FROM wa_conversations w
      LEFT JOIN sessions s ON w.session_id = s.session_id
      WHERE w.deleted_at IS NULL
      ORDER BY w.created_at ASC
    `).all();
    rows = r.results || [];
  } catch (_) {
    // tables/columns not migrated yet → empty list, not an error
    return json({ count: 0, total_referred_revenue: 0, referrals: [], pending_migration: true });
  }

  // --- group every conversation by WhatsApp number ---
  const groups = new Map();
  for (const r of rows) {
    const phone = String(r.wa_phone || '').replace(/\D/g, '');
    const keyp = phone || `id:${r.id}`;
    if (!groups.has(keyp)) groups.set(keyp, []);
    groups.get(keyp).push(r);
  }

  // aggregate per number → { id(oldest), name, revenue, status, origin }
  const byPhone = new Map();
  for (const [phone, group] of groups) {
    group.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
    byPhone.set(phone, aggregate(group));
  }

  // --- build one referral row per indicado number ---
  const referrals = [];
  for (const [phone, group] of groups) {
    if (!group.some(r => r.manual_origin === 'indicacao')) continue;
    const indicado = byPhone.get(phone);

    // indicador info from the tagged record(s) — earliest non-empty wins
    const byName = firstNonEmpty(group, 'referral_by_name');
    const byPhoneDigits = (firstNonEmpty(group, 'referral_by_phone') || '').replace(/\D/g, '');
    const indicadorAgg = byPhoneDigits ? byPhone.get(byPhoneDigits) : null;

    const indicador = {
      name: byName || (indicadorAgg ? indicadorAgg.name : '') || '(não informado)',
      phone: byPhoneDigits ? maskPhone(byPhoneDigits) : '',
      linked: !!indicadorAgg,                                   // matched a patient record?
      origin: indicadorAgg ? indicadorAgg.origin : null,
      origin_label: indicadorAgg ? originLabel(indicadorAgg.origin) : null,
      revenue: indicadorAgg ? indicadorAgg.revenue : null,
    };

    referrals.push({
      indicado: {
        id: indicado.id, name: indicado.name, phone: maskPhone(phone),
        revenue: indicado.revenue, status: indicado.status, conflict: indicado.conflict,
      },
      indicador,
      // sort key: indicador name (blanks last)
      _sort: (indicador.name && indicador.name !== '(não informado)') ? indicador.name.toLowerCase() : '￿',
    });
  }

  referrals.sort((a, b) => a._sort.localeCompare(b._sort, 'pt-BR', { sensitivity: 'base' }));
  referrals.forEach(r => { delete r._sort; });

  const totalReferredRevenue = referrals.reduce((s, r) => s + (r.indicado.revenue || 0), 0);
  return json({ count: referrals.length, total_referred_revenue: totalReferredRevenue, referrals });
}

// Consolidate one phone's conversations into a single patient view.
function aggregate(group) {
  const oldest = group[0];
  const typed = group.find(r => r.referral_name && r.referral_name.trim());
  const name = (typed && typed.referral_name.trim()) || (oldest.wa_contact_name || '').trim() || '(sem nome)';

  let revenueCents = 0, sales = 0, qualified = false;
  for (const r of group) {
    if (r.status === 'sale') { sales += 1; revenueCents += r.sale_value_cents || 0; }
    if (r.is_qualified) qualified = true;
  }
  const status = sales > 0 ? 'sale' : (qualified ? 'qualified' : (oldest.status || 'new'));

  // canonical acquisition origin: a paid/tracked signal wins, else first clear origin
  let origin = 'outro';
  let conflict = false;
  let best = null;
  for (const r of group) {
    const raw = resolveOrigin({
      utm_source: r.utm_source || r.s_utm_source, gclid: r.gclid || r.s_gclid,
      ctwa_clid: r.ctwa_clid, referrer: r.s_referrer,
    });
    const tracked = PAID_ORIGINS.has(raw) || !!(r.gclid || r.s_gclid || r.ctwa_clid || r.session_id);
    if (tracked) conflict = true;
    const withManual = resolveOrigin({
      manual_origin: r.manual_origin, utm_source: r.utm_source || r.s_utm_source,
      gclid: r.gclid || r.s_gclid, ctwa_clid: r.ctwa_clid, referrer: r.s_referrer,
    });
    if (PAID_ORIGINS.has(withManual)) { best = withManual; break; }
    if (!best || (best === 'outro' && withManual !== 'outro')) best = withManual;
  }
  origin = best || 'outro';
  // conflict only matters when the patient is ALSO manually tagged indicação
  conflict = conflict && group.some(r => r.manual_origin === 'indicacao');

  return { id: oldest.id, name, revenue: revenueCents / 100, status, origin, conflict };
}

function firstNonEmpty(group, field) {
  for (const r of group) { const v = (r[field] || '').trim(); if (v) return v; }
  return '';
}

function maskPhone(p) {
  if (!p) return '';
  const d = String(p).replace(/\D/g, '');
  if (d.length < 4) return d;
  return d.slice(0, -4).replace(/\d/g, '•') + d.slice(-4);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
