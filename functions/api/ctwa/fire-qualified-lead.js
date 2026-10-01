// POST /api/ctwa/fire-qualified-lead?key=… — manual QualifiedLead from /rastreador.
// Body: { conversion_id, force? }. Refuses to re-fire an already-sent contact unless
// force:true. Also marks the linked dashboard conversation as qualified.

import { guard, json, readJson } from '../../lib/ctwa-http.js';
import { fireQualifiedLead, syncFunnel } from '../../lib/ctwa-capi.js';

export async function onRequestPost({ request, env }) {
  const denied = await guard(request, env);
  if (denied) return denied;

  const body = await readJson(request);
  if (!body) return json({ ok: false, error: 'invalid_json' }, 400);
  const conversionId = Number(body.conversion_id);
  if (!Number.isInteger(conversionId) || conversionId <= 0) return json({ ok: false, error: 'invalid_conversion_id' }, 400);

  const conv = await env.DB.prepare(
    'SELECT id, ctwa_clid, sender_pn, ad_id, wa_conversation_id, qualified_lead_status FROM ctwa_conversions WHERE id = ?',
  ).bind(conversionId).first();
  if (!conv) return json({ ok: false, error: 'conversion_not_found' }, 404);
  if (conv.qualified_lead_status === 'sent' && body.force !== true) {
    return json({ ok: false, error: 'already_sent', qualified_lead_status: 'sent' }, 409);
  }

  const r = await fireQualifiedLead(env, {
    conversionId: conv.id, ctwaClid: conv.ctwa_clid, adId: conv.ad_id, phone: conv.sender_pn,
    eventTime: Math.floor(Date.now() / 1000),
  });
  await syncFunnel(env, conv.wa_conversation_id, { kind: 'qualified', markedBy: 'rastreador' });

  return json({ ok: r.status === 'sent', qualified_lead_status: r.status, attempts: r.attempts },
    r.status === 'sent' ? 200 : 502);
}
