/**
 * Internal link builder.
 *
 * The site deploys both to a GitHub Pages project subpath and (later) to a
 * custom apex domain, so every internal href has to be relative to Astro's
 * configured `base`. Hardcoded absolute paths silently 404 on the subpath
 * deployment, which is easy to miss locally where base is often "/".
 */

const BASE = import.meta.env.BASE_URL || '/';

export function withBase(path: string): string {
  const base = BASE.endsWith('/') ? BASE.slice(0, -1) : BASE;
  const rest = path.startsWith('/') ? path : `/${path}`;
  return `${base}${rest}` || '/';
}

export const home = () => withBase('/');
export const authors = () => withBase('/authors/');
export const author = (slug: string) => withBase(`/authors/${slug}/`);
export const text = (id: string) => withBase(`/text/${id}/`);
export const about = () => withBase('/about/');
