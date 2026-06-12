---
description: Scaffold a new page folder from _template
---

Create a new page in this repo.

Steps:

1. Parse the slug from the user's request (kebab-case, no leading slash, no spaces). Reject vowels stripped or camelCase — normalize to kebab-case.
2. If a folder with that slug already exists, stop and ask the user what to do.
3. Copy the entire `_template/` folder to a new folder named after the slug.
4. In the new folder's `index.html` and `CLAUDE.md`, replace every placeholder:
   - `{{SLUG}}` — the slug
   - `{{PAGE_TITLE}}` — HTML `<title>` (and `og:title`)
   - `{{PAGE_DESCRIPTION}}` — meta description
   - `{{HEADLINE}}` — hero H1
   - `{{SUBHEAD}}` — hero paragraph
   - `{{CTA_URL}}` — destination for the CTA button
   - `{{CTA_TEXT}}` — button label
   - `{{PURPOSE}}`, `{{OFFER}}`, `{{INTEGRATIONS}}`, `{{DEADLINE}}` — fields in the per-page CLAUDE.md
   - `{{DATE}}` — today's date in YYYY-MM-DD
5. If the user's request already contained some of these values, fill them in without asking. Only ask for values that are actually missing and that you can't infer.
6. Do not create a `shared/` folder, extra assets, or any tracker code unless the user asks.
7. Report:
   - The folder path created
   - The URL it will serve at (`/<slug>/`)
   - Which placeholders still need filling (if any)

Usage: `/new-page <slug>` or `/new-page <slug> "<headline>" "<cta-url>"`.
