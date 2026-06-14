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
//   SYNC_URL         [var]    full URL of the Meta sync endpoint, e.g.
//                             https://<your-domain>/api/sync/meta-ads
//   SYNC_URL_GOOGLE  [var]    OPTIONAL — full URL of the Google sync endpoint,
//                             https://<your-domain>/api/sync/google-ads. If unset,
//                             only Meta is synced. The Google endpoint self-skips
//                             until its reporting creds are set, so it's safe to
//                             point at it before those exist.
//   SYNC_SECRET      [secret] must match the SYNC_SECRET env var on the Pages
//                             project — set with `wrangler secret put SYNC_SECRET`

export default {
  // Fires on the cron schedule in wrangler.toml ("0 * * * *" = hourly).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAll(env));
  },

  // Manual trigger for testing. Gated by the same secret so the Worker URL
  // can't be abused to burn ad-platform API quota; without it the Worker looks dead.
  async fetch(request, env) {
    const url = new URL(request.url);
    const provided = request.headers.get('x-sync-secret') || url.searchParams.get('secret') || '';
    if (!env.SYNC_SECRET || provided !== env.SYNC_SECRET) {
      return new Response('Not found', { status: 404 });
    }
    const result = await runAll(env);
    return new Response(JSON.stringify(result, null, 2), {
      status: result.ok ? 200 : 502,
      headers: { 'content-type': 'application/json' },
    });
  },
};

// Sync every configured platform. Each runs independently so one platform's
// failure doesn't block the other; overall ok = every attempted sync was ok.
async function runAll(env) {
  if (!env.SYNC_SECRET) {
    return { ok: false, error: 'SYNC_SECRET must be configured' };
  }
  const targets = [
    { label: 'meta', url: env.SYNC_URL },
    { label: 'google', url: env.SYNC_URL_GOOGLE },
  ].filter(t => t.url);

  if (targets.length === 0) {
    return { ok: false, error: 'At least one of SYNC_URL / SYNC_URL_GOOGLE must be configured' };
  }

  const results = {};
  let ok = true;
  for (const t of targets) {
    const r = await runSync(env, t.url, t.label);
    results[t.label] = r;
    if (!r.ok) ok = false;
  }
  return { ok, results };
}

async function runSync(env, url, label) {
  try {
    const res = await fetch(url, {
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
      console.error(`${label}-ads sync failed`, res.status, text.slice(0, 300));
      return { ok: false, status: res.status, body };
    }
    console.log(`${label}-ads sync ok`, JSON.stringify(body));
    return { ok: true, status: res.status, body };
  } catch (err) {
    console.error(`${label}-ads sync error`, err && err.message);
    return { ok: false, error: (err && err.message) || String(err) };
  }
}
