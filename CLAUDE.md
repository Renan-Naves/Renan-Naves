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
- `_headers` — cache rules. `/shared/*` cached for a year (`immutable`); HTML is not cached. **Because of this, every `/shared/*` reference is versioned with a `?v=YYYYMMDD` query string (e.g. `/shared/renan.js?v=20260614`) — when you edit a shared asset you MUST bump that version in all referencing HTML, or returning visitors keep the cached old file.**
- `.claude/commands/` — slash commands (e.g. `/new-page`).
- `docs/` — architecture and onboarding docs (shareable). Tracking flow: `docs/TRACKING.md`; ad-spend sync + `/dashboard`: `docs/ad-spend-sync.md`.
- `functions/` — Cloudflare Pages Functions (the tracking stack — see `## Tracking`). `_middleware.js` runs on every page; `tracker.js` is `POST /tracker` (Meta CAPI + GA4 + Google Ads fan-out); `google-ads.js` is the Google Ads offline-conversion uploader (auto `Lead` by gclid, plus a general `sendGoogleOfflineConversion` for manual QualifiedLead/Purchase); `meta-conversions.js` fires manual Meta WhatsApp conversions (`business_messaging`, by `ctwa_clid`); `origins.js` is the canonical traffic-origin taxonomy + `resolveOrigin()`; `scripts/[[path]].js` is the first-party GA4 gtag proxy (`/scripts/gtag.js`); `api/*` are the dashboard endpoints (reads: `campaign-report`, `leads-inbox`, `utm-attribution`, `conversation-detail` (full thread + linked session + conversion_fires, for the CRM/detail pop-ups); `referrals` (indicador→indicado referral graph, all-time, deduped by phone); writers: `mark-conversion` — funnel marks + `action:'origin'` manual origin (+ optional `referral_by_name`/`referral_by_phone` for indicações) + lifecycle `archive`/`unarchive`/`delete` (soft-delete); `send-message` — outbound WhatsApp reply via the uazapi REST); `webhook/uazapi/[slug].js` is the WhatsApp inbound webhook — logs every message (in + fromMe) to `wa_messages` and maintains `last_inbound_at`/`last_outbound_at` for the CRM dots (still dormant until `UAZAPI_WEBHOOK_SECRET` is set).
- `migrations/` — D1 schema, applied with `wrangler d1 migrations apply`. Numbered `0001`–`0025` (`0005` intentionally absent). `0018` `wa_conversations` (WhatsApp lead inbox), `0019` `conversion_fires` (manual-conversion audit), `0020` `google_keyword_stats` (Google keyword reporting), `0021` adds `manual_origin`/`utm_medium` to `wa_conversations` (UTM attribution), `0022` `wa_messages` (per-message CRM thread, forward-only), `0023` adds CRM columns to `wa_conversations` (`last_inbound_at`/`last_outbound_at`/`last_viewed_at` for the atendimento dots, `archived_at`/`deleted_at` for the archive folder + soft-delete), `0024` adds `referral_name` (indicado clean name), `0025` adds `referral_by_name`/`referral_by_phone` (who referred — the indicador, for the `/api/referrals` graph).
- `dash/` — the built-in tracking dashboard, served at `/dash/`. Auth via `?key=<DASH_KEY>`.
- `dashboard/` — dual-platform results dashboard (Meta Ads + Google Ads: investment, CPL, clicks, LP view, WhatsApp conversas, top Meta ads, top Google keywords) **plus the WhatsApp/comercial structure** (lead inbox + manual QualifiedLead/Purchase marking) **as a mini-CRM**: clicking a lead opens a pop-up to read the message thread + send a reply (via `send-message`); an atendimento dot flags state (🔴 nova não lida / 🟡 lida sem resposta / 🟢 aguardando o lead); the Atribuição-UTM lead name opens a details pop-up (all ids/UTMs + conversion_fires); both tabs can **arquivar/desarquivar** (pasta "Arquivados") and **excluir** (soft-delete, confirmado digitando o nome). The Resultados tab also has an **Indicações** graph (indicador→indicado): tagging a lead's origin as "Indicação" asks **who referred** (nome + WhatsApp), and the list — sorted by indicador, one line per referral — cross-references the indicador's WhatsApp against the base to show their origin + revenue alongside the indicado's revenue (`/api/referrals`). PT, dark/light theme, site palette + logo. Served at `/dashboard/`. Auth via `?key=<DASH_KEY>` (same key as `/dash`). See `## Tracking`.
- `cron-worker/` — standalone Cloudflare Worker with an hourly cron trigger that calls `/api/sync/meta-ads`. Deployed on its own with `wrangler deploy` (Pages has no cron). See `cron-worker/README.md`.
- `wrangler.toml.example` — template for the local-only `wrangler.toml` (gitignored). See `## Tracking` → deploy.

