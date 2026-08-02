// @ts-check
import { defineConfig } from 'astro/config';

// The production domain is an IDN (教父.jp). Astro needs the punycode form
// here so generated absolute URLs and the sitemap are valid.
// 教父.jp -> xn--wcv59z.jp
export default defineConfig({
  site: process.env.SITE_URL || 'https://xn--wcv59z.jp',
  build: {
    format: 'directory',
  },
  markdown: {
    smartypants: false,
  },
});
