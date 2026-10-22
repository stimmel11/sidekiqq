/**
 * Loads and validates src/content/site.json.
 * A typo or missing field here fails `npm run build` with a clear message.
 */
import { z } from 'astro/zod';
import raw from '../content/site.json';

const link = z.object({ label: z.string().min(1), href: z.string().min(1) }).strict();

const schema = z
  .object({
    name: z.string().min(1),
    tagline: z.string().min(1),
    description: z.string().min(1).max(200),
    url: z.url(),
    locale: z.string(),
    ogImage: z.string().startsWith('/'),
    nav: z.array(link).min(1),
    headerCta: link,
    waitlist: z
      .object({
        /** "form" posts to PUBLIC_WAITLIST_ENDPOINT (mailto fallback if unset); "mailto" always uses email. */
        provider: z.enum(['form', 'mailto']),
        fieldName: z.string().min(1),
        fallbackEmail: z.email(),
        fallbackSubject: z.string(),
        heading: z.string(),
        body: z.string(),
        inputLabel: z.string(),
        placeholder: z.string(),
        buttonLabel: z.string(),
        successMessage: z.string(),
        errorMessage: z.string(),
        fallbackBody: z.string(),
        fallbackButtonLabel: z.string(),
      })
      .strict(),
    footer: z.object({ note: z.string(), links: z.array(link) }).strict(),
    /** e.g. { "label": "LinkedIn", "href": "https://..." }. Shown in the footer when non-empty. */
    social: z.array(link),
  })
  .strict();

const parsed = schema.safeParse(raw);
if (!parsed.success) {
  throw new Error(
    `src/content/site.json is invalid:\n${parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')}`,
  );
}

export const site = parsed.data;

const endpoint = (import.meta.env.PUBLIC_WAITLIST_ENDPOINT ?? '').trim();

/** How the waitlist renders right now: a real form, or the mailto fallback. */
export const waitlistMode: { kind: 'form'; endpoint: string } | { kind: 'mailto'; href: string } =
  site.waitlist.provider === 'form' && endpoint
    ? { kind: 'form', endpoint }
    : {
        kind: 'mailto',
        href: `mailto:${site.waitlist.fallbackEmail}?subject=${encodeURIComponent(site.waitlist.fallbackSubject)}`,
      };

if (site.waitlist.fallbackEmail.endsWith('@example.com')) {
  console.warn('[site] waitlist.fallbackEmail in site.json is still a placeholder (example.com).');
}
