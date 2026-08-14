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

## Estado atual (2026-08-14): TODAS as abas ligadas

O soft-disable foi **revertido** — `var DISABLED_TABS = [];` no `dashboard/index.html`. As três abas
(Resultados, WhatsApp/Comercial, Atribuição) estão visíveis e o sistema de atendimento está no ar.
O mecanismo continua existindo: para desativar uma aba de novo, basta pôr o id dela
(`'whatsapp'` | `'atribuicao'`) na lista — esconde o botão e curto-circuita o loader.

**⚠️ Uma pendência fora do código bloqueia só o disparo de conversão Meta (CTWA)** — ver
`## Conversão CTWA: bloqueio do lado da Meta`. Todo o resto (inbox, thread, resposta, marcação
de funil, atribuição, indicações) funciona.

## Funil (modelo desta LP — sem formulário)

- **Meta = CTWA**: o anúncio abre o WhatsApp direto (pula a LP). A conversa entra por
  `wa_conversations` (platform='meta') via webhook do uazapi, identificada por `ctwa_clid`.
- **Google = LP**: o anúncio cai na LP (`utm_source=google-ads`), o visitante clica no
  WhatsApp → evento `Lead` no `event_log`. O `gclid` é capturado na sessão; um token
  `#xxxxxxxx` no texto do WhatsApp (set por `shared/renan.js`; aceita o legado `(ref: xxxxxxxx)`) liga a conversa à sessão.
- **Qualificado / Venda são MANUAIS**: a atendente marca na lista. Ao marcar, dispara a
  conversão de volta à plataforma de origem — Meta CAPI (`business_messaging`, ctwa_clid) ou
  Google Ads (Data Manager, gclid). QualifiedLead pede confirmação; Venda pede valor.

## Abas / seções

- **Resultados:** visão geral (investimento Meta/Google, CPL, cliques Meta, cliques Google,
  LP view, conversas WPP Meta, conversas WPP Google), gráfico de performance diária
  (investimento × leads/CPL por plataforma), melhores anúncios Meta (top 10), palavras-chave
  de conversão Google (top 10).
- **WhatsApp / Comercial:** funil (leads / qualificados / vendas qtd / valor vendido) + lista
  de leads com marcação manual (Qualificar / Venda / Perdido). **Mini-CRM:** cada linha tem uma
  bolinha de atendimento (🔴 nova não lida / 🟡 lida sem resposta / 🟢 aguardando o lead, derivada
  de `last_inbound_at`/`last_outbound_at`/`last_viewed_at`); clicar na linha abre um pop-up com o
  thread de mensagens (`GET /api/conversation-detail?mark_read=1`, que zera a bolinha) + caixa de
  envio (`POST /api/send-message`). Botões de **Arquivar/Desarquivar** e **Excluir** na linha e no
  pop-up; sub-aba **Arquivados** (`?archived=1`).
- **Atribuição (UTM):** lead a lead conectado ao número de WhatsApp — resumo por origem +
  tabela detalhada (fonte/mídia, campanha, conteúdo/termo, status) com **tag manual de origem**
  (Indicação / Remarketing / override). Origens canônicas em `functions/origins.js`. UTMs
  pré-estabelecidas: `google-ads`, `google-meu-negocio`, `instagram-bio`, `meta-ads`,
  `tiktok-bio`; orgânico = sem UTM (referrer de busca); Indicação/Remarketing = sem UTM, tag manual.
  Clicar no **nome** abre o pop-up de detalhes (todos os ids/UTMs + histórico de `conversion_fires`,
  via `conversation-detail` com `mark_read=0`), com Arquivar/Excluir.
- **Excluir = soft-delete:** marca `deleted_at`, some das listas, mas preserva atribuição/auditoria.
  Pede confirmação digitando o **nome exato** do contato. **Arquivar** marca `archived_at` (some das
  abas normais, aparece só em "Arquivados"); desarquivar limpa.

## Conversão CTWA: bloqueio do lado da Meta (investigado 2026-08-14)

Marcar **Qualificado/Venda** num lead do Meta dispara um evento `business_messaging` por
`ctwa_clid`. Hoje esse disparo **falha** — a marcação no funil funciona, mas a Meta não recebe
o sinal (a UI avisa: "Marcado no funil, mas a conversão NÃO foi enviada…").

