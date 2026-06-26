# Google Ads API — Design Document & Token Application (resubmission)

> **Contexto (PT):** o token do Google Ads API que pedimos foi recusado como "incompleto"
> porque a primeira resposta dizia que a ferramenta "ainda estava em desenvolvimento". Este
> documento é o **design document** que o e‑mail de compliance pediu para anexar no reenvio do
> *New Token Form*, mais as **respostas do formulário** já prontas (em inglês — a análise do
> Google é em inglês). **Não reenvie com as mesmas respostas anteriores** (leva o mesmo e‑mail
> de novo). **Antes de reenviar:** troque o *developer contact email* para um e‑mail de
> lista/distribuição (ex.: `contato@drrenannaves.com.br`), como o próprio e‑mail recomendou.
>
> **Escopo deste token:** ele é usado **só para RELATÓRIO** (puxar gasto + palavras‑chave para
> o dashboard interno). O envio de conversões para o Google Ads **não** usa este token — usa a
> **Data Manager API** (`events:ingest`), que não exige developer token e já está funcionando.

> **2ª RECUSA (jun/2026) — o que mudou e como este reenvio responde:** a segunda recusa de Basic
> Access apontou (1) **identidade**: aplicação feita com e‑mail pessoal (gmail/hotmail) para um
> domínio corporativo; e (2) **modelo de negócio vago** + site sem Política de Privacidade/Termos.
> Correções aplicadas: **(a)** developer contact email agora é **`contato@drrenannaves.com.br`**
> (e‑mail no domínio); **(b)** o site ganhou **Política de Privacidade** (`/politica-de-privacidade/`)
> e **Termos de Uso** (`/termos-de-uso/`), linkados no rodapé de todas as páginas, somando ao
> **About Us** (seção "Sobre") e ao **endereço físico** (rodapé) já existentes; **(c)** o breakdown
> de funcionalidades de relatório foi detalhado na seção 8 abaixo. **Verifique também** que a conta
> Google usada no API Center está associada a um e‑mail do domínio (não a um gmail pessoal).

---

## 0. API Center — perfil do desenvolvedor (CORRIGIR ANTES DE REENVIAR)

O perfil ao vivo no API Center estava contando uma história de **agência** (e-mail pessoal + URL de
LinkedIn + "gerenciar múltiplas contas de clientes"), o que **contradiz** este doc e o site e causou a
recusa. Estratégia escolhida = **anunciante único (Clínica Raise)**. Ajuste o perfil para:

| Campo | Valor a usar |
|---|---|
| E-mail de contato da API | `contato@drrenannaves.com.br` |
| Nome da empresa | `Clínica Raise` |
| URL da empresa | `https://drrenannaves.com.br` |
| Tipo de empresa | **Anunciante / uso interno** (NÃO "Agência/SEM") |
| Uso pretendido | "Read-only reporting da nossa própria conta de anúncios (Google Ads), importando custo e palavras-chave para um dashboard interno e privado. Sem mutates, sem gerenciar contas de terceiros." |
| Sede | Brasil |

Garanta também que a **conta Google** logada no API Center use identidade do domínio (não um Gmail/Hotmail pessoal).

## 1. Summary

- **Requested access level:** **Basic Access.**
- **Tool type:** **Internal reporting dashboard** for a **single advertiser that we own/manage**.
- **API usage:** **Read‑only reporting** via `GoogleAdsService.Search` (GAQL). No mutates, no
  account management, no third‑party account management.
- **Operating entity (advertiser):** **Clínica Raise** — CNPJ **47.611.136/0001-00**, brand
  *Dr. Renan Naves* (CRM 156526 SP), site **https://drrenannaves.com.br**.
- **Accounts:**
  - Manager (MCC) account: **337‑869‑8997** (`login-customer-id`)
  - Advertiser (operating) account: **978‑281‑8062** — *Clínica Raise / Dr. Renan Naves*
  - We read **only this one advertiser account** (no third-party accounts, no SaaS offered to others).
- **Operation volume:** trivial — one hourly cron pulling 2 reports for 1 account
  (~48 search requests/day), far below the Basic Access limit.

## 2. What the product is

Dr. Renan Naves is a medical practice (sports medicine, hormone replacement, menopause,
nutrology) running a single landing page plus a blog. We built an **internal results dashboard**
(private, key‑gated, not public) that shows the practice's own advertising performance in one
place across **Meta Ads** and **Google Ads**: investment, cost‑per‑lead, ad clicks, landing‑page
views, WhatsApp conversations, top ads, and top converting keywords.

The dashboard is used **only by the advertiser and their marketing manager** to read their own
campaign results. It does **not** create or edit campaigns, does **not** manage any account other
than the advertiser's own, and is **not** offered as a product to third parties.

## 3. How we use the Google Ads API

The Google Ads API is used **exclusively for read‑only reporting** on the advertiser's own
account (`978‑281‑8062`), through the manager account (`337‑869‑8997`). Two GAQL queries, run
hourly by a scheduled job, write into our own database to power the dashboard:

**Query A — campaign cost (daily):** from `campaign`
```sql
SELECT campaign.id, campaign.name, metrics.cost_micros, metrics.clicks,
       metrics.impressions, segments.date
FROM campaign
WHERE segments.date DURING LAST_30_DAYS
```

**Query B — converting keywords (daily):** from `keyword_view`
```sql
SELECT campaign.name, ad_group.name, ad_group_criterion.keyword.text,
       metrics.clicks, metrics.cost_micros, metrics.conversions, segments.date
FROM keyword_view
WHERE segments.date DURING LAST_30_DAYS
```

