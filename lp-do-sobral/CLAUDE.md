# Page: lp-do-sobral

URL: `/lp-do-sobral/`

## Brief

- **Purpose:** Captura de inscrições (nome + e-mail) para o evento online "A Nova Gestão de Tráfego" — réplica visual da LP de referência do Pedro Sobral (`ads-a-v2`).
- **Offer:** Vaga gratuita no evento de 18 a 24 de maio, às 20h. Conteúdo inédito sobre tráfego pago.
- **CTA URL:** (formulário inline — não há POST para terceiros; a tracking stack deste repo é o destino)
- **Integrations:** Meta Pixel + CAPI via a tracking stack (`/tracker`) — evento `Lead` no submit e `Lead31Plus` na faixa 31+ do quiz. Respostas do quiz persistidas em D1 via `/quiz-response` (tabela `quiz_responses`). GA4 desligado. Ver `CLAUDE.md` da raiz, seção `## Tracking`.
- **Deadline / launch date:** —

## TODOs antes de publicar

- [ ] **Foto do palestrante:** substituir `assets/hero.webp` (placeholder atualmente) pela foto real do Sobral. Aspect ratio esperado: ~520×600 (já fixado nos atributos `width`/`height` para evitar CLS).
- [ ] **OG image:** substituir `assets/og.jpg` (placeholder).
- [ ] **Páginas legais:** os 3 links do footer (`Política de Privacidade`, `Política de Cookies`, `Termos de Uso`) apontam para `#`. Trocar pelas URLs reais.
- [ ] **Link do grupo do WhatsApp:** o `<a id="quizWhats">` no final do quiz aponta para `#`. Substituir pela URL real do grupo (`https://chat.whatsapp.com/...`).
- [x] **Trackers:** Meta Pixel no `<head>` (`fbq('init', '<META_PIXEL_ID>')` + PageView dual-fire) e eventos `Lead` / `Lead31Plus` via `/tracker` (Meta CAPI server-side). GA4 ficou de fora — só Meta.
- [x] **Endpoint do form / persistir respostas do quiz:** o submit dispara `Lead` (pixel + CAPI) e abre o quiz; ao concluir/declinar, o quiz faz `POST /quiz-response` → tabela D1 `quiz_responses`.

## Notes