O que foi isolado (com um `ctwa_clid` REAL, capturado de um anúncio de verdade):
- O clid está **certo**: o valor decodificado passa na validação da Meta; o base64 cru é
  rejeitado com subcode 2804087. Ou seja, a captura e o decode estão corretos.
- O erro é sempre `code 1 / "An unknown error has occurred"` (HTTP 500), **independente** de:
  nome do evento (custom `QualifiedLead` ou padrão `Purchase`), identificador de conta
  (`whatsapp_business_account_id`, `page_id` ou nenhum) e `test_event_code` (com ou sem).
- Testado contra os 3 datasets do BM: o de mensagens e o da LP dão o mesmo `code 1`; o antigo
  dá subcode 33 (o token não o alcança).
- **O dataset configurado (`META_WA_PIXEL_ID` = 973421805455371, "Pixel WhatsApp") nunca recebeu
  um único evento** (`last_fired_time` = epoch zero) e foi criado à mão. Um `GET` nele com o
  token retorna `(#100) Missing Permission`.

**Causa mais provável, refinada em 2026-08-14 (2ª rodada, já sem `META_WA_TEST_EVENT_CODE`):**
o token **não enxerga a WABA**. Sondagem com o `META_WA_ACCESS_TOKEN`:
- `GET /me` → **200**, id `122119147191363950` (o token é válido e autentica);
- `GET /437676086092498` (a WABA de `META_WA_BUSINESS_ACCOUNT_ID`) → **400**, "Object with ID does
  not exist, cannot be loaded due to missing permissions";
- `GET /111747308497370` (a page) → 400 por falta de `pages_read_engagement` (esperado, inconclusivo).

A page **está correta** (é a única do BM: "Dr. Renan Naves"). Como um `ctwa_clid` real é resolvido
contra a WABA dona da conversa, um token que não consegue nem ler a WABA não consegue atribuir —
o que casa com o `code 1` genérico só aparecer **depois** que o clid passa na validação.

Então é uma de duas (ou as duas): (a) `META_WA_BUSINESS_ACCOUNT_ID` está com o id errado, ou (b) o
system user / app que gerou o token não tem acesso à WABA (falta adicioná-lo em Configurações do
Negócio → Contas do WhatsApp → Pessoas/Apps, com `whatsapp_business_management` + `business_management`,
e **gerar o token de novo** — escopo novo não vale para token já emitido). Vale checar também se o
número, conectado via **uazapi (WhatsApp Web/Baileys, não a Cloud API oficial)**, tem uma WABA oficial.

**Restrição de categoria (saúde) — problema SEPARADO, não é a causa do `code 1`.** O BM mostra
"Foram aplicadas restrições à partilha de dados… categorias com restrições". É a mesma restrição que
já suprimiu o evento padrão `Lead` no pixel da LP. Quando ela bate, a Meta **aceita e descarta em
silêncio** (a CAPI responde `events_received:1`) — não devolve 500. Regra prática que vale aqui:
**evento padrão é suprimido, customizado passa**. `QualifiedLead` já é customizado; **`Purchase` é
padrão e tende a ser descartado** — quando a WABA for resolvida, renomear para algo como
`VendaWhatsApp` e criar a conversão personalizada correspondente no Events Manager.
Sanidade dos datasets (2026-08-14): "Pixel WhatsApp" = **0 eventos em 7 dias**; "Pixel LP Dr Renan" =
`PageView` + `AgendamentoWhatsApp` entrando normalmente (a volta do evento customizado funciona).

Diagnóstico p/ retomar: `GET /api/test-meta-conversion?key=DASH_KEY&type=qualified` com
`&ctwa_clid=<real>` (pegue um em `wa_conversations`), `&no_test_code=1` (dispara de verdade),
`&pixel=<dataset>`, `&ids=waba|page|none`, `&waba=`/`&page_id=`, `&age_days=`.

**RESOLVIDO 2026-08-14:** `META_WA_TEST_EVENT_CODE` foi removida das env vars de produção
(verificado no runtime: o payload já sai sem `test_event_code`). As conversões marcadas agora vão
para produção — não para Test Events.

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

