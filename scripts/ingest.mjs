#!/usr/bin/env node
/**
 * Ingest the Church Fathers corpus into structured JSON.
 *
 * Source: the Schaff Ante-Nicene / Nicene & Post-Nicene Fathers translations
 * (1885-1900), public domain. See README.md on provenance.
 *
 * Reads a directory of upstream `fathers/*.htm` files and emits:
 *   data/source/<id>.json   one file per document
 *   data/manifest.json      author -> work -> chapter tree
 *
 * Usage:
 *   node scripts/ingest.mjs --src /path/to/fathers
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as cheerio from 'cheerio';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DOCS = path.join(ROOT, 'data', 'source');
const OUT_MANIFEST = path.join(ROOT, 'data', 'manifest.json');

/** The upstream content well. Everything outside it is site chrome. */
const CONTENT_SELECTOR = '#springfield2';

/**
 * Upstream site boilerplate ("About this page", source credits, contact
 * details) is nested *inside* the content well, so it must be pruned
 * explicitly or it ends up in the translated text on every page.
 */
const CHROME_SELECTOR = '.pub';

/**
 * Some upstream files carry unterminated editorial page markers such as
 * `<!--k29--` (a printed-edition page number that was never closed with `>`).
 * A conforming HTML parser treats the remainder of the file as comment text,
 * silently emptying the document, so repair these before parsing.
 */
function sanitizeHtml(html) {
  // Unclosed page markers must go first. They are never closed upstream (145
  // occurrences, zero of them terminated), so if well-formed comments were
  // stripped first, one of these would pair with the *next* legitimate `-->`
  // and delete every paragraph in between.
  let out = html.replace(/<!--k\d+--(?!>)/g, '');

  // Genuine comments, which legitimately wrap markup (commented-out page-break
  // spans), so they may contain `<`.
  out = out.replace(/<!--[\s\S]*?-->/g, '');

  // Any opener still dangling is an upstream typo (e.g. `<html>` mangled into
  // `<!--YYY`). Drop only the token; the markup after it is real content.
  out = out.replace(/<!--/g, '');

  return out;
}

/** Block-level elements we carry through, mapped to our own block types. */
const BLOCK_TYPES = {
  h1: 'title',
  h2: 'heading',
  h3: 'subheading',
  h4: 'subheading',
  p: 'p',
  blockquote: 'quote',
  li: 'li',
};

function parseArgs(argv) {
  const args = { src: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--src') args.src = argv[++i];
  }
  return args;
}

/**
 * Collapse an element's inline markup to text, preserving emphasis as
 * lightweight markers. Emphasis carries real signal here (Latin phrases,
 * work titles, Scripture), so it is worth keeping through translation.
 */
function inlineText($, el) {
  let out = '';
  for (const node of $(el).contents().toArray()) {
    if (node.type === 'text') {
      out += node.data;
    } else if (node.type === 'tag') {
      const tag = node.name.toLowerCase();
      const inner = inlineText($, node);
      if (!inner.trim()) {
        out += inner;
        continue;
      }
      if (tag === 'i' || tag === 'em') out += `*${inner}*`;
      else if (tag === 'b' || tag === 'strong') out += `**${inner}**`;
      else if (tag === 'br') out += '\n';
      // Quotations carry their marks in the browser's stylesheet, not the
      // text, so extracting textContent silently strips every quotation in
      // the corpus. Emit real quote characters. `<quote>` is a non-standard
      // spelling used in a few files for the same thing.
      else if (tag === 'q' || tag === 'quote') out += `“${inner}”`;
      // `span.stiki` is the upstream Scripture-citation apparatus, injected
      // mid-sentence ("...not of works, Ephesians 2:8-9 but by the will..").
      // Unmarked it reads as part of the Father's own prose. Parenthesise it
      // so it is unambiguously a reference.
      else if (tag === 'span' && $(node).attr('class') === 'stiki')
        out += ` (${inner.trim()})`;
      // A few files mark emphasis with a style attribute instead of a tag.
      else if (tag === 'span' && /italic/i.test($(node).attr('style') || ''))
        out += `*${inner}*`;
      // Footnote markers. Bare, they merge into the prose as stray numerals.
      else if (tag === 'sup') out += `[${inner.trim()}]`;
      // Greek needs no marker of its own: the Unicode range already
      // identifies it unambiguously, and inventing syntax here would just
      // give the translation step something new to mangle. The renderer
      // detects it by codepoint; the translation prompt says to leave it be.
      else out += inner; // <a>, <font>, span.greek, span.sc contribute text
    }
  }
  return out;
}

