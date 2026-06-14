# Page: dashboard

URL: `/dashboard/`

## Brief

- **Purpose:** Painel interno de resultados **dual-platform (Meta Ads + Google Ads)** do
  Dr. Renan, mais a **estrutura de WhatsApp / comercial** (lista de leads + marcação
  manual de qualificado/venda). Página administrativa, não é landing page.
- **Audience:** gestor de tráfego + atendente do comercial (uso interno).
- **Auth:** `?key=<DASH_KEY>` na URL ou `sessionStorage.dashKey` (mesma chave do `/dash`).
- **Integrations:** lê via `GET /api/campaign-report` e `GET /api/leads-inbox`; grava via
  `POST /api/mark-conversion`. Nenhum pixel/tracker dispara aqui (middleware ignora `/dash*`).

## Funil (modelo desta LP — sem formulário)

- **Meta = CTWA**: o anúncio abre o WhatsApp direto (pula a LP). A conversa entra por
  `wa_conversations` (platform='meta') via webhook do uazapi, identificada por `ctwa_clid`.
- **Google = LP**: o anúncio cai na LP (`utm_source=google-ads`), o visitante clica no
  WhatsApp → evento `Lead` no `event_log`. O `gclid` é capturado na sessão; um token
  `(ref: XXXXXXXX)` no texto do WhatsApp (set por `shared/renan.js`) liga a conversa à sessão.
- **Qualificado / Venda são MANUAIS**: a atendente marca na lista. Ao marcar, dispara a
  conversão de volta à plataforma de origem — Meta CAPI (`business_messaging`, ctwa_clid) ou
  Google Ads (Data Manager, gclid). QualifiedLead pede confirmação; Venda pede valor.

## Abas / seções

- **Resultados:** visão geral (investimento Meta/Google, CPL, cliques Meta, cliques Google,
  LP view, conversas WPP Meta, conversas WPP Google), gráfico de performance diária
  (investimento × leads/CPL por plataforma), melhores anúncios Meta (top 10), palavras-chave
  de conversão Google (top 10).
- **WhatsApp / Comercial:** funil (leads / qualificados / vendas qtd / valor vendido) + lista
  de leads com marcação manual (Qualificar / Venda / Perdido).
- **Atribuição (UTM):** lead a lead conectado ao número de WhatsApp — resumo por origem +
  tabela detalhada (fonte/mídia, campanha, conteúdo/termo, status) com **tag manual de origem**
  (Indicação / Remarketing / override). Origens canônicas em `functions/origins.js`. UTMs
  pré-estabelecidas: `google-ads`, `google-meu-negocio`, `instagram-bio`, `meta-ads`,
  `tiktok-bio`; orgânico = sem UTM (referrer de busca); Indicação/Remarketing = sem UTM, tag manual.

## Notes

- Arquivo único auto-contido (`index.html`); sem build. Tailwind CDN + Chart.js. **Tema
  claro/escuro** (toggle, persistido em `localStorage`), **paleta e logo do site**
  (`--primary #0e5353`, `--accent #157776`, `--secondary #6ccbbc`; fontes Montserrat/Fira Sans
  self-hosted de `/shared/fonts/`; logo `/images/logo.webp`). Cores de plataforma: Meta azul,
  Google âmbar.
- **Não scaffoldar a partir de `_template/`** — é ferramenta interna, no espírito do `/dash`.
- Atribuição: Meta = `utm_source=meta-ads`/ctwa; Google = `utm_source=google-ads`
  (+ `utm_term` = palavra-chave). CPL = investimento ÷ leads por plataforma.
- **Infra-first:** `wa_conversations` / `google_keyword_stats` podem ainda não estar migradas
  ou populadas; a API degrada para vazio e o painel renderiza assim mesmo. Custo do Meta vem
  do `ad_spend` (cron); custo/keywords do Google ficam zerados até o sync de relatórios do
  Google Ads (`/api/sync/google-ads`, stub) ser implementado e ter credenciais.

## Endpoints e tabelas

- `functions/api/campaign-report.js` (read), `functions/api/leads-inbox.js` (read),
  `functions/api/utm-attribution.js` (read, atribuição lead a lead),
  `functions/api/mark-conversion.js` (write — funil + `action:'origin'` p/ tag manual + dispara conversão),
  `functions/origins.js` (taxonomia de origens).
- Top anúncios Meta: só campanhas que **gastaram verba** (`HAVING SUM(spend_cents) > 0`).
- Tabelas: `ad_spend`, `event_log`, `sessions`, `sync_log`, e as novas
  `wa_conversations` (0018, + `manual_origin`/`utm_medium` em 0021), `conversion_fires` (0019),
  `google_keyword_stats` (0020).
- Webhook do uazapi: `functions/webhook/uazapi/[slug].js` (stub, gated por `UAZAPI_WEBHOOK_SECRET`).

## Change log

- 2026-05-20 — página criada (resultados de campanha Meta Ads).
- 2026-06-14 — redesign dual-platform (Meta+Google) + estrutura de WhatsApp/comercial
  (lista de leads, marcação manual de qualificado/venda com disparo à origem), tema
  claro/escuro, paleta + logo do site.
- 2026-06-14 — logo do modo escuro: variante `images/logo-dark.webp` (parte cinza
  "NAVES"+subtítulo recolorida p/ branco, "RENAN" segue ciano), troca via CSS
  (`.logo-light`/`.logo-dark` sob `[data-theme="dark"]`) pra ficar legível no fundo escuro.
