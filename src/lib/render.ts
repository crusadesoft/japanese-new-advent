/**
 * Inline renderer for corpus text.
 *
 * The ingest preserves emphasis as `*em*` / `**strong**` because those markers
 * survive translation intact. Everything else in a block is literal text, so
 * escape first and only then reintroduce the two tags we allow — the corpus is
 * machine-processed and machine-translated, and neither stage should be able
 * to inject markup into the page.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

export function renderInline(text: string): string {
  let out = escapeHtml(text);
  // Strong before emphasis, so `**x**` is not consumed as two `*x*` pairs.
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Soft line breaks inside a block (upstream <br>) become real breaks.
  out = out.replace(/\n/g, '<br />');
  return out;
}
