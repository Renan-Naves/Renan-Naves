# Pages

Multi-page static site scaffold for Cloudflare Pages. One folder per page, path-based routing, single domain.

## Add a page

Open Claude Code in this folder and say:

> create a page at /slug-name

Or manually: `cp -r _template slug-name/` and edit the files.

## Deploy

Connect this repo to a single Cloudflare Pages project. Push to the connected branch. Done.

## Structure

- `CLAUDE.md` — briefing for Claude Code (always loaded)
- `_template/` — the scaffold new pages are copied from
- `_headers` / `_redirects` — Cloudflare Pages configuration
- `docs/` — architecture and onboarding docs (share-ready)
- `.claude/commands/new-page.md` — the `/new-page` slash command

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the full design, hosting, and performance model
- [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) — first-session workflow for someone new to the repo