**Service/method called:** `GoogleAdsService.Search` (`POST .../googleAds:search`), API version
`v24` (current). **No** `mutate` calls of any kind are made. The OAuth scope is
`https://www.googleapis.com/auth/adwords` (read access to the advertiser's reporting).

## 4. Architecture / data flow

```
[Hourly cron] ──> our backend (Cloudflare Pages Function /api/sync/google-ads)
                      │  OAuth2 refresh token (adwords scope)
                      │  developer-token header + login-customer-id: 3378698997
                      ▼
              Google Ads API  v24  GoogleAdsService.Search  (READ ONLY)
                      │  Query A: campaign cost   Query B: keyword stats
                      ▼
              our database (ad_spend, google_keyword_stats tables)
                      ▼
              internal dashboard  /dashboard  (key-gated, private)
                      ▼
              advertiser + marketing manager read their own results
```

Conversions are reported to Google through a **separate** path — the **Data Manager API**
(`datamanager.googleapis.com/v1/events:ingest`, scope `.../auth/datamanager`), which does **not**
use the Google Ads API or this developer token. That path is already live; this token is needed
**only** to read reporting metrics back into the dashboard.

## 5. Access level justification (Basic Access)

- We manage **one advertiser account, which is our own** (no third‑party account management),
  so the **Required Minimum Functionality (RMF)** for account‑management tools does not apply.
- Usage is **read‑only reporting** with a **tiny** operation count (1 account, 2 reports, hourly).
- Basic Access (15,000 operations/day) is far more than enough and is the appropriate tier for an
  internal reporting integration on owned accounts.

## 6. Why the previous application was marked incomplete — and what changed

The first submission described the tool as "in development," so the reviewer (correctly) routed us
to a test account. The integration is now **built and deployed**: the GAQL sync code exists
(`functions/api/sync/google-ads.js`), the dashboard that consumes it is live and key‑gated, and the
data model (`ad_spend`, `google_keyword_stats`) is in production. What we need a **live** token for
is to read **production** reporting data for our own advertiser account (a test token only reaches
test accounts). This document + the dashboard screenshots demonstrate the finished tool and its
read‑only, single‑account, internal use.

## 7. Attachments to include with the form

1. This design document.
2. **2–3 screenshots of `/dashboard`** showing the Google Ads section (investment / CPL / clicks
   cards and the "top converting keywords" table). Screenshots that show the API data rendered in
   the tool are what reviewers look for.

---

## 8. New Token Form — ready answers (paste into the form)

> Use these as the basis; keep them honest and consistent with the design doc above.

**Company / website:** Clínica Raise (CNPJ 47.611.136/0001-00), brand Dr. Renan Naves — https://drrenannaves.com.br

**Developer contact email:** `contato@drrenannaves.com.br` (corporate address on the company
domain — NOT a personal Gmail/Hotmail). Ensure the Google account tied to the API Center
application uses this same domain identity.

**Website compliance (the site is fully functional and public):**
> https://drrenannaves.com.br — includes an **About Us** section ("Sobre"), the clinic's **physical
> address** (Av. Ibirapuera, 1753 — Conjunto 101/102, Moema, São Paulo/SP), a **Privacy Policy**
> (https://drrenannaves.com.br/politica-de-privacidade/) and **Terms of Use**
> (https://drrenannaves.com.br/termos-de-uso/), both linked in the footer of every page. The Privacy
> Policy discloses the use of Google Analytics, Google Ads and Meta measurement technologies.

**Will you use the API to manage your own Google Ads accounts, or accounts of others?**
> Our own account only. The integration reads reporting data for a single advertiser account
> (978‑281‑8062) that we own, accessed via our manager account (337‑869‑8997). We do not manage
> any third‑party accounts.

**Describe your tool and how it uses the Google Ads API:**
> An internal, private (authentication‑gated) results dashboard for our own medical practice. It
> pulls **read‑only** reporting from the Google Ads API — campaign cost and converting‑keyword
> stats — via `GoogleAdsService.Search` (GAQL) on an hourly schedule, and displays investment,
> cost‑per‑lead, clicks, and top keywords alongside our Meta Ads data. It makes **no** mutate
> calls and manages **no** accounts; it only reads our own account's metrics.

**Detailed feature breakdown (reporting only):**
> 1. **Daily campaign cost report** — pulls `campaign.name`, `metrics.cost_micros`, `metrics.clicks`,
>    `metrics.impressions` by `segments.date` (Query A) into our `ad_spend` table; powers the
>    "Investimento", "CPL" and "Cliques (Google)" cards and the daily investment-vs-leads chart.
> 2. **Converting-keyword report** — pulls `ad_group_criterion.keyword.text`, `metrics.conversions`,
>    `metrics.cost_micros` by date (Query B) into `google_keyword_stats`; powers the "Top palavras-chave
>    de conversão (Google)" table.
> 3. **Cost-per-lead reconciliation** — joins the imported Google cost against leads captured in our
>    own database to compute CPL per platform (Meta vs Google) for the practice's manager.
> All three are **read-only**, run by one hourly scheduled job, on a single advertiser account we own.
> The tool performs **no** campaign creation, editing, budget changes, or bidding — strictly reporting.

**Which API services/methods will you call?**
> `GoogleAdsService.Search` only (read‑only reporting). No `mutate` operations.

**Is the tool for internal use or sold/offered to others?**
> Internal use only — for the advertiser (the practice) and its marketing manager. Not offered to
> third parties.

**Estimated daily API operations:**
> ~48 search requests/day (1 advertiser account × 2 reports × hourly). Well under Basic Access
> limits.

**Tool status:**
> Built and deployed in production. The reporting sync code and the consuming dashboard are live;
> we are requesting a live token to read production reporting data for our own account (the test
> token cannot reach our production advertiser account). Screenshots attached.
