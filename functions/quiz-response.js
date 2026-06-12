// POST /quiz-response
//
// Persists one row per finished/declined run of the post-signup qualification
// quiz on /lp-do-sobral. Mirrors the shape of functions/checkout-session.js:
// reads the _krob_sid cookie to link the row to its originating visit, writes
// with a parameterized statement, returns { ok: true }. Conversion events
// (Lead / Lead31Plus) are a separate path — they go through /tracker.
//
// Expected JSON body:
//   {
//     "first_name": "Maria",
//     "email": "maria@example.com",
//     "answers": ["Entre 31 e 35 anos", "Feminino", "Superior completo", ...],
//     "qualified": true,
//     "event_source_url": "https://.../lp-do-sobral/"
//   }
//
// The questions are hardcoded on the page (see lp-do-sobral/index.html, the
// QUESTIONS array): index 0 is the age band, index 2 is the education level.
// Those two get denormalized into their own columns; the full array is kept
// in answers_json. Raw email/name persist here for analysis only — same
// convention as event_log.raw_email.

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

    const answers = Array.isArray(body.answers) ? body.answers : [];
    const ageBand = typeof answers[0] === 'string' ? answers[0] : '';
    const education = typeof answers[2] === 'string' ? answers[2] : '';
    const qualified = body.qualified ? 1 : 0;
    const now = Math.floor(Date.now() / 1000);

    if (env.DB) {
      await env.DB.prepare(`
        INSERT INTO quiz_responses (
          session_id, raw_email, raw_name, age_band, education,
          qualified, answers_json, event_source_url, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        sessionId,
        body.email || '',
        body.first_name || '',
        ageBand,
        education,
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
