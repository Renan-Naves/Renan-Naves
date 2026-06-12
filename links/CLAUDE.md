# Page: links

URL: `/links/`

## Brief

- **Purpose:** Página estilo Linktree — concentra todos os links oficiais em um único lugar.
- **Offer:** —
- **CTA URL:** primeiro card (`.link.featured`) é o destaque da vez — trocar quando a campanha rodar.
- **Integrations:** Pendente — `href="#"` em todos os links; substituir por URLs reais.
- **Deadline / launch date:** —

## Structure

1. Avatar com iniciais em gradiente + handle + selo de "verificado" (SVG inline)
2. Bio curta
3. Link destacado (primary gradient) — card em destaque da campanha atual
4. Links padrão (Site, Newsletter, YouTube, Instagram, LinkedIn)
5. Divisor "Mais"
6. Links secundários (GitHub, WhatsApp)
7. Linha de redes sociais (ícones circulares)
8. Wordmark no rodapé

## Notes

- Avatar é um placeholder em gradiente com iniciais ("LI"). Substituir por `<img>` com `loading="lazy"` e `decoding="async"` quando tiver foto real.
- Todos os ícones são SVG inline (Feather-style, stroke 2) — não há dependência externa.
- O card destacado usa o mesmo gradiente do botão primário de `/captura/` e `/vendas/` para manter consistência.
- Para adicionar rastreamento de cliques, envolver cada `<a>` com um `data-link="..."` e escutar com um único listener em `<script defer>`.

## Change log

- 2026-04-21 — initial scaffold
