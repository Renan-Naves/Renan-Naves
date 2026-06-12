# Page: vendas

URL: `/vendas/`

## Brief

- **Purpose:** Página de vendas do **TrackStart — API de conversões pelo Google Tag Manager**. Copy ainda em lorem ipsum; tracking + checkout completos.
- **Offer:** Curso TrackStart (Hotmart product code `X97540270M`, offer `rv7lryct`, ID `4959432`).
- **CTA URL:** hero + final CTA são scroll-to-`#preco`; o botão dentro de `#preco` (`#checkout-btn`) redireciona pro Hotmart com `xcod=<trk>` (+ `sck=<utm-bundle>` se houver UTMs).
- **Integrations:** Meta Pixel + CAPI via a tracking stack deste repo. `PageView` no load, `InitiateCheckout` no clique do botão de preço (com `content_ids: ['4959432']`), `Purchase` server-side via webhook Hotmart (`/webhook/hotmart/<HOTMART_WEBHOOK_SLUG>`). Snapshot de atribuição via `POST /checkout-session` no load. Ver `CLAUDE.md` da raiz, seção `## Tracking`.
- **Deadline / launch date:** —

## Structure

1. Sticky nav + wordmark
2. Hero (headline + subhead + CTA + fine print)
3. Módulos e entregáveis (grid 2×2)
4. Depoimentos (3 cards)
5. Para quem é (big quote)
6. Preço (price card com glow, lista de entregáveis, CTA)
7. Professor (card com avatar + bio + credenciais)
8. FAQ (details/summary nativo)
9. CTA final

## Notes

- Toda a copy é lorem ipsum — substituir antes de publicar.
- Avatares são placeholders em gradiente com iniciais (MS, RC, JA, LI). Trocar por imagens reais (`/vendas/assets/...`) e lembrar do `loading="lazy"`.
- Preço: R$ 497 hardcoded — ajustar.
- O `.price-wrap::before` gera um glow suave atrás da caixa de preço. Se ficar pesado em mobile, reduzir o blur ou remover.
- FAQ usa `<details>` nativo — não precisa de JS.
- **Tracking — Meta Pixel:** no `<head>`, snippet padrão do Pixel + `fbq('init', '<META_PIXEL_ID>')` + PageView dual-fire (`fbq + /tracker`, deduplicado por `event_id`). `<link rel="preconnect" href="https://connect.facebook.net" crossorigin>` ativo. GA4 não foi incluído.
- **Tracking — InitiateCheckout:** no `<script defer>` no fim do `<body>`. Roda no clique do `#checkout-btn`. Constantes no topo da IIFE: `CHECKOUT_URL`, `CONTENT_IDS`, `CONTENT_NAME` — ajuste se trocar de oferta/produto. Dual fire (`fbq('track','InitiateCheckout', custom_data, {eventID})` + `navigator.sendBeacon('/tracker', ...)`) com o mesmo `event_id` e `content_type='product'` + `content_ids` + `content_name`. Depois aplica `xcod=<trk>` na URL do Hotmart e, se houver UTMs, empacota em `sck` como pipe-bundle URL-encoded. `setTimeout` de 80ms antes do redirect pra o beacon flushear em Android Chrome.
- **Tracking — Purchase (server-side):** disparado pelo webhook do Hotmart em `/webhook/hotmart/<HOTMART_WEBHOOK_SLUG>` (`functions/webhook/hotmart/[slug].js`). Filtra `PURCHASE_APPROVED + status APPROVED`; outros eventos (REFUND, CHARGEBACK, COMPLETE) retornam 200 e são ignorados. Olha `data.purchase.origin.xcod` (`trk`) → faz lookup em `checkout_sessions` → fan-out: Meta CAPI Purchase (com `value`, `currency`, `content_ids`, `content_type='product'`, user_data hasheada + fbp/fbc/IP/UA) e INSERT em `purchase_log` + `purchase_items` (invariante: `SUM(items.value) = parent.value`, rollback se falhar). Não há pixel client-side de Purchase — `pay.hotmart.com` é outro origin. UNIQUE em `transaction_id` (migration 0012) protege contra retries.
- **trk:** UUID v4 em `sessionStorage['krob_trk']`. Sobrevive a refreshes na mesma aba; uma aba nova ganha um trk novo (nova "intenção de compra"). É a ponte que liga a session client-side ao webhook server-side via `xcod`.
- **Para mudar produto/oferta:** edite as constantes `CHECKOUT_URL`, `CONTENT_IDS`, `CONTENT_NAME` no topo da IIFE no fim do `<body>` da `vendas/index.html`. `CONTENT_IDS` deve casar com o `product.id` numérico que o Hotmart entrega no webhook (não o ucode).

## Change log

- 2026-04-21 — initial scaffold
- 2026-05-13 — tracking + checkout: Pixel no `<head>` + PageView; `POST /checkout-session` no load; `InitiateCheckout` no clique do `#checkout-btn` com redirect para Hotmart (`xcod=<trk>`); webhook server-side `/webhook/hotmart/[slug]` dispara `Purchase` para Meta CAPI + grava em `purchase_log` + `purchase_items`. Produto: TrackStart (X97540270M / ID 4959432).
