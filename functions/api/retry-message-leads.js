// POST /api/retry-message-leads?key=...
//
// Re-sends to Google Ads the message-level Leads whose every attempt failed
// (conversion_fires, event_name 'Lead', platform 'google', no ok row) — e.g. the
// messages that arrived while 'Lead WhatsApp - Mensagem' was still propagating
// after it was created. Idempotent: a gclid that already has an ok row is never
// sent again, and Google dedups on the gclid-derived transaction id.
//
// Auth: ?key=<DASH_KEY>.

import { retryFailedMessageLeads } from '../lib/google-message-lead.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (!env.DASH_KEY || url.searchParams.get('key') !== env.DASH_KEY) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const results = await retryFailedMessageLeads(env);
  return json({
    retried: results.length,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok && !r.skipped).length,
    statuses: [...new Set(results.map((r) => r.status))],
  });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
