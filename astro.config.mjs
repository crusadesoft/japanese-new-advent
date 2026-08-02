// @ts-check
import { defineConfig } from 'astro/config';

// Deployment target is configured by environment so the same build works
// both on a GitHub Pages project subpath and on a custom apex domain.
//
//   Pages project site (default):
//     SITE_URL=https://crusadesoft.github.io  BASE_PATH=/japanese-new-advent
//
//   Custom domain, once patres.jp is registered:
//     SITE_URL=https://patres.jp              BASE_PATH=/
//
// Internal links must be built with withBase() from src/lib/paths.ts so the
// base is applied consistently.
export default defineConfig({
  site: process.env.SITE_URL || 'https://crusadesoft.github.io',
  base: process.env.BASE_PATH || '/japanese-new-advent',
  build: {
    format: 'directory',
  },
  markdown: {
    smartypants: false,
  },
});
