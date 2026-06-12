# Getting started

A step-by-step guide for someone opening this repo for the first time. No prior familiarity with the codebase required.

## What this is

A scaffold for building multiple static pages in one repository, deployed as a single Cloudflare Pages project. Each page is a folder; the folder name is the URL slug.

## Prerequisites

- A terminal
- Git
- Claude Code installed
- (Optional) A Cloudflare account with a Pages project connected to this repo

You do **not** need Node.js, npm, or any build tool to start.

## First session in 6 steps

### 1. Open Claude Code in the folder

```bash
cd path/to/03-pages-starter-kit
claude
```

### 2. Ask for your first page

Type this into Claude:

> create a page at /example

Claude will:

1. Run the `/new-page` slash command
2. Copy `_template/` to `example/`
3. Ask you for the headline, CTA text, and CTA URL (if you didn't provide them)
4. Fill in `example/index.html` and `example/CLAUDE.md`

### 3. Preview it

Open `example/index.html` directly in your browser, or run a local server:

```bash
# quickest: Python one-liner
python3 -m http.server 8000
# visit http://localhost:8000/example/

# or, if you have wrangler installed:
wrangler pages dev .
```

### 4. Iterate with Claude

Ask Claude to edit the page in plain language:

> change the headline on /example to "Hello world"
> add a three-step how-it-works section to /example, right before the CTA
> make the CTA button blue

Because each page has its own `CLAUDE.md`, Claude reads page-specific context automatically.

### 5. Commit

```bash
git add .
git commit -m "add example page"
```

### 6. Deploy

Push to the branch connected to your Cloudflare Pages project. Cloudflare builds and deploys automatically.

```bash
git push
```

Your page is live at `https://<your-domain>/example/`.

## Creating more pages

Same flow, any time:

> create a page at /sales-spring with headline "Spring sale — 30% off", CTA going to https://checkout.com/spring

The more context you hand Claude in the request, the fewer questions it asks back.

## When things get shared

The first time you notice yourself copy-pasting the same header, footer, or style into a second page, create a `shared/` folder:

```
shared/
├── base.css          # shared reset + design tokens
└── scripts/
    └── utils.js
```

Then reference it from each page with an absolute path:

```html
<link rel="stylesheet" href="/shared/base.css">
<script defer src="/shared/scripts/utils.js"></script>
```

The `_headers` file already caches `/shared/*` for a year, so a second-page visit reuses the browser cache — effectively free.

## Adding a tracker later

When you need a pixel or analytics:

1. Put the code in `shared/scripts/tracker.js`
2. Add `<script async src="/shared/scripts/tracker.js"></script>` to every page's `<body>` (end of it)
3. Add `<link rel="preconnect" href="https://...">` in the page's `<head>` for the tracker's origin

Tell Claude: *"add the tracker from shared/scripts/tracker.js to all existing pages"* and it will handle it across folders.

## What to read next

- [ARCHITECTURE.md](ARCHITECTURE.md) — why the repo is structured this way
- The root [CLAUDE.md](../CLAUDE.md) — the rules of the repo
- [_template/index.html](../_template/index.html) — the shape every new page starts from

## Common first-session questions

**Q: Do I have to use the `/new-page` command?**
No. You can also run `cp -r _template my-slug/` and edit manually. The slash command just automates placeholder replacement.

**Q: Why is the home page (`index.html`) so empty?**
It's a placeholder with `noindex`. Replace it when you have a real home page, or leave it and direct all traffic to individual page folders.

**Q: Where do I put images?**
Inside the page folder: `example/assets/hero.webp`. Only move to `shared/` when an asset is used by 2+ pages.

**Q: Why no build step?**
Because plain HTML/CSS/JS is faster to edit, faster to deploy, and impossible to break with tooling. Adopt a build step only when real duplication pain demands it.
