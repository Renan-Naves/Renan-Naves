# Page: captura

URL: `/captura/`

## Brief

- **Purpose:** Capturar inscrições (e-mail) para as aulas ao vivo de traqueamento — toda terça-feira — e **pré-qualificar o lead** para a Comunidade KROB (ticket R$ 3.000) via um quiz pós-inscrição.
- **Offer:** Aulas ao vivo, semanais (terça), sobre traqueamento.
- **CTA URL:** (formulário inline — não há POST para terceiros; o destino é a tracking stack deste repo + `POST /captura-response`)
- **Integrations:** Meta Pixel + CAPI via a tracking stack (`/tracker`) — evento `Lead` no submit do e-mail e `LeadQualificado` quando o quiz bate o ICP. Respostas do quiz persistidas em D1 via `POST /captura-response` (tabela `captura_responses`). Visíveis no `/dash` na seção "Leads /captura — qualificação". GA4 desligado. Ver `CLAUDE.md` da raiz, seção `## Tracking`, e `docs/TRACKING.md`.
- **Deadline / launch date:** —

## TODOs antes de publicar

- [ ] **Destino de e-mail (ESP/CRM):** o `Lead` vai pra Meta, mas o e-mail não é enviado pra nenhum ESP/CRM ainda. Se quiser nutrição/automação, plugar o submit (ou um webhook a partir de `captura_responses`) num Mailchimp/ConvertKit/RD/CRM.
- [ ] **`META_PIXEL_ID`:** o `fbq('init', '945469125060300')` no `<head>` precisa ser o mesmo número da env var `META_PIXEL_ID` do Pages (mesmo pixel da `/lp-do-sobral`). Confirmar antes de publicar.
- [ ] **Texto da tela final do quiz** (`#quizFinish`): hoje é "Recebemos suas respostas… nosso time pode entrar em contato". Se houver grupo de WhatsApp / próximo passo concreto, trocar.
- [x] **Trackers:** Meta Pixel no `<head>` + PageView dual-fire; `Lead` no submit (`em`); custom event `LeadQualificado` quando o quiz qualifica; persistência em `captura_responses` via `POST /captura-response`.

## Notes

- **Quiz de qualificação pós-inscrição:** ao enviar o e-mail, dispara `Lead` e abre um modal **não-fechável** (sem X, sem ESC, sem backdrop-close) com uma pergunta por vez. É **ramificado por perfil** (1ª pergunta = `profile`: `gestor` / `dono` / `equipe` / `iniciante`):
  - `gestor` → nº de clientes diferentes → faturamento de serviço → verba de anúncios → WhatsApp.
  - `dono` → faturamento do negócio digital → como usa tráfego pago → verba de anúncios → WhatsApp.
  - `equipe` / `iniciante` → 1 pergunta de objetivo → WhatsApp.
  - Última pergunta de todas as trilhas: WhatsApp (input `tel`, ≥ 10 dígitos pra avançar).
  - Todo mundo termina na tela `#quizFinish`; o que diferencia o lead qualificado é só o flag `qualified` no banco + o evento `LeadQualificado` (não há tela de "decline", diferente do quiz do Sobral).
- **Regra de qualificação (`LeadQualificado` / `qualified = true`) — Combo A, espelha o ICP:** `gestor` com 3+ clientes diferentes (`clients_band ∈ {"3 a 5 clientes","6 a 10 clientes","Mais de 10 clientes"}`); **ou** `dono` com faturamento ≥ R$ 10 mil/mês (`business_revenue_band ∈ {"R$ 10–30 mil/mês","R$ 30–100 mil/mês","Acima de R$ 100 mil/mês"}`) **e** `traffic_usage !== "Não invisto ainda"`. `equipe`/`iniciante` nunca qualificam. As strings das opções e os limiares são **constantes no topo da IIFE** do `<script defer>` (`STEP_PROFILE`, `BRANCHES`, `CLIENTS_3PLUS`, `BIZ_10KPLUS`, `TRAFFIC_NONE`, `isQualified()`) — pra retunar, mexer ali.
- **Disparo do `LeadQualificado`:** acontece no meio do quiz, assim que dá pra decidir (`gestor` → logo após a pergunta de clientes; `dono` → logo após a de uso de tráfego, que já vem depois da de faturamento), com flag `leadQualificadoFired` pra não re-disparar. `finishQuiz()` re-avalia por segurança. Custom event → `fbq('trackCustom','LeadQualificado', {}, {eventID})` + `POST /tracker` (mesmo `event_id` → dedup); no Meta Ads, criar uma conversão custom em cima dele.
- **Persistência:** `showFinish()` chama `persistCaptura(qualified)` → `fetch('/captura-response', {keepalive:true, body: {email, phone, profile, *_band, traffic_usage, goal, qualified, answers_json, event_source_url}})`. Grava uma linha em `captura_responses` (D1), ligada à session via cookie `_krob_sid`. Endpoint: `functions/captura-response.js`; schema: `migrations/0017_captura_responses.sql`. `answers_json` = trilha `[{question, answer}, ...]` do que foi respondido (auditoria). `raw_email`/`raw_phone` ficam só em D1 (não saem da infra) pro time comercial.
- **Captura de atribuição:** automática via o edge middleware (`functions/_middleware.js`) — cookies `_krob_sid`/`_fbp`/`_fbc`/`_krob_eid` (400 dias) + linha em `sessions` com `fbclid`/`gclid`/UTMs. Os anúncios devem trazer `?utm_source=...&utm_medium=...&utm_campaign=...` na URL.
- **Dashboard:** seção "Leads /captura — qualificação" no `/dash/?key=<DASH_KEY>` — tabela com e-mail, WhatsApp, perfil, tamanho (nº de clientes ou faturamento), origem (UTM) e flag qualificado; clicar na linha abre todas as respostas + atribuição + `answers_json`. Endpoint: `functions/api/captura-leads.js` (JOIN `captura_responses ⨝ sessions`).
- **Degradação sem o modal:** se o `#quizModal` não estiver no DOM, o submit volta ao comportamento antigo (mostra `#success` inline). O `Lead` ainda é disparado.
- **Sem imagem de hero:** o `<link rel="preload">` do template foi removido de propósito.
- **Design** inspirado em stripe.com/br — gradientes suaves em `::before`/`::after`, tipografia com `-apple-system`, headline com acento em gradiente. O modal do quiz usa essa mesma paleta (card branco, radios roxos `--brand`, botão "Próxima" em gradiente roxo).

## Change log

- 2026-04-21 — initial scaffold
- 2026-05-12 — adiciona quiz de pré-qualificação para a Comunidade KROB: Meta Pixel no `<head>` + PageView; `Lead` no submit do e-mail; modal ramificado por perfil (gestor / dono / equipe / iniciante); evento `LeadQualificado` no Combo A do ICP; persistência em `captura_responses` via `POST /captura-response`; seção "Leads /captura" no `/dash`. Migration `0017_captura_responses.sql`.
