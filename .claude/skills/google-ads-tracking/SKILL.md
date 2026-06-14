---
name: google-ads-tracking
description: Wire Google Ads offline/click conversion tracking into a site using the Data Manager API (events:ingest) — the 2026 way, with NO developer token. Use when someone says "add Google Ads tracking", "upload conversions to Google Ads", "track leads/sales in Google Ads", "Google Ads offline conversions", "import conversions by gclid", or asks how to send a WhatsApp/lead/purchase conversion back to Google Ads. Covers Cloud setup, OAuth (datamanager scope), conversion actions + finding the ctId, env vars, the worker code pattern, gclid capture/attribution, consent fields, validateOnly testing, and what STILL needs the Google Ads API (reporting). Portable: copy this folder to any project.
---

# Skill: google-ads-tracking (Data Manager API — 2026)

You are wiring **Google Ads offline / click conversion tracking** into a project. Use the
**Data Manager API** (`POST https://datamanager.googleapis.com/v1/events:ingest`). This is the
current, correct path and it needs **NO Google Ads developer token** — only OAuth.

Talk plainly, explain *why* each step matters in one sentence, and never paste secrets back to the
user. Confirm before any outward action (creating Cloud resources is the user's to do in their console).

---

## 0. Why this approach (read first)

- **Legacy is blocked for new adopters.** The old Google Ads API
  `ConversionUploadService.UploadClickConversions` rejects developer tokens with no prior
  offline-conversion history from **2026-06-15** (`CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE`).
  Don't use it for new setups.
- **Data Manager API is the replacement and needs NO dev token.** Auth is pure OAuth 2.0 with the
  scope `https://www.googleapis.com/auth/datamanager`. The advertiser (operating account) and MCC
  (login account) travel **in the request body**, not in headers. This is the big 2026 simplification.
- **Feb 2026 conversion-data changes.** Google restricted some conversion-import data (session
  attributes, IP address) on the legacy API and now expects **consent signals**
  (`adUserData` + `adPersonalization` = `CONSENT_GRANTED` | `CONSENT_DENIED` | `CONSENT_UNSPECIFIED`),
  especially for EEA users. Include them (see §6). At least one identifier is required per event:
  `gclid` (web), `gbraid`/`wbraid` (iOS app/web), or hashed user identifiers.
- **Reporting is NOT covered here.** Reading spend / clicks / keyword reports still requires the
  regular **Google Ads API (GAQL)** *with* a developer token. In 2026 Google added an automatic
  **Explorer Access** tier (granted by default, ~2,880 ops/day, feature-limited) so you can start
  without waiting for approval — but it's a separate flow from conversion upload. Keep the two apart.

---

## 1. What you're building

A server endpoint (edge worker / function) fires a conversion to Google Ads when a tracked event
happens (a lead, a qualified lead, a sale), keyed by the visitor's **`gclid`**:

```
Ad click (gclid in URL) → your LP captures gclid into a session
   → event happens → worker calls Data Manager events:ingest with that gclid
   → Google attributes the conversion to the right campaign/keyword.
```

If the ad sends users **straight to WhatsApp / app (no LP)**, the `gclid` never reaches your server
and this gclid path can't attribute — route paid Google traffic through the **LP** so the middleware
can capture the `gclid`. (Google has no WhatsApp "referral" like Meta's CTWA `ctwa_clid`.)

---

## 2. Google Cloud setup (user does this in console)

1. **Enable the API.** Google Cloud Console → APIs & Services → enable **"Data Manager API"** in the
   project you'll use. *(Why: the OAuth token is only honored for enabled APIs.)*
2. **Create OAuth client credentials.** APIs & Services → Credentials → Create credentials → OAuth
   client ID → application type **Desktop app**. Download the client JSON (gives `client_id` +
   `client_secret`). *(Why: this identifies your app to Google's OAuth.)*
3. **OAuth consent screen.** Configure it (External is fine), add your Google account as a test user
   if the app is in testing. *(Why: otherwise the refresh-token flow is blocked.)*

## 3. Generate a refresh token (scope = datamanager)

Use the Desktop client to do a one-time OAuth flow with **exactly** this scope:
`https://www.googleapis.com/auth/datamanager`

Option A — gcloud:
```
gcloud auth application-default login \
  --scopes="https://www.googleapis.com/auth/datamanager" \
  --client-id-file="PATH_TO_CLIENT.json"
```
Option B — OAuth 2.0 Playground (developers.google.com/oauthplayground): gear icon → "Use your own
OAuth credentials" → paste client id/secret → in scopes type the datamanager scope manually →
Authorize → "Exchange authorization code for tokens" → copy the **refresh token**.

Store the refresh token as an encrypted secret. *(Why: it's long-lived; treat it like a password.)*

## 4. Grant account access

The Google account you authorized must have access to:
- the **operating account** (the advertiser Google Ads account that owns the conversion actions), and
- the **login account** (the MCC, if the advertiser is under a manager account).

Add that email to those Google Ads accounts with at least standard access. **No developer token, no
`login-customer-id` header** — the account ids go in the request body's `destinations`.

## 5. Create the conversion actions (current 2026 flow) — QualifiedLead & Purchase

Create **one conversion action per event** you want Google to optimize for. Below is the exact,
current UI flow for **QualifiedLead** and **Purchase** (the auto **Lead** action is created the same
way, category = Lead).

### 5.1 QualifiedLead
1. Google Ads → **Goals → Conversions → Summary → "+ New conversion action"**.
2. On the **"Choose data sources"** screen pick the **"Offline conversions"** box
   (PT: *"Conversões off-line"* — "connecting data to a CRM, importing a file, or using the Google
   Ads API"). **NOT** "Website / Conversões em um site" (that one wants a page tag). Continue.
3. On the "Choose a data source" step pick **"Skip this step and set up a data source later"**
   (PT: *"Pular esta etapa e configurar uma fonte de dados mais tarde"*) — **NOT** "Connect a new
   product". Its own help text says you'll connect "via the Google Ads API" later, which is exactly
   our path (the worker pushes by gclid). The "measurement only activates once a source is connected"
   warning is fine — **the API IS the source**; it counts as connected on your first API upload.
   `transaction_id` is optional (we send one anyway). → Continue.
4. **Goal / category:** choose **"Qualified lead"**. *(Why: lets Smart Bidding optimize toward
   qualified leads specifically.)*
5. **Name:** something stable, e.g. `WhatsApp - Qualified Lead`.
6. **Value:** "Don't use a value" (a qualified lead usually has no monetary value) — or a fixed proxy
   value if you bid on it.
7. **Count:** **"One"** (one qualification per lead).
8. **Click-through conversion window:** set to **90 days** (offline qualification often happens days
   after the click; the default 30d would drop late ones).
9. Save. Then open the action again and copy its **`ctId`** (see 5.3) →
   `GOOGLE_ADS_QUALIFIED_CONVERSION_ACTION_ID`. **Wait 4–6 h before the first upload.**

### 5.2 Purchase
Repeat 5.1 with these differences:
- **Goal / category:** **"Purchase"**.
- **Name:** e.g. `WhatsApp - Purchase`.
- **Value:** **"Use different values for each conversion"** (we send `conversionValue` + `currency`
  per sale). Set the currency to your account currency (e.g. BRL).
- **Count:** **"One"** (or "Every" if a customer can buy repeatedly and you want each counted).
- **Window:** 90 days.
- Copy its `ctId` → `GOOGLE_ADS_PURCHASE_CONVERSION_ACTION_ID`.

### 5.3 Finding the `ctId` (the id the API needs)
Open the conversion action: **Goals → Conversions → Summary → click the action**. The browser URL
shows `…/conversions/detail?ctId=123456789`. **That number is the Conversion Action ID** — the value
for `productDestinationId` / the `GOOGLE_ADS_*_CONVERSION_ACTION_ID` env vars.

⚠️ **Don't confuse it** with the account-level **Conversion ID** `AW-XXXXXXXXX` from the gtag snippet —
that is NOT the conversion action id. (To be 100% sure, the Google Ads API exposes it as
`conversion_action.id`.)

### 5.4 (Optional) enhanced matching for these events
QualifiedLead/Purchase from WhatsApp carry a **phone number**. You can send it hashed alongside the
gclid for better matching: in Google Ads enable **Goals → Settings → "Enhanced conversions for
leads"** and accept the Customer Match terms. The code already hashes + sends the phone
(SHA-256 hex, E.164) when available; if the feature is off, Google simply ignores it (harmless). The
**gclid stays the primary key** either way.

## 6. The request (worker code pattern)

Reference implementation in this stack: **`functions/google-ads.js`**. Core shape:

```js
// OAuth: refresh token → access token
POST https://oauth2.googleapis.com/token
  grant_type=refresh_token&client_id=…&client_secret=…&refresh_token=…

// Ingest
POST https://datamanager.googleapis.com/v1/events:ingest
Authorization: Bearer <access_token>
{
  "destinations": [{
    "operatingAccount": { "accountType": "GOOGLE_ADS", "accountId": "<ADVERTISER_ID digits>" },
    "loginAccount":     { "accountType": "GOOGLE_ADS", "accountId": "<MCC_ID digits>" },
    "productDestinationId": "<CONVERSION_ACTION_ID = ctId>"
  }],
  "events": [{
    "eventTimestamp": "2026-06-14T15:07:01-03:00",   // RFC 3339 in the ad account's TZ
    "transactionId": "<unique dedup id, e.g. your event_id>",
    "eventSource": "WEB",
    "adIdentifiers": { "gclid": "<gclid from the session>" },
    "conversionValue": 180.00,                         // Purchase only
    "currency": "BRL",                                 // Purchase only
    "consent": { "adUserData": "CONSENT_GRANTED", "adPersonalization": "CONSENT_GRANTED" }
  }],
  "validateOnly": false
}
```

Notes:
- **Account ids: digits only** (strip `act_`/dashes). Conversion action id: digits only.
- **eventTimestamp** must match the Google Ads account timezone (e.g. `-03:00` São Paulo).
- **consent** (2026): the worker always sends it, from env (`GOOGLE_ADS_CONSENT_AD_USER_DATA` /
  `..._AD_PERSONALIZATION`, default `CONSENT_GRANTED`). For non-EEA (Brazil) GRANTED is typical; for
  EEA reflect the user's real CMP choice.
- **userData / encoding**: when a hashed identifier is sent (e.g. phone for QualifiedLead/Purchase),
  add top-level `"encoding": "HEX"` and put the SHA-256 hex under
  `userData.userIdentifiers[].phoneNumber` (E.164, hashed). The worker does this automatically.
- **value/currency** only for monetary events (Purchase). Omit for Lead/QualifiedLead.
- iOS without gclid → use `gbraid`/`wbraid` under `adIdentifiers` instead.

Gate the whole thing on env vars and a present `gclid` — **stay silent** (skip) if anything is
missing. Never throw into the user's request path; fire it best-effort (e.g. `waitUntil`).

## 7. Capture the gclid

Edge middleware must read `gclid` from the landing URL's query string (raw, not URL-decoded) and
persist it on the visitor's session (cookie + DB row), so it's available when the conversion fires
later. Reference: `functions/_middleware.js` (captures `gclid` into `sessions`).

## 8. Required env vars (this stack's names)

| Var | What |
|---|---|
| `GOOGLE_ADS_CLIENT_ID` | OAuth client id |
| `GOOGLE_ADS_CLIENT_SECRET` | OAuth client secret (encrypt) |
| `GOOGLE_ADS_REFRESH_TOKEN` | refresh token, **datamanager scope** (encrypt) |
| `GOOGLE_ADS_CUSTOMER_ID` | advertiser / operating account id (digits) |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | MCC / login account id (digits; = customer id if no MCC) |
| `GOOGLE_ADS_LEAD_CONVERSION_ACTION_ID` | ctId of the Lead conversion action |
| `GOOGLE_ADS_QUALIFIED_CONVERSION_ACTION_ID` | (optional) ctId for QualifiedLead |
| `GOOGLE_ADS_PURCHASE_CONVERSION_ACTION_ID` | (optional) ctId for Purchase |
| `TIMEZONE_OFFSET` | optional, default `-03:00`; match the ad account TZ |
| `GOOGLE_ADS_CONSENT_AD_USER_DATA` | optional consent enum, default `CONSENT_GRANTED` (set `DENIED`/`UNSPECIFIED` to change) |
| `GOOGLE_ADS_CONSENT_AD_PERSONALIZATION` | optional consent enum, default `CONSENT_GRANTED` |
| `DEFAULT_COUNTRY_CODE` | optional, default `55`; used to E.164-normalize phone before hashing |

No `GOOGLE_ADS_DEVELOPER_TOKEN` and no `login-customer-id` header for the Data Manager path.
The worker already injects the `consent` block on every event and, when a phone is supplied, a
SHA-256/HEX `userData.userIdentifiers[].phoneNumber` (with top-level `encoding: HEX`).

## 9. Test & verify

1. **Dry run:** set `"validateOnly": true` in the payload and POST — Google validates without
   recording. A 200 with no errors means auth + ids + shape are correct. Flip back to `false`.
2. **Real fire:** trigger the event with a session that has a real `gclid`. Expect HTTP 200.
3. **In Google Ads:** Goals → Conversions → the action shows recent conversions within a few hours
   (offline imports are not instant). Use the conversion action's **Diagnostics** to spot gclid /
   timestamp / consent issues.
4. **Log the response** (status + body) somewhere queryable — Data Manager uploads are otherwise
   invisible (they don't show in analytics event logs).

## 10. Common failures

- `PERMISSION_DENIED` → authorized account lacks access to the operating/login account, or the
  Data Manager API isn't enabled in the Cloud project.
- `invalid_grant` on token refresh → refresh token revoked / wrong scope / wrong client.
- Conversion accepted but **not attributed** → gclid missing/expired (>90d), wrong conversion action
  id (used `AW-` instead of `ctId`), or paid traffic bypassed the LP so no gclid was captured.
- `CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE` → you're hitting the **legacy** API, not Data Manager.

## 11. Reporting (separate, NOT tokenless)

To pull spend / clicks / keyword reports for a dashboard, use the **Google Ads API (GAQL)** — that
one **does** need a developer token (Explorer Access tier is auto-granted in 2026) + the `adwords`
OAuth scope + `login-customer-id` header. Keep this isolated from the Data Manager upload code.
Reference stub in this stack: `functions/api/sync/google-ads.js`.

---

## Portability

This skill is self-contained. To reuse in another project, copy the whole folder
`.claude/skills/google-ads-tracking/` (just this `SKILL.md`). The code references
(`functions/google-ads.js`, `functions/_middleware.js`) are this stack's implementation — adapt the
same request shape to the target project's runtime.