- **Identidade própria:** esta página NÃO segue a paleta Stripe-style do resto do repo (`/captura`, `/vendas`, `/links`). Fonte é `Barlow` via Google Fonts; fundo preto + bloco azul royal (`#1e40af`) + CTA verde-limão (`#84cc16`).
- **Layout:** desktop é split 2 colunas (esquerda preta com headline + form; direita azul com logo + chips + foto), com 2 faixas verticais decorativas de 32px nas bordas. Mobile (≤900px) faz stack vertical e some com as faixas.
- **Logo do evento:** composição em CSS puro (`<div class="logo">`), não é imagem. Linha "A NOVA" + régua + "GESTÃO *de* TRÁFEGO" (com "de" em itálico). Reaproveitada no header da coluna direita e no footer.
- **Faixas decorativas:** texto `#ANOVAGESTAODETRAFEGO` repetido na vertical via `writing-mode: vertical-rl`. Texto exato da referência era ilegível nos screenshots — ajustar quando confirmado.
- **Form:** 2 inputs (nome + e-mail) em grid 2-col no desktop, 1-col no mobile. CTA full-width abaixo. Validação HTML5 + handler client-side. No submit válido, esconde o form e abre o quiz modal (ver abaixo).
- **Quiz de qualificação pós-form:** modal não-fechável (sem X, sem ESC, sem backdrop-close) com até 5 perguntas single-choice em sequência (idade, gênero, escolaridade, conhecimento prévio sobre tráfego pago, experiência subindo anúncios). UI: card branco sobre overlay escuro, radios custom, botão azul "Próxima" (desabilitado até selecionar) + "Voltar" (some na Q1). Lista de perguntas hardcoded no array `QUESTIONS` dentro do `<script defer>`. Respostas ficam em memória (`answers`) — destino futuro é banco.
- **Bifurcação por escolaridade (Q3):** o quiz tem dois desfechos. Se a resposta de Q3 for exatamente `Superior completo` (constante `QUALIFYING_EDUCATION`), o lead segue pra Q4 e Q5 e termina na tela `#quizFinish` com o CTA verde "Entrar no grupo do WhatsApp" (`<a id="quizWhats" href="#">` — TODO trocar pelo link real). Qualquer outra resposta encerra o quiz logo após Q3 e mostra `#quizDecline` ("Obrigado pela sua participação… inscrição confirmada por e-mail") — sem CTA pro WhatsApp. Q4 e Q5 não são coletadas nesse caminho. Para mudar o critério, ajustar `EDUCATION_QUESTION_INDEX` / `QUALIFYING_EDUCATION` no topo da IIFE do `<script defer>`.
- **Acessibilidade:** labels com `.sr-only`, `<noscript>` com fallback, contraste OK (verde lime sobre preto + branco sobre azul royal). Modal usa `role="dialog"` + `aria-modal="true"` + `aria-labelledby` apontando pra pergunta atual; `h2.quiz-question` com `tabindex="-1"` recebe foco programático a cada step.
- **Tracking — Meta Pixel:** no `<head>`, snippet padrão do Pixel + `fbq('init', '<META_PIXEL_ID>')` (o mesmo número da env var `META_PIXEL_ID` no Pages) + PageView dual-fire (`fbq('track','PageView')` + `fetch('/tracker', {event_name:'PageView'})`, deduplicado por `event_id`). `<link rel="preconnect" href="https://connect.facebook.net" crossorigin>` ativo. GA4 não foi incluído (só Meta).
- **Tracking — evento `Lead`:** disparado no submit válido do form, **antes** de abrir o quiz: `fbq('track','Lead', {}, {eventID})` + `fetch('/tracker', {event_name:'Lead', event_id, event_time, event_source_url, user_data:{ em: email, fn: first_name }})`. Não-bloqueante — o modal abre na hora. `/tracker` hasheia o PII (SHA-256), enriquece com `fbp`/`fbc`/UTMs da session, e relaya pra Meta CAPI. Pixel + CAPI deduplicados por `event_id`.
- **Tracking — evento `Lead31Plus` (31+ anos):** custom event disparado **uma vez** quando a pessoa escolhe uma faixa de 31 anos ou mais na Q1 do quiz e clica "Próxima". Constantes no topo da IIFE do `<script defer>`: `AGE_QUESTION_INDEX = 0` e `AGE_31_PLUS_BANDS = ['Entre 31 e 35 anos','Entre 36 e 40 anos','Entre 41 e 50 anos','Acima de 50 anos']`; flag `lead31Fired` impede re-disparo se a pessoa voltar e avançar de novo. Enviado via `fbq('trackCustom','Lead31Plus', {}, {eventID})` + `/tracker` com o mesmo `user_data` (em + fn). No Meta Ads, criar a conversão custom em cima do evento `Lead31Plus` (pode rotular como "Lead31+"). Aparece em `event_log` mas **não** na aba Leads do `/dash` (que filtra `event_name = 'Lead'`) — consultar via `wrangler d1 execute ... "SELECT ... FROM event_log WHERE event_name='Lead31Plus'"`.
- **Tracking — persistência do quiz:** em `showFinish()` e `showDecline()`, `fetch('/quiz-response', {method:'POST', keepalive:true, body: JSON.stringify({ first_name, email, answers, qualified, event_source_url })})`. Grava uma linha em `quiz_responses` (D1), ligada à session via `_krob_sid`. `qualified` = `true` no `showFinish` (Superior completo → Q4/Q5), `false` no `showDecline`. Endpoint: `functions/quiz-response.js`; schema: `migrations/0016_quiz_responses.sql`.
- **Captura de atribuição:** automática via o edge middleware (`functions/_middleware.js`) — cookies `_krob_sid`/`_fbp`/`_fbc`/`_krob_eid` (400 dias) + linha em `sessions` com `fbclid`/`gclid`/UTMs. Anúncios devem sempre trazer `?utm_source=...&utm_medium=...&utm_campaign=...` na URL, senão chega como "(empty)" no dashboard.

## Change log

- 2026-05-07 — initial scaffold
- 2026-05-07 — add post-signup qualification quiz modal (5 perguntas → CTA WhatsApp)
- 2026-05-07 — quiz: bifurcar por escolaridade (Q3). Só "Superior completo" segue pra Q4/Q5 + CTA WhatsApp; demais encerram com tela de agradecimento
- 2026-05-11 — tracking: Meta Pixel no `<head>` + PageView; evento `Lead` no submit (em+fn); custom event `Lead31Plus` na faixa 31+ da Q1; persistência do quiz em D1 via `POST /quiz-response`. Tudo via a tracking stack mesclada no repo (Meta CAPI server-side, GA4 off).
