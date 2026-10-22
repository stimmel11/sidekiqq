# SideKiqq marketing site

Static Astro + Tailwind site for SideKiqq. Content lives in Markdown and one JSON file, so it
can be edited by chatting with Claude. See **[EDITING.md](./EDITING.md)** for where everything is.

## Local development

Requires Node 22.12 or newer.

```bash
cd site
npm install
npm run dev      # http://localhost:4321
npm run build    # type-check + schema-check + build to dist/
npm run preview  # serve the built site
```

## Pages

`/` home, `/devices`, `/privacy-and-trust`, `/blog`, `/blog/<post>`, a 404 page, plus
`/sitemap-index.xml` and `/robots.txt`.

## Deploy to Vercel

1. In Vercel, **Add New → Project** and import the `stimmel11/sidekiqq` repo (the same repo as
   the brain; this is a second project).
2. **Root Directory:** `site`.
3. **Framework Preset:** Astro (detected; `vercel.json` also sets it). Build command
   `npm run build`, output directory `dist`.
4. **Node.js version:** 22.x or newer (Project Settings → General).
5. **Environment variables** (optional, see below): `PUBLIC_WAITLIST_ENDPOINT`.
6. Deploy. Every pushed branch gets a preview URL; `main` deploys to production.
7. **Domain:** Project Settings → Domains → add the domain. Then set `"url"` in
   `src/content/site.json` to that domain so canonical links, the sitemap, and social cards use it.

## Waitlist

Configured in `src/content/site.json` → `waitlist`. There is no backend in this repo.

| Setting | Result |
|---|---|
| `provider: "form"` and `PUBLIC_WAITLIST_ENDPOINT` set | An email form that POSTs to that URL (field name from `waitlist.fieldName`, default `email`). |
| `provider: "form"`, env var unset | A "Email to join" button that opens a mail to `waitlist.fallbackEmail`. |
| `provider: "mailto"` | Always the email button. |

Any service that accepts a standard HTML form POST works (for example Formspree, Basin, or
Getform; pick one and create a form to get its endpoint URL). The form sends with
`Accept: application/json` so the visitor stays on the page; if the service blocks that, it
falls back to a normal form submit. `PUBLIC_` variables are baked in at build time, so redeploy
after changing it. See `.env.example`.

Before launch, replace the placeholder `waitlist.fallbackEmail` (`hello@example.com`) with a
real address. The build prints a warning while it is still the placeholder.

## Brand tokens

Colors and fonts are defined once in `src/styles/tokens.css`, hand-copied from the brand spec.
When `/design/tokens.json` exists, that file should be generated from it.
