# Tracking

This repo has the **KROB tracking stack** merged in (the leads-funnel slice of
`gustavokrob/krob-tracking-stack`). It runs as part of the *same* Cloudflare Pages
project that serves the pages — that's required, the first-party cookies and edge
middleware only work same-origin with the landing pages.

It does two things:

1. **Server-side conversion events** to Meta CAPI, deduped against the browser pixel
   by `event_id`, with SHA-256-hashed PII for Advanced Matching. Survives ad-blockers
   and Safari ITP because the identifiers (`_fbp`, `_fbc`, `_krob_sid`, `_krob_eid`)
   are 400-day first-party cookies set at the edge.
2. **First-party attribution persistence** — every visit's `fbclid`/`gclid`/UTMs land
   in a `sessions` row in D1, so leads (and the quiz answers) can be joined back to the
   ad/campaign they came from.

GA4 is **off** (Meta only). Sales-side tracking (`/checkout-session`, sales-platform
webhooks) was not ported — this is a leads funnel.

Two pages run the event side: **`/lp-do-sobral`** (event-signup funnel) and
**`/captura`** (Comunidade KROB pre-qualification funnel). `/captura` fires `Lead` on
email submit and the custom `LeadQualificado` when the post-signup quiz answers match
the Comunidade KROB ICP; the quiz answers land in `captura_responses` via
`POST /captura-response`. Other pages (`/vendas`, `/links`) get cookie + `sessions`
capture for free via the middleware but don't fire pixel events.

## The flow, hop by hop

```
visitor lands on /lp-do-sobral?utm_source=facebook&...
  → functions/_middleware.js
       sets _krob_sid / _fbp / _fbc / _krob_eid cookies (400d)
       captures fbclid/gclid/utm_* → UPSERT sessions row
  → page <head>: Meta Pixel init + PageView (pixel + CAPI via /tracker; PageView is
       fired to Meta but never written to event_log)
  → visitor submits name + email
       → fbq('track','Lead', {}, {eventID})            (browser pixel)
       → POST /tracker  { event_name:'Lead', user_data:{ em, fn } }   (server)
            functions/tracker.js: SHA-256-hash em/fn, enrich fbp/fbc/external_id from
            the sessions row, fire Meta CAPI, insert an event_log row
       → quiz modal opens
  → on the quiz's first question, if the visitor picks a 31+ age band:
       → fbq('trackCustom','Lead31Plus', {}, {eventID})
       → POST /tracker  { event_name:'Lead31Plus', user_data:{ em, fn } }
  → at the end of the quiz (finish or decline):
       → POST /quiz-response  { first_name, email, answers, qualified, event_source_url }
            functions/quiz-response.js: insert a quiz_responses row, linked by _krob_sid
```

`event_log` rows for `Lead` show up in the dashboard's **Leads** tab; `Lead31Plus`
rows are in `event_log` too but the Leads tab filters `event_name = 'Lead'`, so query
them directly (see below) or widen that filter in `functions/api/leads.js`.

### The /captura flow (Comunidade KROB pre-qualification)

```
visitor lands on /captura?utm_source=...&...
  → functions/_middleware.js  — same cookie + sessions capture as above
  → page <head>: Meta Pixel init + PageView (pixel + CAPI via /tracker; not logged)
  → visitor submits email
       → fbq('track','Lead', {}, {eventID})  +  POST /tracker { event_name:'Lead', user_data:{ em } }
       → qualification quiz modal opens (one question at a time, branched by profile:
            gestor / dono de negócio / equipe interna / iniciante)
  → as soon as the answers determine ICP fit (gestor with 3+ clients, or dono billing
    R$ 10k+/mês who runs paid traffic):
       → fbq('trackCustom','LeadQualificado', {}, {eventID})  +  POST /tracker { event_name:'LeadQualificado', user_data:{ em } }
  → at the end of the quiz:
       → POST /captura-response { email, phone, profile, *_band, traffic_usage, goal, qualified, answers_json, event_source_url }
            functions/captura-response.js: insert a captura_responses row, linked by _krob_sid
```

The commercial team reads this in the dashboard's **"Leads /captura — qualificação"**
section (`functions/api/captura-leads.js` joins `captura_responses` to `sessions` for
the UTMs). `LeadQualificado` also lands in `event_log` — in Meta Ads, create a custom
conversion on the `LeadQualificado` event to optimize/report on it. The qualification
rule (the answer strings + thresholds) lives in constants at the top of the IIFE in
`captura/index.html` — easy to retune.

