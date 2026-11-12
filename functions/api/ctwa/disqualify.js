// POST /api/ctwa/disqualify?key=… — mark (or unmark) a CTWA contact as
// "Desqualificado" and send OrderCanceled to Meta for the exclusion audience.
// Body: { conversion_id, reason, note? }  reason: nao_respondeu | fora_do_perfil
//                                                  | sem_orcamento | outro
//       { conversion_id, undo: true }     clears the mark (an event already sent
//                                         to Meta stays there)
// Also mirrors the dashboard list: Desqualificado -> "Perdido" (a sale stays a sale).

import { guard, json, readJson } from '../../lib/ctwa-http.js';
import { DISQUALIFY_REASONS, disqualify, clearDisqualified } from '../../lib/ctwa-funnel.js';

export async function onRequestPost({ request, env }) {
  const denied = await guard(request, env);
  if (denied) return denied;

  const body = await readJson(request);
  if (!body) return json({ ok: false, error: 'invalid_json' }, 400);
  const conversionId = Number(body.conversion_id);
  if (!Number.isInteger(conversionId) || conversionId <= 0) return json({ ok: false, error: 'invalid_conversion_id' }, 400);

  const conv = await env.DB.prepare(
    'SELECT id, ctwa_clid, ad_id, sender_pn, wa_conversation_id, disqualified_status FROM ctwa_conversions WHERE id = ?',
  ).bind(conversionId).first();
  if (!conv) return json({ ok: false, error: 'conversion_not_found' }, 404);

  if (body.undo === true) {
    await clearDisqualified(env, { conv, markedBy: 'dashboard' });
    return json({ ok: true, disqualified: false });
  }

  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!DISQUALIFY_REASONS.includes(reason)) return json({ ok: false, error: 'invalid_reason', allowed: DISQUALIFY_REASONS }, 400);
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : null;

  const r = await disqualify(env, { conv, reason, note, source: 'manual', markedBy: 'dashboard' });
  return json({ ok: true, disqualified: true, reason, disqualified_status: r.status, attempts: r.attempts });
}
