// POST /api/ctwa/fire-purchase?key=… — manual Purchase from /rastreador.
// Body: { conversion_id, value, currency?, order_id?, force? }. Refuses to re-fire an
// already-sent contact unless force:true. Also marks the linked dashboard
// conversation as a sale with that value (so revenue/ROAS see it).

import { guard, json, readJson } from '../../lib/ctwa-http.js';
import { firePurchase, syncFunnel } from '../../lib/ctwa-capi.js';

export async function onRequestPost({ request, env }) {
  const denied = await guard(request, env);
  if (denied) return denied;

  const body = await readJson(request);
  if (!body) return json({ ok: false, error: 'invalid_json' }, 400);
  const conversionId = Number(body.conversion_id);
  const value = Number(body.value);
  const currency = body.currency ? String(body.currency).trim().toUpperCase() : (env.META_CURRENCY || 'BRL');
  const orderId = body.order_id ? String(body.order_id).trim() : null;
  if (!Number.isInteger(conversionId) || conversionId <= 0) return json({ ok: false, error: 'invalid_conversion_id' }, 400);
  if (!Number.isFinite(value) || value <= 0) return json({ ok: false, error: 'invalid_value' }, 400);
  if (!/^[A-Z]{3}$/.test(currency)) return json({ ok: false, error: 'invalid_currency' }, 400);

  const conv = await env.DB.prepare(
    'SELECT id, ctwa_clid, sender_pn, wa_conversation_id, purchase_status FROM ctwa_conversions WHERE id = ?',
  ).bind(conversionId).first();
  if (!conv) return json({ ok: false, error: 'conversion_not_found' }, 404);
  if (conv.purchase_status === 'sent' && body.force !== true) {
    return json({ ok: false, error: 'already_sent', purchase_status: 'sent' }, 409);
  }

  const r = await firePurchase(env, {
    conversionId: conv.id, ctwaClid: conv.ctwa_clid, phone: conv.sender_pn, value, currency, orderId,
    eventTime: Math.floor(Date.now() / 1000),
  });
  await syncFunnel(env, conv.wa_conversation_id, {
    kind: 'sale', valueCents: Math.round(value * 100), currency, markedBy: 'rastreador',
  });

  return json({ ok: r.status === 'sent', purchase_status: r.status, attempts: r.attempts, value, currency },
    r.status === 'sent' ? 200 : 502);
}
