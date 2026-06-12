# cron-worker — sincronização horária do Meta Ads

Worker Cloudflare que, **de hora em hora**, chama o endpoint `POST /api/sync/meta-ads`
do projeto Pages. Esse endpoint puxa o custo por anúncio da Meta Marketing API e grava
na tabela `ad_spend` do D1, que alimenta a página `/dashboard`.

É um Worker **separado** do projeto Pages porque o Cloudflare Pages não tem cron nativo
— só Workers têm. Ele não serve páginas nem cookies; é apenas o agendador. A lógica de
sync continua única, em `functions/api/sync/meta-ads.js`.

## Pré-requisitos

No **projeto Pages** (Cloudflare dashboard → Settings → Environment variables) já devem
existir, em Production:

- `META_ADS_ACCESS_TOKEN` — token da Meta Marketing API
- `META_ADS_ACCOUNT_ID` — ID da conta de anúncios (numérico, sem `act_`)
- `SYNC_SECRET` — string aleatória (`openssl rand -hex 32`)

## Deploy (uma vez)

Os comandos `wrangler` deste repo usam o perfil Cloudflare **`borkcursos`** — rode
`cf-on borkcursos` antes (e lembre do quirk de exportar `_cf_profiles_file` na mesma
chamada de shell). Depois:

1. **Ajuste a URL** — em `wrangler.toml`, troque `<your-domain>` em `SYNC_URL` pelo
   domínio real do projeto Pages (ou a URL `*.pages.dev`).

2. **Deploy do Worker:**
   ```sh
   cd cron-worker
   npx wrangler@latest deploy
   ```

3. **Configure o secret** (mesmo valor do `SYNC_SECRET` do projeto Pages):
   ```sh
   npx wrangler@latest secret put SYNC_SECRET
   ```

4. **Confirme o cron** — Cloudflare dashboard → Workers & Pages → `krob-meta-ads-cron`
   → Triggers → deve listar `0 * * * *`.

## Testar manualmente

O Worker aceita um disparo manual, protegido pelo mesmo secret:

```sh
curl "https://krob-meta-ads-cron.<sua-conta>.workers.dev/?secret=<SYNC_SECRET>"
```

Resposta `{"ok": true, ...}` → sync funcionou. Confira a tabela `sync_log` no D1 e a
página `/dashboard`. Sem o secret correto o Worker responde `404`.

## Notas

- Cadência: `crons = ["0 * * * *"]` em `wrangler.toml`. O endpoint refaz sempre os
  últimos 7 dias (upsert idempotente), então rodar de hora em hora corrige números do
  Meta que ainda estavam consolidando.
- Logs: `npx wrangler@latest tail` (com o worker selecionado) mostra cada execução.
- Sem `package.json` / sem build — Worker de arquivo único, no mesmo espírito do repo.
