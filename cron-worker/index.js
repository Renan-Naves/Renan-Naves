// Cloudflare cron Worker — hourly Meta Ads spend sync.
//
// This Worker does ONE thing: every hour it POSTs to the Pages project's
// /api/sync/meta-ads endpoint, which pulls fresh ad-level spend from the Meta
// Marketing API into the `ad_spend` D1 table. The /dashboard page then reads
// that table directly.
//
// It is a separate Worker only because Cloudflare Pages has no native cron
// trigger — only Workers do. It serves no pages and sets no cookies, so it
// does NOT "split" the tracking stack (which must stay same-origin for the
// first-party cookies); it is purely a scheduler.
//
// Config (see cron-worker/README.md):
//   SYNC_URL     [var]    full URL of the sync endpoint, e.g.
//                         https://<your-domain>/api/sync/meta-ads
//   SYNC_SECRET  [secret] must match the SYNC_SECRET env var on the Pages
//                         project — set with `wrangler secret put SYNC_SECRET`

export default {
  // Fires on the cron schedule in wrangler.toml ("0 * * * *" = hourly).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSync(env));
  },

  // Manual trigger for testing. Gated by the same secret so the Worker URL
  // can't be abused to burn Meta API quota; without it the Worker looks dead.
  async fetch(request, env) {
    const url = new URL(request.url);
    const provided = request.headers.get('x-sync-secret') || url.searchParams.get('secret') || '';
    if (!env.SYNC_SECRET || provided !== env.SYNC_SECRET) {
      return new Response('Not found', { status: 404 });
    }
    const result = await runSync(env);
    return new Response(JSON.stringify(result, null, 2), {
      status: result.ok ? 200 : 502,
      headers: { 'content-type': 'application/json' },
    });
  },
};

async function runSync(env) {
  if (!env.SYNC_URL || !env.SYNC_SECRET) {
    return { ok: false, error: 'SYNC_URL and SYNC_SECRET must be configured' };
  }
  try {
    const res = await fetch(env.SYNC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-sync-secret': env.SYNC_SECRET,
      },
      body: '{}', // empty body → endpoint defaults to the last 7 days
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch (_) { body = { raw: text.slice(0, 500) }; }

    if (!res.ok) {
      console.error('meta-ads sync failed', res.status, text.slice(0, 300));
      return { ok: false, status: res.status, body };
    }
    console.log('meta-ads sync ok', JSON.stringify(body));
    return { ok: true, status: res.status, body };
  } catch (err) {
    console.error('meta-ads sync error', err && err.message);
    return { ok: false, error: (err && err.message) || String(err) };
  }
}
