# Google Ads MCP (oficial, read-only) — setup

Servidor MCP **oficial** do Google ([google-marketing-solutions/google_ads_mcp](https://github.com/google-marketing-solutions/google_ads_mcp)),
lançado em 28/04/2026. Permite que o Claude leia a conta do Google Ads por linguagem natural
(consultas GAQL). É **estritamente read-only** por padrão (não pausa campanha, não muda lance,
não cria nada — `ADS_MCP_ENABLE_MUTATIONS` fica `false`).

Expõe 3 ferramentas: `list_accessible_customers`, `search` (GAQL), `get_resource_metadata`.

> **Para que serve aqui:** inspeção interativa da conta do Dr. Renan (`978-281-8062`) via o MCC
> One Tree Eitch `337-869-8997` (**CONFIRMAR** — o doc do token tem 336 vs 337 inconsistente). O
> fluxo de produção do site NÃO depende disto — conversões usam a Data Manager
> API e o relatório do dashboard usa `functions/api/sync/google-ads.js`. O MCP é só uma
> ferramenta de análise para nós.

## ⚠️ Bloqueio atual: o mesmo developer token

O MCP **exige o `developer_token`** da Google Ads API (igual ao sync de relatório). Hoje o token
está em **Test Access**, que só alcança **contas de teste** — não a conta real. Para o MCP ler a
conta de produção, é preciso o **Basic Access** aprovado (ver `docs/google-ads-api-application.md`).
Enquanto isso não sai, dá para conectar e testar só contra conta de teste.

## Pré-requisitos (não instalados nesta máquina)

- **Python 3.11+** e **uv** (gerenciador). Nenhum dos dois está instalado aqui hoje.
  - Instalar uv (PowerShell): `irm https://astral.sh/uv/install.ps1 | iex`
  - (Máquina intercepta TLS — se o download falhar, use o instalador `.msi`/Python do site oficial.)
- **git** (já tem).

## Passo a passo para ATIVAR

1. **Clonar o servidor** (fora do conteúdo publicável — `_tools/` está no `.gitignore`):
   ```sh
   git clone https://github.com/google-marketing-solutions/google_ads_mcp.git "b:/One Tree Eitch/Clientes/RENAN NAVES/_tools/google_ads_mcp"
   ```

2. **Criar `google-ads.yaml`** na raiz do projeto (já gitignorado) a partir de
   `google-ads.yaml.example`, preenchendo com as credenciais (as mesmas dos env vars
   `GOOGLE_ADS_*` do Cloudflare):
   ```yaml
   developer_token: "SEU_DEVELOPER_TOKEN"        # 22 chars; precisa de Basic Access p/ conta real
   client_id: "...apps.googleusercontent.com"
   client_secret: "..."
   refresh_token: "..."                          # escopo https://www.googleapis.com/auth/adwords
   login_customer_id: "3378698997"               # MCC (337-869-8997), só dígitos — CONFIRMAR
   use_proto_plus: true
   ```

3. **Registrar no Claude Code em USER SCOPE** (global — disponível em TODOS os seus projetos,
   não só neste repo). Rodar uma vez:
   ```sh
   claude mcp add google-ads --scope user \
     --env GOOGLE_ADS_CREDENTIALS="b:/One Tree Eitch/Clientes/RENAN NAVES/google-ads.yaml" \
     -- uv run --directory "b:/One Tree Eitch/Clientes/RENAN NAVES/_tools/google_ads_mcp" -m ads_mcp.server
   ```
   Isso grava em `~/.claude.json` (config global do usuário), igual a ter o servidor "no Claude
   como um todo". (Windows: se `uv` não for encontrado pelo Claude, prefixe o comando com
   `cmd /c` ou use o caminho absoluto do `uv.exe`.)

   **Alternativa — só este projeto (project scope):** copiar `.mcp.json.example` para `.mcp.json`
   na raiz (gitignorado). Use isto se NÃO quiser o servidor global.

4. **Reabrir o Claude Code** e aprovar o servidor `google-ads` quando perguntado (`/mcp` lista o
   status). Testar com algo como "liste as contas acessíveis" (`list_accessible_customers`).

## Notas

- `developer_token`, `client_secret`, `refresh_token` são **segredos** — só no `google-ads.yaml`
  local, nunca no git. `google-ads.yaml`, `.mcp.json` e `_tools/` estão no `.gitignore`.
- Read-only é o padrão (`ADS_MCP_ENABLE_MUTATIONS` não setado). **Não** habilite mutations para
  uma ferramenta de análise.
- Reuso de credenciais: são as MESMAS do reporting sync (client id/secret + refresh com escopo
  `adwords` + dev token + MCC). Ver `## Tracking` no `CLAUDE.md` raiz.
