# Project

Multi-page static site on Cloudflare Pages. Single domain, path-based routing.

## Rule of the repo

- **One folder = one page = one URL slug.** Folder `example/` serves at `/example/`.
- All pages are plain HTML/CSS/JS. No build step. No framework.
- To create a new page, copy `_template/` — or run `/new-page <slug>`.

## Naming

- Slugs are kebab-case: `sales-black-friday`, not `salesBlackFriday`.
- The slug is the URL. Don't rename folders after launch (breaks links).

## Where things live

- `_template/` — scaffold for new pages. Don't edit except to improve the template.
- `shared/` — CSS/JS/fonts used by 2+ pages. Create only when real duplication appears.
- `_headers` — cache rules. `/shared/*` cached for a year; HTML is not cached.
- `.claude/commands/` — slash commands (e.g. `/new-page`).
- `docs/` — architecture and onboarding docs (shareable). Tracking flow: `docs/TRACKING.md`; ad-spend sync + `/dashboard`: `docs/ad-spend-sync.md`.
- `functions/` — Cloudflare Pages Functions (the tracking stack — see `## Tracking`). `_middleware.js` runs on every page; `tracker.js` is `POST /tracker`; `quiz-response.js` is `POST /quiz-response` (the `/lp-do-sobral` quiz); `captura-response.js` is `POST /captura-response` (the `/captura` qualification quiz); `api/*` are the read-only dashboard endpoints.
- `migrations/` — D1 schema, applied with `wrangler d1 migrations apply`. Numbered `0001`–`0017` (`0005` intentionally absent).
- `dash/` — the built-in tracking dashboard, served at `/dash/`. Auth via `?key=<DASH_KEY>`.
- `dashboard/` — campaign-results dashboard (Meta Ads investment, CPL, CPA, ROAS, CPL per creative), served at `/dashboard/`. Auth via `?key=<DASH_KEY>` (same key as `/dash`). See `## Tracking`.
- `cron-worker/` — standalone Cloudflare Worker with an hourly cron trigger that calls `/api/sync/meta-ads`. Deployed on its own with `wrangler deploy` (Pages has no cron). See `cron-worker/README.md`.
- `wrangler.toml.example` — template for the local-only `wrangler.toml` (gitignored). See `## Tracking` → deploy.

## Performance defaults (keep these)

- Inline critical CSS in `<head>`.
- `<script>` tags are `defer` or `async`. Never blocking.
- Images: `loading="lazy"`, `decoding="async"`, WebP/AVIF when possible.
- Use `<link rel="preload">` for the hero image and the above-the-fold font.
- `<link rel="preconnect">` to any third-party origin (pixels, analytics) before loading its script.

## Tracking

This repo has the **KROB tracking stack** merged in (ported from `gustavokrob/krob-tracking-stack`,
leads funnel + Hotmart sales funnel). It's part of the **same** Cloudflare Pages project that serves
the pages — do not split it into a separate project; the first-party cookies + edge middleware only
work same-origin with the landing pages. (The one allowed exception is `cron-worker/`, a tiny
standalone Worker that only exists because Pages has no cron trigger — it serves no pages and sets no
cookies, it just calls `/api/sync/meta-ads` hourly.)

