# Sincronização de custo do Meta Ads + dashboard `/dashboard`

Como o custo de anúncios entra no D1 e vira CPL / CPA / ROAS na página `/dashboard`.

## Visão geral do fluxo

```
Cloudflare cron Worker          Pages Function                D1
(cron-worker/, 1×/hora)  ──►  POST /api/sync/meta-ads  ──►  ad_spend  ──┐
                                  │                          sync_log  │
                              Meta Marketing API v22                    │
                                                                        ▼
navegador ──► GET /dashboard ──► GET /api/campaign-report ──► lê ad_spend
                                                              + event_log
                                                              + purchase_log
                                                              + sessions / quizzes
```

Princípio: **tudo que alimenta a métrica está no D1.** A página nunca chama a API da
Meta em tempo de request — só lê tabelas. A API da Meta é tocada apenas pelo cron.

## Componentes

| Componente | Arquivo | Papel |
|---|---|---|
| Cron Worker | `cron-worker/` | Dispara o sync de hora em hora. Worker separado (Pages não tem cron). |
| Endpoint de sync | `functions/api/sync/meta-ads.js` | Puxa custo por anúncio da Meta e faz UPSERT em `ad_spend`. |
| Tabela de custo | `migrations/0013_ad_spend.sql` | `ad_spend` — uma linha por `(platform, date, campaign_id, ad_id)`. |
| Auditoria | `migrations/0014_sync_log.sql` | `sync_log` — uma linha por execução do sync. |
| Endpoint de leitura | `functions/api/campaign-report.js` | Agrega custo + conversões para o dashboard. |
| Página | `dashboard/index.html` | UI: seletor de datas, KPIs, gráfico, CPL por criativo. |

## O sync (`/api/sync/meta-ads`)

- **Auth:** header `x-sync-secret: <SYNC_SECRET>`. Sem o secret → 401.
- **Granularidade:** `level=ad` — uma linha por anúncio por dia. Campos puxados:
  `campaign_id, campaign_name, ad_id, ad_name, spend, impressions, clicks,
  account_currency, date_start`. (O nível de anúncio é necessário para o CPL por
  criativo; o total por campanha continua derivável com `GROUP BY campaign_id`.)
- **Janela:** corpo vazio `{}` → últimos 7 dias. O UPSERT é idempotente
  (índice único `idx_ad_spend_unique`), então reprocessar os últimos 7 dias a cada
  hora corrige números do Meta que ainda estavam consolidando.
- **Valores:** `spend` é gravado como `spend_cents` (inteiro) para evitar erro de float.
- Cada execução grava uma linha em `sync_log` (`status`, `rows_upserted`, `duration_ms`).

## Convenção de CPL / CPA / ROAS

Uma conversão conta como **"do Meta Ads"** quando `utm_source = 'meta-ads'`:

- **Leads** — `event_log` (`event_name='Lead'`, `is_bot=0`) com `JOIN sessions` (a UTM
  mora em `sessions`).
- **Vendas** — `purchase_log` (a `utm_source` está na própria linha).
- **Respostas de quiz** — `captura_responses` + `quiz_responses` com `JOIN sessions`.

```
CPL  = investimento ÷ leads (meta-ads)
CPA  = investimento ÷ vendas (meta-ads)
ROAS = receita (meta-ads) ÷ investimento
```

**CPL por criativo:** o investimento é agrupado por `ad_spend.ad_name` e os leads por
`sessions.utm_content`; os dois são casados pelo nome **normalizado** (minúsculas +
`trim`). Isso só funciona porque o `utm_content` das URLs é preenchido com a macro
`{{ad.name}}` do Meta — o nome do anúncio vira o `utm_content`. Criativos com custo e
sem leads (e leads sem custo casado) aparecem na tabela mesmo assim, sinalizados.

> Atenção a fuso: `ad_spend.date` está no fuso da conta de anúncios; as conversões
> usam `created_at`/`timestamp` em UTC. Para o Brasil (UTC−3) há uma pequena defasagem
> nas bordas do dia — aceitável para leitura de resultados.

## Variáveis de ambiente (projeto Pages → Settings → Environment variables)

| Variável | Para quê |
|---|---|
| `META_ADS_ACCESS_TOKEN` | Token da Meta Marketing API. |
| `META_ADS_ACCOUNT_ID` | ID da conta de anúncios (numérico, sem `act_`). |
| `SYNC_SECRET` | Protege `/api/sync/meta-ads`. Mesmo valor no Worker. |
| `DASH_KEY` | Protege `/dashboard`, `/dash` e `/api/*`. |

Se `META_ADS_ACCESS_TOKEN` / `META_ADS_ACCOUNT_ID` não estiverem setados, o endpoint
responde `200 {skipped:true}` — o cron não falha, e o dashboard mostra investimento
zerado com um aviso.

## Deploy

1. Setar as variáveis acima no projeto Pages e refazer o último deploy (mudança de
   env var não se aplica a deploys já existentes).
2. Subir o cron Worker — ver `cron-worker/README.md`.
3. Página + functions sobem via `git push` na branch conectada.

## Verificação

1. **Sync manual:**
   ```sh
   curl -X POST https://<domínio>/api/sync/meta-ads \
     -H "x-sync-secret: <SYNC_SECRET>" -d '{}'
   ```
   Esperado: `{"ok":true,"rows_upserted":N,...}`.
2. **Conferir o D1:**
   ```sh
   npx wrangler@latest d1 execute <db> --remote \
     --command "SELECT date, ad_name, spend_cents FROM ad_spend ORDER BY date DESC LIMIT 5"
   ```
   As linhas devem ter `ad_id` / `ad_name` preenchidos.
3. **Endpoint:** `GET /api/campaign-report?key=<DASH_KEY>&from=AAAA-MM-DD&to=AAAA-MM-DD`.
4. **Página:** abrir `/dashboard/?key=<DASH_KEY>`, trocar o intervalo, conferir os
   números contra o Gerenciador de Anúncios do Meta.

> Se a tabela `ad_spend` já tiver linhas antigas em nível de campanha (`ad_id IS NULL`,
> de uma versão anterior do sync), elas se somariam às novas linhas por anúncio. Como o
> stack foi ao ar já com sync em nível de anúncio, isso não deve ocorrer; se ocorrer,
> rode uma vez: `DELETE FROM ad_spend WHERE platform='meta' AND ad_id IS NULL;`