## Performance defaults (keep these)

- Inline critical CSS in `<head>`.
- `<script>` tags are `defer` or `async`. Never blocking.
- Images: `loading="lazy"`, `decoding="async"`, WebP/AVIF when possible.
- Use `<link rel="preload">` for the hero image and the above-the-fold font.
- `<link rel="preconnect">` to any third-party origin (pixels, analytics) before loading its script.

## Tracking

This repo started from the **KROB tracking stack** (ported from `gustavokrob/krob-tracking-stack`) but
the live site is **Dr. Renan Naves**, a medical landing page (medicina esportiva, reposição hormonal,
menopausa, nutrologia) plus a `blog/`. It runs **leads-only** — there is **no sales funnel / no checkout
/ no sales-platform webhook** (those example pages and their backend functions were removed). The
tracking is part of the **same** Cloudflare Pages project that serves the pages — do not split it into a
separate project; the first-party cookies + edge middleware only work same-origin with the pages. (The
one allowed exception is `cron-worker/`, a tiny standalone Worker that only exists because Pages has no
cron trigger — it serves no pages and sets no cookies, it just calls `/api/sync/meta-ads` hourly; it
stays dormant until the Meta-spend env vars are set.)

**Conversion model:** this LP has **no form** — a "Lead" is the **first click on a WhatsApp CTA per
session** (`api.whatsapp.com`/`wa.me`). All client-side tracking lives in **`shared/renan.js`** (loaded
by the root LP + every blog page, so one file instruments them all): it loads the Meta Pixel + fires
`PageView` (pixel + CAPI, deduped by `event_id`), loads GA4 via the first-party `/scripts/gtag.js`
proxy, and fires `Lead` (pixel + `/tracker`, plus a GA4 `generate_lead`) on the first WhatsApp click,
guarded by a `sessionStorage` flag so the CPL isn't inflated.

