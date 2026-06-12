// GET /api/captura-leads?key=...&days=30&limit=100
//
// Returns runs of the /captura lead-qualification quiz joined to their
// originating session so each row carries its UTMs / fbclid / gclid. This is
// the view the commercial team uses to triage leads before reaching out —
// who's qualified (ICP for Comunidade KROB), what profile, how big, and what
// WhatsApp to call.
//
// Source: captura_responses LEFT JOIN sessions via session_id. Unlike
// /api/leads there's no bot column here — captura_responses only gets a row
// when a human finishes the quiz.

export async function onRequestGet(context) {
  const { request, env } = context;

  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!env.DASH_KEY || key !== env.DASH_KEY) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const days = clampInt(url.searchParams.get('days'), 30, 1, 365);
  const limit = clampInt(url.searchParams.get('limit'), 100, 1, 500);
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  try {
    const rows = await env.DB.prepare(`
      SELECT
        c.created_at,
        c.session_id,
        c.raw_email,
        c.raw_phone,
        c.profile,
        c.clients_band,
        c.service_revenue_band,
        c.business_revenue_band,
        c.traffic_usage,
        c.ad_spend_band,
        c.goal,
        c.qualified,
        c.answers_json,
        c.event_source_url,
        s.utm_source,
        s.utm_medium,
        s.utm_campaign,
        s.utm_content,
        s.utm_term,
        s.fbclid,
        s.gclid,
        s.referrer,
        s.landing_url
      FROM captura_responses c
      LEFT JOIN sessions s ON c.session_id = s.session_id
      WHERE c.created_at >= ?
      ORDER BY c.created_at DESC
      LIMIT ?
    `).bind(since, limit).all();

    // Counts grouped by profile (qualified vs total) for the summary card.
    const byProfile = await env.DB.prepare(`
      SELECT
        COALESCE(NULLIF(profile, ''), '(none)') as profile,
        COUNT(*) as count,
        SUM(qualified) as qualified
      FROM captura_responses
      WHERE created_at >= ?
      GROUP BY profile
      ORDER BY count DESC
    `).bind(since).all();

    // Counts grouped by utm_source (qualified vs total).
    const bySource = await env.DB.prepare(`
      SELECT
        COALESCE(NULLIF(s.utm_source, ''), '(direct)') as utm_source,
        COUNT(*) as count,
        SUM(c.qualified) as qualified
      FROM captura_responses c
      LEFT JOIN sessions s ON c.session_id = s.session_id
      WHERE c.created_at >= ?
      GROUP BY utm_source
      ORDER BY count DESC
    `).bind(since).all();

    const leads = rows.results || [];
    const qualifiedCount = leads.reduce((n, l) => n + (l.qualified ? 1 : 0), 0);

    return json({
      days,
      total: leads.length,
      qualified: qualifiedCount,
      leads,
      summary_by_profile: byProfile.results || [],
      summary_by_source: bySource.results || [],
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function clampInt(raw, fallback, min, max) {
  const n = parseInt(raw || '', 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
