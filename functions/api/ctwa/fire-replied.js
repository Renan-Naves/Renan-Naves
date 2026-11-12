// POST /api/ctwa/fire-replied?key=… — manual "Respondeu" (ViewContent).
// Body: { conversion_id, force? }. Normally this stage fires by itself
// (lib/ctwa-funnel.js detectReply); the button covers a reply the webhook could
// not see. Refuses an already-sent contact unless force:true.

import { guard, json, readJson } from '../../lib/ctwa-http.js';
import { fireReplied } from '../../lib/ctwa-capi.js';

export async function onRequestPost({ request, env }) {
  const denied = await guard(request, env);
  if (denied) return denied;

  const body = await readJson(request);
  if (!body) return json({ ok: false, error: 'invalid_json' }, 400);
  const conversionId = Number(body.conversion_id);
  if (!Number.isInteger(conversionId) || conversionId <= 0) return json({ ok: false, error: 'invalid_conversion_id' }, 400);

  const conv = await env.DB.prepare(
    'SELECT id, ctwa_clid, sender_pn, ad_id, replied_status FROM ctwa_conversions WHERE id = ?',
  ).bind(conversionId).first();
  if (!conv) return json({ ok: false, error: 'conversion_not_found' }, 404);
  if (conv.replied_status === 'sent' && body.force !== true) {
    return json({ ok: false, error: 'already_sent', replied_status: 'sent' }, 409);
  }

  const r = await fireReplied(env, {
    conversionId: conv.id, ctwaClid: conv.ctwa_clid, adId: conv.ad_id, phone: conv.sender_pn,
    eventTime: Math.floor(Date.now() / 1000), source: 'manual',
  });
  return json({ ok: r.status === 'sent', replied_status: r.status, attempts: r.attempts },
    r.status === 'sent' ? 200 : 502);
}
