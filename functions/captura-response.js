// POST /captura-response
//
// Persists one row per finished run of the lead-qualification quiz on /captura
// (Comunidade KROB funnel). Mirrors functions/quiz-response.js: reads the
// _krob_sid cookie to link the row to its originating visit, writes with a
// parameterized statement, returns { ok: true }. Conversion events
// (Lead / LeadQualificado) are a separate path — they go through /tracker.
//
// The quiz branches by `profile` (the first question), so unlike
// /quiz-response we don't denormalize by array index — the page sends the
// already-named fields. `answers_json` keeps the full [{question, answer}, ...]
// audit trail. Raw email/phone persist here for the commercial team / analysis
// only — same convention as event_log.raw_email.
//
// Expected JSON body:
//   {
//     "email": "fulano@example.com",
//     "phone": "(11) 99999-9999",
//     "profile": "gestor",                       // gestor | dono | equipe | iniciante
//     "clients_band": "3 a 5 clientes",          // gestor branch
//     "service_revenue_band": "R$ 5–10 mil/mês", // gestor branch
//     "business_revenue_band": "",               // dono branch
//     "traffic_usage": "",                       // dono branch
//     "ad_spend_band": "R$ 5–20 mil",            // gestor (A4) or dono (B4)
//     "goal": "",                                // equipe/iniciante branch
//     "qualified": true,
//     "answers_json": [{ "question": "...", "answer": "..." }, ...],
//     "event_source_url": "https://.../captura/"
//   }

export async function onRequestPost(context) {
  const { request, env } = context;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  try {
    const body = await request.json();
    const cookies = parseCookies(request.headers.get('Cookie') || '');
    const sessionId = cookies['_krob_sid'] || '';

    const answers = Array.isArray(body.answers_json) ? body.answers_json : [];
    const qualified = body.qualified ? 1 : 0;
    const now = Math.floor(Date.now() / 1000);

    if (env.DB) {
      await env.DB.prepare(`
        INSERT INTO captura_responses (
          session_id, raw_email, raw_phone, profile,
          clients_band, service_revenue_band, business_revenue_band,
          traffic_usage, ad_spend_band, goal,
          qualified, answers_json, event_source_url, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        sessionId,
        body.email || '',
        body.phone || '',
        body.profile || '',
        body.clients_band || '',
        body.service_revenue_band || '',
        body.business_revenue_band || '',
        body.traffic_usage || '',
        body.ad_spend_band || '',
        body.goal || '',
        qualified,
        JSON.stringify(answers),
        body.event_source_url || '',
        now
      ).run();
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

function parseCookies(cookieHeader) {
  const cookies = {};
  cookieHeader.split(';').forEach(cookie => {
    const [name, ...rest] = cookie.trim().split('=');
    if (name) cookies[name.trim()] = rest.join('=');
  });
  return cookies;
}
