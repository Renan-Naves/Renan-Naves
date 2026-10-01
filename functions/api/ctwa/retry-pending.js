// POST /api/ctwa/retry-pending?key=… — manual flush (no cron), the "Reenviar pendentes"
// button in /rastreador. Three steps, all idempotent:
//   1. import: every wa_conversations row with a ctwa_clid that has no ctwa_conversions
//      row yet (conversations captured before the tracker existed). Clicks older than
//      Meta's 7-day CTWA window come in as 'expired' — they can't take a Lead anymore.
//   2. re-fire LeadSubmitted for every conversion not yet 'sent' (inside the window;
//      outside it they're marked 'expired' instead of being sent).
//   3. enrich ad_ids missing/stale in meta_ads_cache.

import { guard, json } from '../../lib/ctwa-http.js';
import { fireLead, enrichAdIfStale, conversionForWaConversation, isWithinCtwaWindow } from '../../lib/ctwa-capi.js';

const RETRY_LIMIT = 50;
const ENRICH_LIMIT = 50;

export async function onRequestPost({ request, env }) {
  const denied = await guard(request, env);
  if (denied) return denied;

  const result = { imported: 0, leads_retried: 0, leads_sent: 0, expired: 0, ads_enriched: 0, errors: [] };

  // 1. import pre-tracker CTWA conversations
  try {
    const missing = await env.DB.prepare(`
      SELECT w.* FROM wa_conversations w
      LEFT JOIN ctwa_conversions c ON c.ctwa_clid = w.ctwa_clid
      WHERE w.ctwa_clid IS NOT NULL AND w.ctwa_clid != '' AND w.deleted_at IS NULL AND c.id IS NULL
      LIMIT 200`).all();
    for (const w of missing.results ?? []) {
      try { await conversionForWaConversation(env, w); result.imported++; }
      catch (err) { result.errors.push(`import ${w.id}: ${err?.message ?? err}`); }
    }
  } catch (err) {
    result.errors.push(`import_query: ${err?.message ?? err}`);
  }

  // 2. re-fire Leads that never reached 'sent'
  try {
    const pending = await env.DB.prepare(`
      SELECT id, ctwa_clid, ad_id, sender_pn, first_seen_at FROM ctwa_conversions
      WHERE lead_status IN ('pending','failed','skipped_no_creds','sending')
      ORDER BY first_seen_at ASC LIMIT ?`).bind(RETRY_LIMIT).all();
    for (const c of pending.results ?? []) {
      if (!isWithinCtwaWindow(c.first_seen_at)) {
        await env.DB.prepare("UPDATE ctwa_conversions SET lead_status='expired', lead_last_error='fora da janela de 7 dias do CTWA' WHERE id = ?")
          .bind(c.id).run();
        result.expired++;
        continue;
      }
      try {
        const r = await fireLead(env, {
          conversionId: c.id, ctwaClid: c.ctwa_clid, adId: c.ad_id, phone: c.sender_pn,
          eventTime: Math.floor(Number(c.first_seen_at) / 1000),
        });
        result.leads_retried++;
        if (r.status === 'sent') result.leads_sent++;
        else result.errors.push(`lead ${c.id}: ${r.status} ${String(r.response?.body || '').slice(0, 160)}`);
      } catch (err) {
        result.errors.push(`lead ${c.id}: ${err?.message ?? err}`);
      }
    }
  } catch (err) {
    result.errors.push(`retry_query: ${err?.message ?? err}`);
  }

  // 3. enrich ad names
  try {
    const stale = await env.DB.prepare(`
      SELECT DISTINCT c.ad_id FROM ctwa_conversions c LEFT JOIN meta_ads_cache mac ON mac.ad_id = c.ad_id
      WHERE c.ad_id IS NOT NULL AND (mac.ad_id IS NULL OR mac.expires_at <= ?) LIMIT ?`)
      .bind(Date.now(), ENRICH_LIMIT).all();
    for (const r of stale.results ?? []) {
      const e = await enrichAdIfStale(env, r.ad_id).catch((err) => ({ ok: false, body: String(err?.message ?? err) }));
      if (e.ok) result.ads_enriched++;
      else result.errors.push(`enrich ${r.ad_id}: ${e.status ?? ''} ${String(e.body || '').slice(0, 150)}`);
    }
  } catch (err) {
    result.errors.push(`enrich_query: ${err?.message ?? err}`);
  }

  return json(result);
}
