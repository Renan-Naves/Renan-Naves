# Page: dashboard

URL: `/dashboard/`

## Brief

- **Purpose:** Dashboard interno de resultados de campanha do Meta Ads — investimento,
  CPL, CPA, ROAS e CPL por criativo. Página administrativa, não é landing page.
- **Audience:** operador / gestor de tráfego (uso interno).
- **Auth:** `?key=<DASH_KEY>` na URL ou `sessionStorage.dashKey` (mesma chave do `/dash`).
- **Integrations:** lê tudo do D1 via `GET /api/campaign-report` — nenhum pixel/tracker
  dispara aqui (o middleware ignora `/dashboard` pelo prefixo `/dash`).

## Notes

- Arquivo único auto-contido (`index.html`); sem build. Tailwind CDN + Chart.js, mesmos
  design tokens do `/dash` para os dois painéis parecerem o mesmo produto.
- **Não scaffoldar a partir de `_template/`** — aquilo é scaffold de landing page; esta é
  ferramenta interna, no mesmo espírito de `/dash`.
- Convenção de conversão: uma conversão é "do Meta Ads" quando `utm_source = meta-ads`.
  CPL/CPA/ROAS = investimento ÷ leads / ÷ vendas / receita ÷ investimento. O CPL por
  criativo cruza `ad_spend.ad_name` com `sessions.utm_content` (macro `{{ad.name}}`).
- O custo só aparece depois que o cron (`cron-worker/`) sincroniza o `ad_spend`. Sem
  sincronização, os cards de investimento ficam zerados e a página mostra um aviso.
- Endpoint: `functions/api/campaign-report.js`. Detalhes do sync: `docs/ad-spend-sync.md`.

## Change log

- 2026-05-20 — página criada (dashboard de resultados de campanha Meta Ads)
