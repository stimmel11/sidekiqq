# Editing the SideKiqq site

For Stimmel and for Claude. The site is managed by chatting with Claude: Claude edits
files here, pushes a branch, Vercel builds a preview, and you look at it before it goes live.

**Rule of thumb:** words live in `src/content/`. Layout lives in `src/components/`.
Colors and fonts live in `src/styles/tokens.css`. Changing copy should almost never mean
touching a component.

## Where each piece of text lives

| What you see | File |
|---|---|
| Site name, tagline, default description, canonical URL | `src/content/site.json` (`name`, `tagline`, `description`, `url`) |
| Header menu and the header button | `src/content/site.json` (`nav`, `headerCta`) |
| Footer note, footer links, social links | `src/content/site.json` (`footer`, `social`) |
| Waitlist box (heading, text, button, messages, fallback email) | `src/content/site.json` (`waitlist`) |
| Home: hero, sample email/commitment/draft | `src/content/home/home.md` → `hero` |
| Home: "how it works" steps | `src/content/home/home.md` → `howItWorks.steps` |
| Home: devices section heading and intro | `src/content/home/home.md` → `devices` |
| Home: "never sends without you" band | `src/content/home/home.md` → `trust` |
| Home: sample daily brief | `src/content/home/home.md` → `brief` |
| Home: FAQ heading | `src/content/home/home.md` → `faq.heading` |
| FAQ questions and answers | `src/content/faq/*.md` (one file each; `order` sets position; body = answer) |
| Each device (home grid and /devices) | `src/content/devices/*.md` |
| /devices page intro and closing text | `src/content/pages/devices.md` |
| /privacy-and-trust | `src/content/pages/privacy-and-trust.md` |
| Blog posts | `src/content/blog/*.md` |
| 404 page | `src/pages/404.astro` (short; text is inline) |
| Social share image | `public/og.png` (1200 x 630) |
| Browser tab icon | `public/favicon.svg` |

All home-page copy sits in the YAML frontmatter at the top of `home.md` (between the `---` lines).
Keep the indentation; YAML is whitespace-sensitive. Wrap text in double quotes, and if the
text itself contains a double quote, write it as `\"`.

## Safety net: the build checks your edits

Every content file has a schema (`src/content.config.ts`; `src/lib/site.ts` for `site.json`).
A misspelled field, a missing field, or a wrong value fails `npm run build` with the file and
field named, for example:

```
devices → phone data does not match collection schema.
  ****: Unrecognized key: "staus"
```

So a typo cannot silently reach production: the Vercel preview fails instead. Fix the field
it names and push again.

## Common tasks

### Change a headline or paragraph
Find it in the table above, edit the quoted text, push. Done.

### Add a blog post
Create `src/content/blog/<url-slug>.md`:

```md
---
title: "Post title"
description: "One or two sentences, under 200 characters. Used in the list and in search results."
date: 2026-11-04
author: "Stimmel"
draft: false
---

Body in Markdown. ## for subheadings.
```

The file name becomes the URL: `/blog/<url-slug>`. Set `draft: true` to keep it off the live
site (it still shows in `npm run dev`). Newest posts appear first.

### Add a page
Create `src/content/pages/<url-slug>.md`:

```md
---
title: "Page title"
description: "Under 200 characters."
intro: "The large paragraph under the title."
template: "prose"      # or "devices" to include the device list
showWaitlist: true     # false hides the waitlist box at the bottom
---

Markdown body.
```

It appears at `/<url-slug>`. Don't use a slug that already exists as a route (`blog`, `404`).
To put it in the header menu, add `{ "label": "...", "href": "/<url-slug>" }` to `nav` in
`site.json`; for the footer, add it to `footer.links`.

### Add, remove, or reorder a home "how it works" step
Edit the `howItWorks.steps` list in `home.md`. Each step has `title`, `body`, and `sample`
(the small monospace box; `\n` makes a line break). 3 to 8 steps are allowed. The last step
is always highlighted as the one that belongs to you.

### Add a device
Create `src/content/devices/<name>.md` with `name`, `order`, `role`, `summary`, `status`
(`"In development"`, `"Planned"`, or `"Available"`), `art`, and a `does` list. `art` picks a
drawing from `src/components/DeviceArt.astro` (`phone`, `watch`, `glasses`, `medallion`,
`robot`). A new kind of device needs a new drawing added there and its name added to the
`art` list in `src/content.config.ts`. The home grid is laid out for five devices; check the
preview at phone width if you add a sixth.

### Add a FAQ
Create `src/content/faq/07-something.md` with `question` and `order`, and write the answer as
the body.

### Add or move a home-page section
Sections are listed in order in `src/pages/index.astro`. Move a line to reorder. A brand-new
section needs a small component in `src/components/` plus its copy as a new key in `home.md`
and in the `home` schema in `src/content.config.ts`. Follow how `Trust.astro` does it.

### Change colors or fonts
Only in `src/styles/tokens.css`. The brand values (`--brand-*`) are shared with the app, so
change them there only in step with `/design`. The semantic roles below them (`--bg`, `--fg`,
`--muted`, `--accent`, ...) decide where each color is used, separately for light and dark mode.
Tailwind classes such as `bg-accent` and `text-muted` read from these automatically.
This file will later be generated from `/design/tokens.json`.

### Connect the waitlist
See "Waitlist" in `README.md`. In short: set `PUBLIC_WAITLIST_ENDPOINT` in Vercel. Until then
the site shows an "Email to join" button using `waitlist.fallbackEmail` from `site.json`.

## Content rules

- No testimonials, customer logos, user counts, press quotes, or prices until they are real.
- Samples use obviously fictional names and say so.
- Don't describe a device or feature as available until it is. Use `status` on devices.
- Privacy page: describe what the system actually does. No certifications or compliance claims.
- Tone: calm, competent, discreet. Sentence case. Plain verbs.

## Preview → production

1. Claude makes the change on a new branch (e.g. `site/new-faq`) and pushes it.
2. Vercel builds a **preview** for that branch and posts the URL (on the PR or in the Vercel
   dashboard). If the build fails, the log names the file and field to fix.
3. Stimmel reviews the preview on phone and desktop.
4. Merge the branch into `main` (via a PR). Vercel deploys `main` to **production** automatically.

To check locally before pushing: `cd site && npm install && npm run build` (type-check, schema
check, and build), or `npm run dev` for a live preview at http://localhost:4321.
