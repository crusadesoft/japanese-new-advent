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

/**
 * Greek, matched by codepoint. The corpus quotes Greek where the word itself
 * is the argument — Hilary's ὁμοούσιος against ὁμοιούσιον turns on two
 * letters — so it is tagged for language and font rather than left to render
 * in whatever the body face happens to supply for polytonic Greek.
 */
const GREEK_RUN = /[Ͱ-Ͽἀ-῿][Ͱ-Ͽἀ-῿̀-ͯ··']*/g;

export function renderInline(text: string): string {
  let out = escapeHtml(text);
  // Strong before emphasis, so `**x**` is not consumed as two `*x*` pairs.
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  out = out.replace(GREEK_RUN, (g) => `<span lang="grc">${g}</span>`);
  // Soft line breaks inside a block (upstream <br>) become real breaks.
  out = out.replace(/\n/g, '<br />');
  return out;
}