**What it does:** the edge middleware (`functions/_middleware.js`) runs on every page request, sets
400-day first-party cookies (`_krob_sid`, `_fbp`, `_fbc`, `_krob_eid`), captures `fbclid`/`gclid`/UTMs,
and upserts a `sessions` row. `POST /tracker` (`functions/tracker.js`) fires server-side conversion
events to Meta CAPI (with SHA-256-hashed PII for Advanced Matching), deduped against the browser pixel
by `event_id`, and logs non-PageView events to `event_log`. `POST /quiz-response`
(`functions/quiz-response.js`) persists the `/lp-do-sobral` qualification-quiz answers to `quiz_responses`;
`POST /captura-response` (`functions/captura-response.js`) persists the `/captura` qualification-quiz
answers to `captura_responses`. `POST /checkout-session` (`functions/checkout-session.js`) snapshots
fbp/fbc/UTMs/IP/UA into `checkout_sessions` (indexed by `trk` UUID) when the visitor opens `/vendas` —
so when `POST /webhook/hotmart/<HOTMART_WEBHOOK_SLUG>` (`functions/webhook/hotmart/[slug].js`) receives
the Hotmart Postback 2.0 later, the shared core (`functions/webhook/_core.js`) can recover that
attribution by `trk` and fire `Purchase` to Meta CAPI with full user_data + write the sale to
`purchase_log` + `purchase_items`. The dashboard lives at `/dash/?key=<DASH_KEY>` (Leads, "Leads /captura
— qualificação", Tracking Health, Revenue, and Recent purchases are all live sections).

**Campaign-results dashboard (`/dashboard`).** A second, separate page at `/dashboard/?key=<DASH_KEY>`
gives a clean Meta-Ads results view: a date-range picker, campaign KPIs (investment, leads, CPL, sales,
CPA, revenue, ROAS, quiz responses), a daily investment×leads chart, and **CPL per creative**. It reads
only D1 via `GET /api/campaign-report` (`functions/api/campaign-report.js`) — never the Meta API in the
request path. Convention: a conversion counts as Meta Ads when `utm_source = 'meta-ads'`; CPL/CPA/ROAS
divide investment by leads / sales / into revenue. CPL per creative matches `ad_spend.ad_name` against
`sessions.utm_content` by normalised name (the `utm_content` is filled with Meta's `{{ad.name}}` macro).
Ad-cost data comes from `ad_spend`, refreshed hourly by `POST /api/sync/meta-ads`
(`functions/api/sync/meta-ads.js`, **ad-level** insights) triggered by the cron Worker in `cron-worker/`.
Full flow: `docs/ad-spend-sync.md`.

**Events `/lp-do-sobral` fires:** `PageView` (pixel + CAPI, never logged to D1) on load; `Lead`
(enriched with `em` + `fn`) on form submit; the custom event `Lead31Plus` (also `em` + `fn`) when the
visitor picks a 31-or-older age band on the quiz's first question; and `POST /quiz-response` at the end
of the quiz.

**Events `/captura` fires:** `PageView` (pixel + CAPI, never logged) on load; `Lead` (enriched with
`em`) on email submit; the custom event `LeadQualificado` (`em`) the moment the post-signup quiz answers
match the Comunidade KROB ICP — gestor de tráfego with 3+ different clients, **or** dono de negócio
digital billing R$ 10k+/mês who actually runs paid traffic; and `POST /captura-response` at the end of
the quiz (answers + `qualified` flag → `captura_responses`, joinable to `sessions` for UTMs; surfaced
in the dashboard's "Leads /captura" section via `functions/api/captura-leads.js`). The quiz branches by
profile (gestor / dono / equipe interna / iniciante) — the answer strings and qualification thresholds
are constants at the top of the IIFE in `captura/index.html`. In Meta Ads, build a custom conversion on
the `LeadQualificado` event.

**Events `/vendas` fires:** `PageView` (pixel + CAPI, never logged) on load; `InitiateCheckout`
(pixel + CAPI, with `content_type='product'` + `content_ids: ['4959432']` + `content_name:
'TrackStart — API de conversões pelo Google Tag Manager'`) when the price-card CTA is clicked;
`POST /checkout-session` on load to snapshot fbp/fbc/UTMs into `checkout_sessions` keyed by a
sessionStorage `trk` UUID. The button then redirects to
`https://pay.hotmart.com/X97540270M?off=rv7lryct&xcod=<trk>&sck=<utm-bundle>` — Hotmart carries the
`trk` back in the webhook as `data.purchase.origin.xcod`. The `Purchase` event is fired exclusively
**server-side** via `POST /webhook/hotmart/<HOTMART_WEBHOOK_SLUG>` on `PURCHASE_APPROVED` (refunds /
chargebacks are acknowledged with 200 and skipped) — there is NO Purchase pixel event from
`pay.hotmart.com` because that's a different origin and our Pixel doesn't run there. The webhook
adapter is in `functions/webhook/hotmart/[slug].js`; common processing (D1 lookup of
`checkout_sessions`, Meta CAPI fire, `purchase_log`/`purchase_items` insert with rollback invariant)
lives in `functions/webhook/_core.js`. URL-slug auth via `functions/webhook/_utils.js:guardSlug`
(404 on bad slug — scanner-resistant; HOTTOK / HMAC validation deliberately deferred).

Other pages (`/links`) get cookie + `sessions` capture for free via the middleware but don't fire
pixel events.

**GA4 is off.** Meta only. The gtag first-party proxy and GA4 script blocks were not ported. To turn GA4
on later: set `GA4_MEASUREMENT_ID` + `GA4_API_SECRET`, copy `functions/scripts/[[path]].js` from the
source stack, and add the gtag `<script>` blocks to the page `<head>`. `tracker.js` already skips GA4
cleanly when those env vars are unset.

**Hard rules (do not violate):**
- **Never log `PageView` to `event_log`.** It still fires to Meta — it just doesn't write a D1 row.
  Enforced in `tracker.js`.
- **Always use parameterized SQL** (`.bind()`). No string interpolation of user input, ever.
- **Hash PII before sending to ad platforms.** Email/name get SHA-256-hashed after lowercase+trim
  in `tracker.js`. Raw PII persists in D1 (`event_log.raw_email`, `quiz_responses.raw_*`,
  `captura_responses.raw_email`/`raw_phone`) for analysis only — it never leaves this infra.
- **No secrets in client code or git.** `wrangler.toml`, `.dev.vars*` are gitignored. The Meta CAPI
  token and `DASH_KEY` live only as Cloudflare Pages environment variables.

**Required Pages environment variables** (Settings → Environment variables → Production):
`META_PIXEL_ID` (numeric — same value used in the page's `fbq('init', ...)`), `META_ACCESS_TOKEN` (CAPI
token, encrypt), `DASH_KEY` (random, encrypt — gates `/dash` and `/api/*`), `HOTMART_WEBHOOK_SLUG`
(UUID v4, encrypt — gates `/webhook/hotmart/<slug>`; generate with `uuidgen` or
`openssl rand -hex 16` reformatted as a UUID; the URL `https://<your-domain>/webhook/hotmart/<slug>`
goes into the Hotmart panel under Ferramentas → Webhook (Postback 2.0), event `PURCHASE_APPROVED`).
Optional: `META_TEST_EVENT_CODE` (routes events to Events Manager → Test Events),
`DEFAULT_COUNTRY_CODE` (default `55`), and `SYNC_SECRET` + `META_ADS_ACCESS_TOKEN` +
`META_ADS_ACCOUNT_ID` (Meta-spend sync that powers `/dashboard` — inactive until set; once set, the
hourly Cloudflare cron Worker in `cron-worker/` hits `/api/sync/meta-ads`. `SYNC_SECRET` must also be
set as a secret on that Worker — see `cron-worker/README.md`).
**Required D1 binding:** a D1 database bound as variable name `DB` (the code reads `env.DB`).

**Deploy / D1 setup** (run with `cf-on borkcursos`): `npx wrangler@latest d1 create <name>-db` →
copy `wrangler.toml.example` to `wrangler.toml` and fill the three `__REPLACE_ME_*__` values (project
name, db name, `database_id`) → `npx wrangler@latest d1 migrations apply <name>-db --remote` → in the
Cloudflare dashboard bind the D1 as `DB` and add the env vars above → retry the latest deployment (env
var / binding changes don't apply to existing deploys). Generate `DASH_KEY` with `openssl rand -hex 32`.
Page deploys themselves keep happening via `git push` to the connected branch — Cloudflare Pages does
**not** read `wrangler.toml` at deploy time; it exists only for `wrangler d1` and `wrangler pages dev`.

## Do not

- Duplicate trackers across pages — when trackers arrive, they live in `shared/scripts/`.
- Add a bundler, package.json, or framework without asking.
- Put secrets in client-side code.
- Rename a launched folder without a matching `_redirects` entry.
- Log `PageView` to `event_log`, build SQL with string interpolation, or send unhashed PII to ad platforms (see `## Tracking`).

## Deploy

Cloudflare Pages, single project pointing at repo root. Push to the connected branch. The same project
also serves the tracking stack (`functions/`, `migrations/`, `dash/`, `dashboard/`) — see `## Tracking`
for the D1 + environment-variable setup that the Pages project needs. The `cron-worker/` Worker is the
only piece deployed separately (`wrangler deploy`), not via `git push`.

## Cloudflare account (this repo)

This repo always uses the **`borkcursos`** Cloudflare profile. Before running any
`wrangler` / Cloudflare CLI command in this repo, run `cf-on borkcursos` (verify with
`cf-status`; `cf-off` when done). Don't use the machine's other Cloudflare profiles here.

## For Claude: check `origin` before any `git push`

This repo is a template. Students usually clone it from `gustavokrob/encontro-2-krobcode-pages`, which means their local `origin` remote still points at the source template — and `git push` will fail because they don't have write access there.

Before running any `git push` in this repo:

1. Run `git remote -v`. If `origin` points at `gustavokrob/encontro-2-krobcode-pages` (or any repo the user does not own), **stop and do not push**.
2. Ask the user which GitHub account and repo name they want to push to. Don't assume.
3. Re-wire the remote to their own repo:
   - Create their GitHub repo first (via `gh repo create <user>/<repo> --private --source=. --remote=origin --push` — this swaps `origin` and pushes in one step), OR
   - If the repo already exists on GitHub: `git remote remove origin` → `git remote add origin https://github.com/<their-user>/<their-repo>.git` → `git push -u origin main`.
4. Only once `origin` points at a repo the user owns, proceed with the push.

Never push to `gustavokrob/encontro-2-krobcode-pages` — that's the source template, read-only for students.
