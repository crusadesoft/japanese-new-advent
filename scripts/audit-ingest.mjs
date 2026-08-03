#!/usr/bin/env node
/**
 * Compare the ingest parser's output against an independent extraction of the
 * same documents.
 *
 * The parser is hand-written and flattens semantic HTML into text, which is
 * exactly the kind of code that loses information silently — quotations whose
 * marks live in the browser's stylesheet, citations that read as prose,
 * Greek that looks like ordinary words. Every such bug so far was found by
 * accident. This diffs the parser against a second opinion so they are found
 * on purpose.
 *
 * Usage:
 *   node scripts/audit-ingest.mjs --other /path/to/extractions
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MINE = path.join(ROOT, 'data', 'source');

/** Collapse to comparable prose: no markup, no punctuation, no spacing. */
const norm = (s) =>
  s
    .replace(/[*_]/g, '')
    .replace(/[“”"'‘’「」『』（）()〔〕\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();

/** Word multiset, for finding prose present in one side and not the other. */
function bag(text) {
  const m = new Map();
  for (const w of norm(text).split(' ')) {
    if (w.length > 2) m.set(w, (m.get(w) ?? 0) + 1);
  }
  return m;
}

function missingFrom(a, b) {
  const out = [];
  for (const [w, n] of a) {
    const d = n - (b.get(w) ?? 0);
    if (d > 0) out.push([w, d]);
  }
  return out.sort((x, y) => y[1] - x[1]);
}

const FEATURES = {
  'quote marks': /[“”「」]/g,
  'Greek': /[Ͱ-Ͽἀ-῿]/g,
  // Either bracketing style — the delimiter is a convention, not a signal.
  'citations': /[([][A-Z][a-z]+ ?\d+:\d+/g,
  'emphasis': /\*/g,
};

function count(text, re) {
  return (text.match(re) ?? []).length;
}

async function main() {
  const i = process.argv.indexOf('--other');
  if (i === -1) {
    console.error('Usage: node scripts/audit-ingest.mjs --other <dir>');
    process.exit(1);
  }
  const otherDir = process.argv[i + 1];

  const files = (await readdir(otherDir)).filter((f) => f.endsWith('.json'));
  if (!files.length) {
    console.error(`No extractions found in ${otherDir}`);
    process.exit(1);
  }

  let flagged = 0;

  for (const f of files.sort()) {
    const id = f.replace(/\.json$/, '');
    const minePath = path.join(MINE, `${id}.json`);
    if (!existsSync(minePath)) {
      console.log(`\n${id}  — MISSING from data/source`);
      flagged++;
      continue;
    }

    const mine = JSON.parse(await readFile(minePath, 'utf8'));
    const other = JSON.parse(await readFile(path.join(otherDir, f), 'utf8'));

    const mineText = mine.blocks.map((b) => b.text).join(' ');
    const otherText = (other.blocks ?? []).map((b) => b.text).join(' ');

    const notes = [];

    // Block segmentation may legitimately differ; a large gap will not.
    const bd = other.blocks.length - mine.blocks.length;
    if (Math.abs(bd) > Math.max(2, mine.blocks.length * 0.15)) {
      notes.push(`blocks ${mine.blocks.length} vs ${other.blocks.length}`);
    }

    if (norm(mine.title ?? '') !== norm(other.title ?? '')) {
      notes.push(`title "${mine.title}" vs "${other.title}"`);
    }

    // Prose one side has and the other does not — the signal that matters.
    const mb = bag(mineText);
    const ob = bag(otherText);
    const onlyOther = missingFrom(ob, mb);
    const onlyMine = missingFrom(mb, ob);
    const otherWords = [...ob.values()].reduce((a, b) => a + b, 0) || 1;
    const lossPct = (onlyOther.reduce((a, [, n]) => a + n, 0) / otherWords) * 100;

    if (lossPct > 3) {
      notes.push(
        `${lossPct.toFixed(1)}% of their prose absent from mine ` +
          `[${onlyOther.slice(0, 6).map(([w, n]) => `${w}×${n}`).join(' ')}]`
      );
    }

    for (const [name, re] of Object.entries(FEATURES)) {
      const a = count(mineText, re);
      const b = count(otherText, re);
      // Flag only order-of-magnitude divergence, not stylistic difference.
      if (a === 0 && b > 2) notes.push(`${name}: mine 0, theirs ${b}`);
      else if (b === 0 && a > 2) notes.push(`${name}: mine ${a}, theirs 0`);
    }

    if (notes.length) {
      flagged++;
      console.log(`\n${id}`);
      for (const n of notes) console.log(`   ⚠ ${n}`);
      if (onlyMine.length && lossPct > 3) {
        console.log(
          `   · only in mine: ${onlyMine.slice(0, 5).map(([w, n]) => `${w}×${n}`).join(' ')}`
        );
      }
    } else {
      console.log(`${id}  ok`);
    }
  }

  console.log(
    `\n${files.length} documents compared, ${flagged} flagged for review.`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