**What it does server-side:** the edge middleware (`functions/_middleware.js`) runs on every page
request, sets 400-day first-party cookies (`_krob_sid`, `_fbp`, `_fbc`, `_krob_eid`), captures
`fbclid`/`gclid`/UTMs, and upserts a `sessions` row. `POST /tracker` (`functions/tracker.js`) fans a
conversion out to **Meta CAPI** (SHA-256-hashed PII for Advanced Matching when present; here Lead has no
PII, so it matches on fbp/fbc/IP/UA), **GA4 Measurement Protocol** (conversions only), and **Google Ads**
(`functions/google-ads.js` — an offline ClickConversion keyed by the session's `gclid`, fired on `Lead`
only, silent unless the `GOOGLE_ADS_*` env vars are set). It dedupes against the browser pixel by
`event_id` and logs non-PageView events to `event_log`. The dashboard lives at `/dash/?key=<DASH_KEY>`
(Leads + Tracking Health are the live sections; the Revenue / "Leads /captura" sections stay empty since
there's no sales funnel or captura quiz).

**Results dashboard (`/dashboard`) — dual-platform + WhatsApp/comercial.** A second, separate page at
`/dashboard/?key=<DASH_KEY>` (PT, dark/light theme, site palette + logo). Two tabs:
- **Resultados:** investimento Meta/Google, CPL (geral + por plataforma), cliques no anúncio Meta,
  cliques no anúncio Google, LP view, conversas WPP Meta, conversas WPP Google; gráfico de performance
  diária (investimento × leads/CPL por plataforma); **melhores anúncios Meta (top 10)**; **palavras-chave
  de conversão Google (top 10)**.
- **WhatsApp / Comercial:** funil (leads / qualificados / vendas qtd / valor vendido) + **lista de leads**
  com **marcação MANUAL** de QualifiedLead (pede confirmação) / Venda (pede valor) / Perdido.
- **Atribuição (UTM):** lead a lead conectado ao número de WhatsApp — resumo por origem + tabela detalhada
  com **tag manual de origem**. Origens canônicas (`functions/origins.js`): orgânico-site, google-ads,
  google-meu-negocio, instagram-bio, meta-ads, tiktok-bio, indicação (tag manual), remarketing (tag manual).
  UTMs pré-estabelecidas por fonte; orgânico/indicação/remarketing não têm UTM. **Melhores anúncios Meta**
  só lista campanhas que gastaram verba (`HAVING SUM(spend_cents)>0`).
It reads D1 via `GET /api/campaign-report` + `GET /api/leads-inbox` + `GET /api/utm-attribution`, and writes via
`POST /api/mark-conversion` (funnel marks + `action:'origin'` for manual origin tagging) (which fires the manual conversion back to the **origin platform** — Meta CAPI
`business_messaging` by `ctwa_clid`, or Google Ads Data Manager by `gclid`; audited in `conversion_fires`).
**Conversion model is asymmetric:** Meta runs **CTWA** (ad → WhatsApp direct, skips the LP; conversation
captured by the uazapi webhook into `wa_conversations`, attributed by `ctwa_clid`); Google runs through the
**LP** (`utm_source=google-ads`, `gclid` on the session; a `#xxxxxxxx` token in the WhatsApp text set
by `shared/renan.js` links the conversation back to the session — with a manual fallback). Attribution:
Meta = `utm_source=meta-ads`/ctwa, Google = `utm_source=google-ads` (+ `utm_term` = keyword). Meta ad-cost
from `ad_spend` refreshed hourly by `POST /api/sync/meta-ads` (cron); Google cost/keywords come from
`POST /api/sync/google-ads` (**implemented** GAQL pull — `googleAds:search` into `ad_spend` (platform='google')
+ `google_keyword_stats`; needs the Google Ads API with a dev token, separate from the Data Manager upload;
**dormant until the reporting creds are set**, then zeroed cards fill). The report API is **infra-first / resilient**:
`wa_conversations` + `google_keyword_stats` may be unmigrated/empty and the page still renders. Full
ad-spend flow: `docs/ad-spend-sync.md`.

**Events the site fires (root LP + blog, all via `shared/renan.js`):** `PageView` (pixel + CAPI, never
logged to D1) on load; `Lead` (pixel + CAPI + GA4 `generate_lead`) on the first WhatsApp-CTA click per
session. No PII is collected (there's no form), so the Lead matches on cookies/IP/UA only. In Meta Ads,
build your conversion on the standard `Lead` event; in GA4, on `generate_lead`.

**Google Ads (leads).** `functions/google-ads.js` ingests an offline click-conversion event keyed by the
`gclid` the middleware captured into `sessions`, fired from `tracker.js` on `Lead` only. It uses the
**Data Manager API** (`POST datamanager.googleapis.com/v1/events:ingest`), **not** the legacy Google Ads
API `UploadClickConversions` — Google blocks that method for new adopters from 2026-06-15
(`CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE`). Data Manager needs **no developer token and no
login-customer-id header**: the advertiser (`operatingAccount`) and MCC (`loginAccount`) travel in the
request body's `destinations`, and the OAuth scope is `https://www.googleapis.com/auth/datamanager`. It
stays silent unless **all** of `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`,
`GOOGLE_ADS_REFRESH_TOKEN`, `GOOGLE_ADS_CUSTOMER_ID` (advertiser), `GOOGLE_ADS_LOGIN_CUSTOMER_ID` (MCC),
and `GOOGLE_ADS_LEAD_CONVERSION_ACTION_ID` (a **WEBPAGE** conversion action) are set, and the visitor's
session carries a `gclid`. Because the lead is a WhatsApp click with no email/phone,
enhanced-conversions-for-leads (hashed PII) does not apply — attribution is by `gclid`. `eventTimestamp`
is RFC 3339 in `TIMEZONE_OFFSET` (default `-03:00`), which should match the Google Ads account timezone.

**GA4 is ON.** Both client-side (gtag via the first-party `/scripts/gtag.js` proxy, initialised in
`shared/renan.js`) and server-side (Measurement Protocol from `tracker.js`, conversions only — it skips
`PageView`). Measurement ID `G-GT1DY1F536`. Needs `GA4_MEASUREMENT_ID` + `GA4_API_SECRET` env vars for
the server-side fire; `tracker.js` skips GA4 cleanly if they're unset.

**Hard rules (do not violate):**
- **Never log `PageView` to `event_log`.** It still fires to Meta — it just doesn't write a D1 row.
  Enforced in `tracker.js`.
- **Always use parameterized SQL** (`.bind()`). No string interpolation of user input, ever.
- **Hash PII before sending to ad platforms.** Email/name get SHA-256-hashed after lowercase+trim
  in `tracker.js`. (The current Lead carries no PII anyway — it's a WhatsApp click.) Any raw PII that
  does land in D1 (`event_log.raw_email`) is for analysis only — it never leaves this infra.
- **No secrets in client code or git.** `wrangler.toml`, `.dev.vars*` are gitignored. The Meta CAPI
  token and `DASH_KEY` live only as Cloudflare Pages environment variables.

**Required Pages environment variables** (Settings → Environment variables → Production):
`META_PIXEL_ID` (numeric — same value used in `shared/renan.js`'s `fbq('init', ...)`, currently
`1698518024494612`), `META_ACCESS_TOKEN` (CAPI token, encrypt), `DASH_KEY` (random, encrypt — gates
`/dash` and `/api/*`). **GA4 (on):** `GA4_MEASUREMENT_ID` (`G-GT1DY1F536`) + `GA4_API_SECRET` (encrypt).
Optional: `META_TEST_EVENT_CODE` (routes events to Events Manager → Test Events),
`DEFAULT_COUNTRY_CODE` (default `55`).
**Google Ads (leads) — all six required together (Data Manager API; NO developer token), else the upload
silently skips:** `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET` (encrypt), `GOOGLE_ADS_REFRESH_TOKEN`
(encrypt — generated with the `https://www.googleapis.com/auth/datamanager` scope), `GOOGLE_ADS_CUSTOMER_ID`
(advertiser / operating account, digits only), `GOOGLE_ADS_LOGIN_CUSTOMER_ID` (MCC id, digits only, or same
as customer id if no MCC), `GOOGLE_ADS_LEAD_CONVERSION_ACTION_ID` (numeric id of a **WEBPAGE** conversion
action in the advertiser account). Optional `TIMEZONE_OFFSET` (default `-03:00`) should match the Google
Ads account timezone.
**Manual WhatsApp conversions (QualifiedLead/Purchase via `/dashboard` → `/api/mark-conversion`).** Optional,
fire silently-skip if unset: `GOOGLE_ADS_QUALIFIED_CONVERSION_ACTION_ID`, `GOOGLE_ADS_PURCHASE_CONVERSION_ACTION_ID`
(Google offline conversion actions for the manual marks; reuse the same Data Manager creds above). Meta manual
conversions reuse `META_PIXEL_ID` + `META_ACCESS_TOKEN` (sent as `business_messaging` events keyed by `ctwa_clid`).
**uazapi WhatsApp webhook** (`/webhook/uazapi/<slug>`, dormant until set): `UAZAPI_WEBHOOK_SECRET` (encrypt —
also sent by uazapi as `x-uazapi-token` / `?token=`). Confirm `normalise()` (message id / timestamp / referral
paths) against a real captured payload before go-live.
**uazapi outbound send** (the dashboard CRM reply via `POST /api/send-message`, self-skips until both set):
`UAZAPI_BASE_URL` (the instance base URL, e.g. `https://<sub>.uazapi.com`) + `UAZAPI_TOKEN` (encrypt — the
instance API token, sent as the `token` header). The send shape assumed is the standard uazapi REST
(`POST {base}/send/text`, body `{ number, text }`); confirm it against the client's uazapi server and adjust
`functions/api/send-message.js` → `send()` if their build differs.
**Google Ads spend/keyword reporting sync** (`/api/sync/google-ads`, implemented GAQL pull — needs the Google
Ads API, NOT Data Manager; self-skips until creds set): `GOOGLE_ADS_DEVELOPER_TOKEN` (encrypt),
`GOOGLE_ADS_REPORTING_REFRESH_TOKEN` (encrypt — `https://www.googleapis.com/auth/adwords` scope); reuses the
client id/secret + customer/login ids above. Optional `GOOGLE_ADS_API_VERSION` (default `v20`) — bump when
Google sunsets it. Cron: set `SYNC_URL_GOOGLE` on `cron-worker/` to also sync Google hourly.
**Meta-spend sync** (powers the `/dashboard` campaign view + `cron-worker/`, inactive until set):
`SYNC_SECRET` (encrypt — also set as a secret on the cron Worker, see `cron-worker/README.md`),
`META_ADS_ACCESS_TOKEN` (encrypt), `META_ADS_ACCOUNT_ID`.
**Required D1 binding:** a D1 database bound as variable name `DB` (the code reads `env.DB`). Project
`renan-naves`, database `renan-naves-db`.

**Deploy / D1 setup** (this machine intercepts TLS — prefix wrangler/npx with `NODE_OPTIONS=--use-system-ca`; see `## Cloudflare account`): `npx wrangler@latest d1 create <name>-db` →
copy `wrangler.toml.example` to `wrangler.toml` and fill the three `__REPLACE_ME_*__` values (project
name, db name, `database_id`) → `npx wrangler@latest d1 migrations apply <name>-db --remote` → in the
Cloudflare dashboard bind the D1 as `DB` and add the env vars above → retry the latest deployment (env
var / binding changes don't apply to existing deploys). Generate `DASH_KEY` with `openssl rand -hex 32`.
Page deploys themselves keep happening via `git push` to the connected branch — Cloudflare Pages does
**not** read `wrangler.toml` at deploy time; it exists only for `wrangler d1` and `wrangler pages dev`.

## Do not

- Duplicate trackers across pages — all tracking lives in `shared/renan.js` (loaded by every page).
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

The `cf-on borkcursos` profile tooling referenced by the upstream template does **not** exist on this
machine — ignore it. This repo deploys to the owner's own Cloudflare account (`bruno.hayama@hotmail.com`
→ account "Drrenannaves@gmail.com's Account"); just `npx wrangler@latest login` once, no profile
switching. Note: this machine does SSL inspection, so npm/wrangler need
`$env:NODE_OPTIONS = "--use-system-ca"` (PowerShell) and HTTPS checks need PowerShell `Invoke-WebRequest`
rather than `curl` (curl fails TLS with exit 35). Local `wrangler pages dev` over HTTP is fine with curl.

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