- `functions/api/campaign-report.js` (read), `functions/api/leads-inbox.js` (read — inclui `dot`,
  filtros `deleted_at`/`archived_at` + `?archived=1`), `functions/api/utm-attribution.js` (read,
  atribuição lead a lead), `functions/api/conversation-detail.js` (read — thread + sessão + fires,
  `?mark_read=1` zera a bolinha), `functions/api/mark-conversion.js` (write — funil + `action:'origin'`
  + `archive`/`unarchive`/`delete`; dispara conversão só em qualified/sale), `functions/api/send-message.js`
  (write — envia resposta no WhatsApp via uazapi), `functions/origins.js` (taxonomia de origens).
- Top anúncios Meta: só campanhas que **gastaram verba** (`HAVING SUM(spend_cents) > 0`).
- Tabelas: `ad_spend`, `event_log`, `sessions`, `sync_log`, e as novas
  `wa_conversations` (0018, + `manual_origin`/`utm_medium` em 0021, + colunas CRM em 0023),
  `wa_messages` (0022, thread do CRM), `conversion_fires` (0019), `google_keyword_stats` (0020).
- Webhook do uazapi: `functions/webhook/uazapi/[slug].js` (grava cada mensagem em `wa_messages`;
  gated por `UAZAPI_WEBHOOK_SECRET`). Envio precisa de `UAZAPI_BASE_URL` + `UAZAPI_TOKEN`.

## Change log

- 2026-05-20 — página criada (resultados de campanha Meta Ads).
- 2026-06-14 — redesign dual-platform (Meta+Google) + estrutura de WhatsApp/comercial
  (lista de leads, marcação manual de qualificado/venda com disparo à origem), tema
  claro/escuro, paleta + logo do site.
- 2026-06-14 — logo do modo escuro: variante `images/logo-dark.webp` (parte cinza
  "NAVES"+subtítulo recolorida p/ branco, "RENAN" segue ciano), troca via CSS
  (`.logo-light`/`.logo-dark` sob `[data-theme="dark"]`) pra ficar legível no fundo escuro.
- 2026-06-15 — mini-CRM: pop-up de thread + envio de mensagem (uazapi), bolinha de atendimento
  (🔴/🟡/🟢), pop-up de detalhes na Atribuição (UTM), arquivar/desarquivar (aba "Arquivados") e
  excluir (soft-delete com confirmação digitando o nome). Novas migrations `0022_wa_messages` +
  `0023_wa_conversations_crm`; novos endpoints `conversation-detail` + `send-message`.
- 2026-06-16 — receita & ROAS na aba Resultados (receita total / tráfego / orgânico + ROAS e
  lucro); auto-refresh "ao vivo" (10s) na aba WhatsApp; **grafo de Indicações** na aba Resultados
  (indicador→indicado): ao marcar origem "Indicação" pergunta **quem indicou** (nome+WhatsApp);
  a lista, ordenada pelo indicador, cruza o WhatsApp do indicador com a base p/ trazer origem +
  receita dele ao lado da receita do indicado. Migrations `0024_wa_conversations_referral` +
  `0025_wa_conversations_referral_by`; endpoint `/api/referrals`.
- 2026-06-16 — **soft-disable** das abas **WhatsApp/Comercial** e **Atribuição (UTM)** a pedido do
  cliente (flag `DISABLED_TABS` no `index.html`: esconde botões + guard nos loaders). Só **Resultados**
  fica visível; acompanhamento de leads migrou para o **`/public`** (que ganhou a aba **Eventos** —
  inspeciona o payload Meta CAPI/GA4 enviado). Telefone passou a exibir `(DD) 9 NNNN-NNNN`. Reversível
  removendo a aba de `DISABLED_TABS`.
- 2026-08-14 — **atendimento religado**: `DISABLED_TABS = []` (as três abas no ar). A atribuição
  CTWA passou a funcionar de verdade — o `ctwa_clid` do uazapi vem em
  `message.content.contextInfo.conversionData` (base64), não num objeto `referral`; forma confirmada
  contra payloads reais e backfill feito nas 6 conversas CTWA históricas. A UI agora avisa quando o
  disparo de conversão **falha** (antes só avisava quando era "pulado"). Removido o diagnóstico TEMP
  (`captureRaw` + `/api/wa-debug`) e dropada a `wa_raw_debug` (8.113 payloads, 61 MB → 25 MB, e o
  token do uazapi em texto puro dentro deles). Disparo de conversão Meta segue bloqueado — ver
  `## Conversão CTWA`.
