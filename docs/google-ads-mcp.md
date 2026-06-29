# Google Ads MCP (oficial, read-only) — instalado em escopo global

Servidor MCP **oficial** do Google: [`github.com/googleads/google-ads-mcp`](https://github.com/googleads/google-ads-mcp).
Read-only: `search` (GAQL), `get_resource_metadata`, `list_accessible_customers`. Doc:
https://developers.google.com/google-ads/api/docs/developer-toolkit/mcp-server

> Permite consultar a conta do Google Ads por linguagem natural no Claude. O fluxo de produção do
> site NÃO depende disto — conversões usam a Data Manager API e o relatório do `/dashboard` usa
> `functions/api/sync/google-ads.js`. O MCP é ferramenta de análise.

## Como foi instalado (2026-06, máquina do Bruno)

- **Runtime:** `uv` em `C:\Users\bruno\.local\bin\uv.exe`.
- **Servidor:** clonado em `_tools/google_ads_mcp` (gitignorado); deps via `uv sync --system-certs`
  (a máquina intercepta TLS → precisa de system certs). Lançado por `uv run --frozen ... python -m ads_mcp.server`.
- **Credenciais:** ADC (Application Default Credentials), em `C:\Users\bruno\.google-ads-mcp\` (sem espaços, fora do repo):
  - `adc.json` — `{type:"authorized_user", client_id, client_secret, refresh_token}` (refresh com escopo `adwords`).
  - `mcp.env` — `GOOGLE_APPLICATION_CREDENTIALS` (→ adc.json), `GOOGLE_ADS_DEVELOPER_TOKEN`,
    `GOOGLE_PROJECT_ID`, `GOOGLE_ADS_LOGIN_CUSTOMER_ID=3378698997`, `UV_SYSTEM_CERTS=1`.
  - São os MESMOS valores das env vars `GOOGLE_ADS_*` do Cloudflare (reporting sync).
- **Registro (escopo global):** `~/.claude.json` → `mcpServers.google-ads`:
  ```json
  {
    "type": "stdio",
    "command": "C:/Users/bruno/.local/bin/uv.exe",
    "args": ["run","--frozen","--directory","b:/One Tree Eitch/Clientes/RENAN NAVES/_tools/google_ads_mcp",
             "--env-file","C:/Users/bruno/.google-ads-mcp/mcp.env","python","-m","ads_mcp.server"],
    "env": { "UV_SYSTEM_CERTS": "1" }
  }
  ```
  (Não usamos o console script `google-ads-mcp` — o `uv sync` não o instala no venv; rodamos o módulo.)

## Ativar / reativar

1. Preencher os 5 valores: `adc.json` (client_id, client_secret, refresh_token) + `mcp.env`
   (developer_token, project_id).
2. **Recarregar a janela do VSCode** (Ctrl+Shift+P → "Developer: Reload Window") para a extensão
   reconectar o servidor `google-ads`. `/mcp` lista o status.
3. Testar: "liste as contas acessíveis" (`list_accessible_customers`).

## Notas / troubleshooting

- Read-only é o padrão (`ADS_MCP_ENABLE_MUTATIONS` não setado). Não habilitar para análise.
- MCC = `337-869-8997` (login-customer-id); anunciante Dr. Renan = `978-281-8062`.
- Se as deps precisarem reinstalar: `cd _tools/google_ads_mcp && uv sync --system-certs`.
- Segredos (`adc.json`, `mcp.env`) ficam SÓ em `C:\Users\bruno\.google-ads-mcp\` — nunca no git.
  O repo só tem o clone em `_tools/` (gitignorado). Token de developer/refresh são os mesmos do
  Cloudflare (ver `## Tracking` no CLAUDE.md raiz).
