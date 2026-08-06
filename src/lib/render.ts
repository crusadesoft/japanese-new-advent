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
  // Ingest emits one marker pair per element, so nested emphasis arrives with
  // the inner element's leading space trapped between the runs: the bylines
  // `<b> <i>BY CLEMENT</i></b>` reach us as `** *BY CLEMENT***`. Parsed as
  // strong-then-emphasis that reads as an empty <em> and three literal
  // asterisks on the page, which is what 387 documents were showing.
  //
  // Matched as one whole shape rather than by repairing the runs, because
  // `**Justin:** *(In jest.)*` opens identically and is correct as it stands;
  // only the closing run of three tells them apart.
  out = out.replace(
    /\*\*(\s*)\*([^*]+)\*\*\*/g,
    '$1<strong><em>$2</em></strong>'
  );
  // Longest run first, so a triple is never consumed as a double plus a stray.
  out = out.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  // Strong before emphasis, so `**x**` is not consumed as two `*x*` pairs.
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  out = out.replace(GREEK_RUN, (g) => `<span lang="grc">${g}</span>`);
  // Soft line breaks inside a block (upstream <br>) become real breaks.
  out = out.replace(/\n/g, '<br />');
  return out;
}
