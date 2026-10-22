/**
 * Content collections. Every Markdown file under src/content/ is checked
 * against these schemas at build time — a missing or misspelled field fails
 * `npm run build` loudly, naming the file and field. See EDITING.md.
 */
import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const cta = z.object({ label: z.string().min(1), href: z.string().min(1) }).strict();
const importance = z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'FYI']);

/** The home page: one file, src/content/home/home.md. Each top-level key is a section. */
const home = defineCollection({
  loader: glob({ pattern: 'home.md', base: './src/content/home' }),
  schema: z
    .object({
      title: z.string(),
      description: z.string().max(200),
      hero: z
        .object({
          headline: z.string(),
          subhead: z.string(),
          primaryCta: cta,
          secondaryCta: cta,
          sample: z
            .object({
              from: z.string(),
              subject: z.string(),
              received: z.string(),
              quote: z.string(),
              commitment: z.object({ who: z.string(), what: z.string(), due: z.string(), client: z.string() }).strict(),
              draft: z.object({ to: z.string(), body: z.string() }).strict(),
            })
            .strict(),
        })
        .strict(),
      howItWorks: z
        .object({
          heading: z.string(),
          intro: z.string(),
          steps: z.array(z.object({ title: z.string(), body: z.string(), sample: z.string() }).strict()).min(3).max(8),
        })
        .strict(),
      devices: z.object({ heading: z.string(), intro: z.string(), link: cta }).strict(),
      trust: z
        .object({
          heading: z.string(),
          body: z.string(),
          points: z.array(z.object({ title: z.string(), body: z.string() }).strict()).min(1),
          link: cta,
        })
        .strict(),
      brief: z
        .object({
          heading: z.string(),
          intro: z.string(),
          disclaimer: z.string(),
          sample: z
            .object({
              date: z.string(),
              sections: z.array(z.object({ title: z.string(), items: z.array(z.string()).min(1) }).strict()).min(1),
              top5: z
                .array(z.object({ title: z.string(), why: z.string(), importance }).strict())
                .min(1)
                .max(5),
            })
            .strict(),
        })
        .strict(),
      faq: z.object({ heading: z.string() }).strict(),
    })
    .strict(),
});

/** Stand-alone pages. Each file becomes /<file-name>. */
const pages = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/pages' }),
  schema: z
    .object({
      title: z.string(),
      description: z.string().max(200),
      intro: z.string(),
      /** "prose" = plain article page. "devices" = also lists every device from src/content/devices. */
      template: z.enum(['prose', 'devices']).default('prose'),
      showWaitlist: z.boolean().default(true),
    })
    .strict(),
});

/** One file per device. Order controls position on the home page and /devices. */
const devices = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/devices' }),
  schema: z
    .object({
      name: z.string(),
      order: z.number().int(),
      role: z.string(),
      summary: z.string(),
      status: z.enum(['In development', 'Planned', 'Available']),
      /** Which built-in drawing to show. Drawings live in src/components/DeviceArt.astro. */
      art: z.enum(['phone', 'watch', 'glasses', 'medallion', 'robot']),
      does: z.array(z.string()).min(1),
    })
    .strict(),
});

/** One file per question. The Markdown body is the answer. */
const faq = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/faq' }),
  schema: z.object({ question: z.string(), order: z.number().int() }).strict(),
});

/** Blog posts. File name (minus .md) becomes the URL: /blog/<file-name>. */
const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z
    .object({
      title: z.string(),
      description: z.string().max(200),
      date: z.coerce.date(),
      author: z.string(),
      draft: z.boolean().default(false),
    })
    .strict(),
});

export const collections = { home, pages, devices, faq, blog };