/**
 * Link text reduced to a plain navigation label.
 *
 * `inlineText` keeps emphasis, which is right for a block of prose and wrong
 * for a label: the upstream contents pages bold every chapter name, so the
 * markers ride into the manifest and reach the reader as literal asterisks —
 * `**Chapter 1**` in the margin of a translated page. Nothing downstream
 * renders a label as markdown, and bold in a navigation entry would carry no
 * meaning if it did.
 */
function labelText($, el) {
  return normalize(inlineText($, el)).replace(/\*+/g, '');
}

function normalize(s) {
  return s
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/** Internal links out of this page, as bare document ids (e.g. "3401001"). */
function outboundDocIds($, scope) {
  const ids = [];
  $(scope)
    .find('a[href]')
    .each((_, a) => {
      const href = $(a).attr('href') || '';
      const m = href.match(/(?:^|\/)(\d{4,9}[a-z]?)\.htm$/i);
      if (m && /fathers\/|^\d/.test(href.replace(/^\.\.\//, ''))) ids.push(m[1]);
    });
  return ids;
}

/** Parse one document file into blocks. */
async function parseDocument(file, id) {
  const html = sanitizeHtml(await readFile(file, 'utf8'));
  const $ = cheerio.load(html);
  const scope = $(CONTENT_SELECTOR);
  if (!scope.length) return null;

  // Prune upstream chrome and layout scaffolding from inside the content well.
  scope.find(CHROME_SELECTOR).remove();
  scope.find('script, style').remove();

  const blocks = [];
  scope.find(Object.keys(BLOCK_TYPES).join(',')).each((_, el) => {
    const $el = $(el);
    const tag = el.tagName.toLowerCase();

    // A blockquote wrapping paragraphs matches this selector, and so does
    // every paragraph inside it, so the same prose would be emitted twice.
    // Let the inner blocks carry the text — that preserves paragraph breaks
    // within a long quotation, which collapsing to one block would lose.
    //
    // Unless the blockquote holds prose of its own as well. Dialogue with
    // Trypho ch. 32 opens a <blockquote> inside a <p>, which no parser can
    // honour: the paragraph is closed at the blockquote, and the following
    // quotation ends up nested within it. Justin's reply is then direct text
    // on a blockquote that also contains a paragraph, and deferring drops it
    // — 470 words, the whole answer to Trypho's objection. Emit what belongs
    // to the wrapper and let the inner blocks emit themselves.
    if (tag === 'blockquote' && $el.find('p, li').length) {
      const own = $el.clone();
      own.find('p, li').remove();
      const ownText = normalize(inlineText($, own[0]));
      if (!ownText) return;
      blocks.push({ type: 'quote', text: ownText });
      return;
    }

    const quoted =
      (tag === 'p' || tag === 'li') && $el.parents('blockquote').length > 0;

    const text = normalize(inlineText($, el));
    if (!text) return;
    blocks.push({ type: quoted ? 'quote' : BLOCK_TYPES[tag], text });
  });

  if (!blocks.length) return null;

  const title = blocks[0].type === 'title' ? blocks[0].text : null;
  const body = title ? blocks.slice(1) : blocks;

  // Identify table-of-contents pages. Link labels must not count toward prose,
  // or a long chapter list reads as a long document, so measure only the text
  // that remains once links are stripped.
  const links = outboundDocIds($, scope);
  const uniqueLinks = [...new Set(links)].filter((l) => l !== id);

  const residual = scope.clone();
  residual.find('a').remove();
  const residualWords = normalize(residual.text())
    .split(/\s+/)
    .filter(Boolean).length;

  // Brevity alone is the wrong test. Many contents pages annotate each entry
  // with a paragraph-long summary of the book it points to — Augustine's
  // Confessions and City of God both do — which reads as prose and orphans
  // every chapter beneath them. Document ids are hierarchical, so a page
  // linking to ids that extend its own is a contents page however much it
  // says about them.
  const childLinks = uniqueLinks.filter(
    (l) => l.startsWith(id) && l.length > id.length
  );

  // Two is enough: plenty of works split into just "Book I / Book II".
  const isToc =
    uniqueLinks.length >= 2 && (residualWords < 120 || childLinks.length >= 2);

  // For TOC pages, capture the child ordering and their labels.
  let children = [];
  if (isToc) {
    const seen = new Set();
    $(scope)
      .find('a[href]')
      .each((_, a) => {
        const href = $(a).attr('href') || '';
        const m = href.match(/(?:^|\/)(\d{4,9}[a-z]?)\.htm$/i);
        if (!m) return;
        const childId = m[1];
        if (childId === id || seen.has(childId)) return;
        const label = labelText($, a);
        if (!label) return;
        seen.add(childId);
        children.push({ id: childId, label });
      });
  }

  const words = body.reduce((n, b) => n + b.text.split(/\s+/).length, 0);

  return {
    id,
    title,
    isToc,
    children,
    blocks: body,
    words,
  };
}

/**
 * Parse the corpus index into an author -> works tree.
 *
 * The index annotates entries with bracketed markers — [SAINT] and [DOCTOR]
 * on authors, and [SPURIOUS], [LOCAL], [ECUMENICAL], [GNOSTIC] and others on
 * individual works. Placement is positional rather than structural: a marker
 * belongs to whatever was named most recently before it. So the parser walks
 * each paragraph's children in document order and attaches markers to the
 * current target, which starts as the author and becomes each work in turn.
 */
async function parseIndex(file) {
  const html = sanitizeHtml(await readFile(file, 'utf8'));
  const $ = cheerio.load(html);
  const scope = $(CONTENT_SELECTOR);

  const authors = [];

  const markersOf = (text) =>
    [...text.matchAll(/\[([A-Z]+)\]/g)].map((m) => m[1]);

  for (const p of scope.children('p').toArray()) {
    const $p = $(p);
    const strong = $p.find('strong').first();
    if (!strong.length) continue;

    const raw = normalize(inlineText($, strong)).replace(/\*/g, '');
    const cathen = $p.find('a[href*="cathen"]').first().attr('href') || null;

    // Split a trailing "(340-397)" style life-dates hint off the name.
    const dm = raw.match(/^(.*?)\s*\(([^)]*\d[^)]*)\)\s*$/);
    const name = (dm ? dm[1] : raw).trim();
    const dates = dm ? dm[2].trim() : null;

    const author = {
      slug: slugify(name),
      name,
      dates,
      markers: [],
      isSaint: false,
      isDoctor: false,
      cathen: cathen ? (cathen.match(/(\w+)\.htm$/) || [])[1] || null : null,
      works: [],
    };

    // Markers land on the author until the first work link appears.
    let target = author;

    for (const node of $p.contents().toArray()) {
      if (node.type !== 'tag') continue;
      const tag = node.name.toLowerCase();
      const $n = $(node);

      if (tag === 'font') {
        target.markers.push(...markersOf($n.text()));
        continue;
      }

      // A work link may be the node itself or wrapped one level down.
      const $a = tag === 'a' ? $n : $n.find('a[href*="fathers/"]').first();
      const href = $a.attr('href') || '';
      const m = href.match(/(\d{4,9}[a-z]?)\.htm$/);
      if (!m || !/fathers\//.test(href)) continue;

      const label = labelText($, $a[0]);
      if (!label) continue;

      const work = { id: m[1], title: label, markers: [] };
      author.works.push(work);
      target = work;
    }

    author.isSaint = author.markers.includes('SAINT');
    author.isDoctor = author.markers.includes('DOCTOR');
    authors.push(author);
  }

  return authors.filter((a) => a.works.length > 0);
}

function slugify(name) {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.src) {
    console.error('Usage: node scripts/ingest.mjs --src /path/to/fathers');
    process.exit(1);
  }
  if (!existsSync(args.src)) {
    console.error(`Source directory not found: ${args.src}`);
    process.exit(1);
  }

  await mkdir(OUT_DOCS, { recursive: true });

  const indexFile = ['index.html', 'index.htm']
    .map((f) => path.join(args.src, f))
    .find((f) => existsSync(f));
  if (!indexFile) {
    console.error('No index.html found in source directory.');
    process.exit(1);
  }

  console.log('Parsing corpus index…');
  const authors = await parseIndex(indexFile);
  console.log(`  ${authors.length} authors, ${authors.reduce((n, a) => n + a.works.length, 0)} works`);

  const files = (await readdir(args.src)).filter((f) => /^\d{4,9}[a-z]?\.htm$/i.test(f));
  console.log(`Parsing ${files.length} documents…`);

  const docs = new Map();
  let totalWords = 0;
  let skipped = 0;

  for (const f of files) {
    const id = f.replace(/\.htm$/i, '');
    const doc = await parseDocument(path.join(args.src, f), id);
    if (!doc) {
      skipped++;
      continue;
    }
    docs.set(id, doc);
    totalWords += doc.words;
    await writeFile(
      path.join(OUT_DOCS, `${id}.json`),
      JSON.stringify(doc, null, 1),
      'utf8'
    );
  }

  console.log(`  parsed ${docs.size}, skipped ${skipped}`);
  console.log(`  ${totalWords.toLocaleString()} words`);

  // Resolve each work into a chapter tree by walking TOC pages breadth-first.
  const attachTree = (id, depth = 0, seen = new Set()) => {
    if (depth > 4 || seen.has(id)) return null;
    seen.add(id);
    const doc = docs.get(id);
    if (!doc) return null;
    const node = {
      id,
      title: doc.title,
      isToc: doc.isToc,
      words: doc.words,
      children: [],
    };
    if (doc.isToc) {
      for (const child of doc.children) {
        const sub = attachTree(child.id, depth + 1, seen);
        if (sub) {
          if (!sub.title) sub.title = child.label;
          sub.label = child.label;
          node.children.push(sub);
        }
      }
    }
    return node;
  };

  let resolved = 0;
  for (const author of authors) {
    author.works = author.works
      .map((w) => {
        const tree = attachTree(w.id);
        if (!tree) return null;
        resolved++;
        return {
          ...w,
          slug: slugify(w.title),
          isToc: tree.isToc,
          children: tree.children,
          words: sumWords(tree),
        };
      })
      .filter(Boolean);
  }

  console.log(`  resolved ${resolved} work trees`);

  // Safety net. A handful of documents are unreachable because the upstream
  // parent page simply never links them — Gregory of Nyssa's Great Catechism
  // lists no parts at all. Document ids are hierarchical, so adopt any orphan
  // onto the nearest ancestor id already in the tree. Without this the text
  // exists but nothing on the site points at it.
  const inTree = new Map();
  const indexTree = (node) => {
    inTree.set(node.id, node);
    for (const c of node.children ?? []) indexTree(c);
  };
  for (const author of authors) for (const w of author.works) indexTree(w);

  let adopted = 0;
  for (const id of [...docs.keys()].sort()) {
    if (inTree.has(id)) continue;
    // Walk back through shorter id prefixes to find the closest ancestor.
    for (let len = id.length - 1; len >= 3; len--) {
      const parent = inTree.get(id.slice(0, len));
      if (!parent) continue;
      const doc = docs.get(id);
      const node = {
        id,
        title: doc.title,
        label: doc.title,
        isToc: doc.isToc,
        words: doc.words,
        children: [],
      };
      parent.children.push(node);
      inTree.set(id, node);
      adopted++;
      break;
    }
  }
  if (adopted) console.log(`  adopted ${adopted} orphaned documents`);

  const manifest = {
    generatedAt: new Date().toISOString(),
    source: 'Ante-Nicene Fathers / Nicene & Post-Nicene Fathers (Schaff, 1885-1900), public domain',
    counts: {
      authors: authors.length,
      works: authors.reduce((n, a) => n + a.works.length, 0),
      documents: docs.size,
      words: totalWords,
    },
    authors,
  };

  await writeFile(OUT_MANIFEST, JSON.stringify(manifest, null, 1), 'utf8');
  console.log(`\nWrote ${OUT_DOCS}/*.json and ${OUT_MANIFEST}`);
}

function sumWords(node) {
  return node.words + node.children.reduce((n, c) => n + sumWords(c), 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
