# Architecture: a multi-page static site managed by Claude Code

This document describes the design of this starter kit so it can be shared, forked, or handed to a beginner.

## The core model: one folder per page

Every page is a **self-contained folder**. The folder name is the URL slug.

```
repo/
├── landing-page/      → https://domain.com/landing-page/
├── sales-page/        → https://domain.com/sales-page/
├── home/              → https://domain.com/home/
├── brand/             → https://domain.com/brand/
└── links/             → https://domain.com/links/
```

Shared things live in flat sibling folders (`shared/`, `_template/`). This is a lightweight monorepo pattern.

### Why this shape

- **One page = one folder.** No mental model to learn.
- **Blast radius is local.** Editing `/sales-page/` can't break `/landing-page/`.
- **Cloudflare-native.** Cloudflare Pages serves `foo/index.html` at `/foo/` automatically — no routing config needed for the basic case.
- **Claude-native.** `CLAUDE.md` files in subdirectories are loaded by Claude Code *only* when it's working in that subtree, so per-page context stays clean and doesn't bloat every conversation.

## Canonical tree

```
repo/
├── CLAUDE.md                  # root briefing (always loaded by Claude Code)
├── README.md                  # human-facing overview
├── _template/                 # scaffold for new pages
│   ├── index.html
│   └── CLAUDE.md
├── index.html                 # the root page ("/")
│
├── landing-page/              # one page = one folder = one URL
│   ├── CLAUDE.md              # page-specific briefing (lazy-loaded)
│   ├── index.html             # page markup + inlined critical CSS
│   ├── page.css               # (optional) page-specific styles
│   ├── page.js                # (optional) page-specific JS
│   └── assets/                # hero image, OG image, anything page-owned
│
├── shared/                    # create only when real duplication appears
│   ├── base.css               # reset + design tokens (cached once)
│   ├── components.css         # header/footer/CTA styles
│   ├── fonts/                 # self-hosted .woff2
│   └── scripts/
│       ├── tracker.js         # loaded async from every page
│       └── utils.js
│
├── _headers                   # Cloudflare Pages cache rules
├── _redirects                 # vanity URLs, old→new page migrations
├── .gitignore
├── .claude/
│   └── commands/              # slash commands (e.g. /new-page)
└── docs/                      # shareable architecture + onboarding
```

## The Claude Code layer

Three files do ~90% of the work.

### 1. Root `CLAUDE.md` (always loaded, ~150 lines)

The project briefing. Bullet-heavy, not prose. Covers:

- Repo purpose and layout rule ("one folder per page")
- How to create a new page
- Where shared code lives
- Slug naming rules (kebab-case)
- Deploy target
- Hard rules (no duplicated trackers, no frameworks without asking)

Keep it under ~300 lines — it consumes context on every turn.

### 2. Per-page `CLAUDE.md` (lazy-loaded)

Loaded only when Claude edits files inside that folder. Covers:

- Purpose of this specific page
- Current offer (price, deadline, checkout URL)
- Integrations (Meta Pixel, GA4, Hotjar) with IDs
- Known quirks (e.g. "white bg inlined on countdown — fixes Android Chrome regression")
- Change log (dates of copy/price/deadline edits)

This is the highest-leverage file in the whole system once you have 3+ pages.

### 3. `.claude/commands/` — slash commands

Repeatable page-factory actions:

- `/new-page <slug>` — scaffold a folder from `_template/`, fill placeholders, report.
- `/audit-page <slug>` — check OG tags, favicon, hero preload, tracker presence, dead links. *(Add when you have 2+ pages.)*
- `/update-offer <slug>` — bump price/deadline/CTA in one place. *(Add when offers change often.)*

## Hosting: single Cloudflare Pages project, path-based routing

- One Cloudflare Pages project points at the repo root.
- The folder name *is* the URL slug. Cloudflare serves `foo/index.html` at `/foo/`.
- `_headers` controls cache. `_redirects` handles vanity URLs.

### `_headers` cache strategy

```
/shared/*           Cache-Control: public, max-age=31536000, immutable
/*/assets/*         Cache-Control: public, max-age=31536000, immutable
/*.html             Cache-Control: public, max-age=0, must-revalidate
```

Shared CSS/JS/fonts cache for a year. HTML stays fresh. Second-page visits on the same domain load near-instantly from browser cache.

When you update a shared file, change its filename (hash it) or add a `?v=N` query string. Never mutate a file served with `immutable`.

## Performance defaults (bake into `_template/`)

- **Inline critical CSS** (~2–4 KB) in `<head>`. Defer the rest.
- **Every `<script>` is `defer` or `async`.** Nothing blocks render.
- **Preload** the LCP image: `<link rel="preload" as="image" href="...">`.
- **Preload** the above-the-fold font.
- **Preconnect** to third-party origins (pixels, analytics) so TLS is warm when their script fires.
- **System font stack** as fallback; self-hosted `.woff2` with `font-display: swap`.
- **Lazy images** below the fold: `loading="lazy" decoding="async"`.
- **WebP/AVIF** via `<picture>`, JPG fallback.

Target: sub-1s LCP on 4G, even with a tracker loaded.

## Tracker strategy

When tracking arrives:

1. It lives in `shared/scripts/tracker.js` — one canonical copy.
2. Every page loads it as `<script async src="/shared/scripts/tracker.js"></script>`.
3. Pages add `<link rel="preconnect">` to the third-party origins the tracker calls.
4. The tracker is the **last** script loaded and runs via `requestIdleCallback` where possible.

Never duplicate a pixel's init code inside a page. It always goes through the shared module.

## Progressive complexity — do NOT do these upfront

Stay on plain HTML/CSS/JS as long as it serves. Graduate only when the pain is real:

1. **Shared component includes** (build-time templating) — when you've copy-pasted the same header into 5+ pages.
2. **Astro** — when you want shared layouts without adopting a JS framework.
3. **pnpm workspaces / Turborepo** — only when pages genuinely diverge in tech stack.

Every premature abstraction costs more than it saves until 3+ pages actually duplicate.

## Day-1 workflow for a new contributor

1. Clone the repo.
2. Open Claude Code in the folder.
3. Say: *"create a page at /example"*.
4. Claude runs `/new-page example`, asks for headline/CTA if missing, writes the folder.
5. Preview: open `example/index.html` in a browser, or run `wrangler pages dev .`.
6. Push to the connected branch. Cloudflare Pages deploys on push.

## Sources

Design decisions backed by:

- [Best Practices for Claude Code — Anthropic](https://code.claude.com/docs/en/best-practices)
- [How Claude remembers your project — Anthropic](https://code.claude.com/docs/en/memory)
- [Create custom subagents — Anthropic](https://code.claude.com/docs/en/sub-agents)
- [The Complete Guide to Writing CLAUDE.md — ClaudeCodeLab](https://claudecode-lab.com/en/blog/claude-md-best-practices/)
- [Writing a good CLAUDE.md — HumanLayer](https://www.humanlayer.dev/blog/writing-a-good-claude-md)
- [Claude Code Project Structure Best Practices — UX Planet](https://uxplanet.org/claude-code-project-structure-best-practices-5a9c3c97f121)
- [Slash Commands vs Subagents — Jason Liu](https://jxnl.co/writing/2025/08/29/context-engineering-slash-commands-subagents/)
- [Monorepos — Cloudflare Pages docs](https://developers.cloudflare.com/pages/configuration/monorepos/)
- [Astro project structure](https://docs.astro.build/en/basics/project-structure/)
- [Next.js project structure](https://nextjs.org/docs/app/getting-started/project-structure)