## Environment variables (Cloudflare Pages → Settings → Environment variables → Production)

Required:

| Name | Value | Encrypt? |
|---|---|---|
| `META_PIXEL_ID` | numeric Pixel ID — same value as the page's `fbq('init', ...)` | no |
| `META_ACCESS_TOKEN` | Meta CAPI long-lived token (Events Manager → your Pixel → Settings → Generate access token) | yes |
| `DASH_KEY` | random string (`openssl rand -hex 32`) — gates `/dash` and `/api/*` | yes |

Optional: `META_TEST_EVENT_CODE` (routes events to Events Manager → Test Events),
`DEFAULT_COUNTRY_CODE` (default `55`; used to normalize the WhatsApp number `/captura` collects),
`SYNC_SECRET` + `META_ADS_ACCESS_TOKEN` + `META_ADS_ACCOUNT_ID` (Meta-spend sync into
the dashboard's CPA/ROAS — inactive until set *and* an external hourly cron hits
`POST /api/sync/meta-ads`).

Required binding: a **D1 database bound as variable name `DB`** (the code reads `env.DB`).

## Deploy / D1 setup

This repo always uses the `borkcursos` Cloudflare profile — run `cf-on borkcursos`
first (`cf-status` to verify, `cf-off` when done).

```bash
npx wrangler@latest d1 create <project>-db          # note the database_id it prints
cp wrangler.toml.example wrangler.toml              # gitignored; fill the 3 __REPLACE_ME__ values
npx wrangler@latest d1 migrations apply <project>-db --remote   # applies 0001..0017
```

Then in the Cloudflare dashboard (Pages → this project):
- **Settings → Bindings → Add → D1 database**: variable name `DB`, database `<project>-db`, Production (and Preview if you use it).
- **Settings → Environment variables**: add the table above.
- **Deployments → latest → Retry deployment** (env var / binding changes don't apply to existing deploys).

Page deploys keep happening via `git push` to the connected branch. Cloudflare Pages
does **not** read `wrangler.toml` at deploy time — it exists only so `wrangler d1` and
`wrangler pages dev` work locally.

## Verifying it works

After a deploy, visit `https://<your-domain>/lp-do-sobral/?utm_source=test_claude&utm_medium=verify`,
check that `_krob_sid` and `_fbp` cookies are set (DevTools → Application → Cookies),
submit the form with a throwaway email, run through the quiz, then:

```bash
# Lead / Lead31Plus events reached Meta?
npx wrangler@latest d1 execute <project>-db --remote --command \
  "SELECT event_name, raw_email, meta_response_ok, meta_response_body FROM event_log ORDER BY id DESC LIMIT 5"

# Quiz answers persisted? (/lp-do-sobral)
npx wrangler@latest d1 execute <project>-db --remote --command \
  "SELECT session_id, raw_email, age_band, education, qualified, created_at FROM quiz_responses ORDER BY id DESC LIMIT 5"

# Qualification answers persisted? (/captura)
npx wrangler@latest d1 execute <project>-db --remote --command \
  "SELECT raw_email, raw_phone, profile, clients_band, business_revenue_band, qualified, created_at FROM captura_responses ORDER BY id DESC LIMIT 5"

# Attribution captured?
npx wrangler@latest d1 execute <project>-db --remote --command \
  "SELECT session_id, utm_source, utm_campaign, fbp, created_at FROM sessions ORDER BY created_at DESC LIMIT 5"
```

`meta_response_ok = 1` on the `Lead` / `Lead31Plus` rows means Meta accepted the CAPI
event. If it's `0`, `meta_response_body` has the reason (usually a bad/expired
`META_ACCESS_TOKEN` or wrong `META_PIXEL_ID`). Then confirm in Meta Events Manager →
your Pixel → Test Events (if `META_TEST_EVENT_CODE` is set) or the Overview tab — you
should see `Lead`, `Lead31Plus` and `LeadQualificado` with Advanced Matching populated
and pixel↔CAPI deduped by `event_id`. The dashboard is at
`https://<your-domain>/dash/?key=<DASH_KEY>`.
