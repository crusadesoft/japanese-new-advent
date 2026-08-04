#!/usr/bin/env node
/**
 * Check translated documents against their sources.
 *
 * Agents asked to verify their own output report that it passed. This is the
 * independent check: structure, completeness, and whether the features the
 * source carries survived into the Japanese.
 *
 * Usage:
 *   node scripts/verify-translations.mjs          # every translated document
 *   node scripts/verify-translations.mjs 0136     # just one
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'data', 'source');
const JA = path.join(ROOT, 'data', 'ja');

/** Kana or kanji — the test for "this block was actually translated". */
const JAPANESE = /[぀-ヿ㐀-鿿]/;
const GREEK = /[Ͱ-Ͽἀ-῿]/g;

const count = (s, re) => (s.match(re) ?? []).length;

async function verify(id) {
  const problems = [];
  const srcPath = path.join(SRC, `${id}.json`);
  const jaPath = path.join(JA, `${id}.json`);

  if (!existsSync(srcPath)) return [`no source document ${id}`];

  let src, ja;
  try {
    src = JSON.parse(await readFile(srcPath, 'utf8'));
  } catch (e) {
    return [`source unreadable: ${e.message}`];
  }
  try {
    ja = JSON.parse(await readFile(jaPath, 'utf8'));
  } catch (e) {
    return [`invalid JSON: ${e.message}`];
  }

  for (const k of ['id', 'title', 'blocks']) {
    if (!(k in ja)) problems.push(`missing field "${k}"`);
  }
  if (!Array.isArray(ja.blocks)) return [...problems, 'blocks is not an array'];

  if (ja.blocks.length !== src.blocks.length) {
    problems.push(
      `block count ${ja.blocks.length}, source has ${src.blocks.length}`
    );
  }

  const n = Math.min(ja.blocks.length, src.blocks.length);
  const misTyped = [];
  for (let i = 0; i < n; i++) {
    if (ja.blocks[i].type !== src.blocks[i].type) misTyped.push(i);
  }
  if (misTyped.length) {
    problems.push(
      `${misTyped.length} block(s) with a type not matching the source ` +
        `(first at index ${misTyped[0]})`
    );
  }

  const empty = ja.blocks.filter((b) => !b.text || !b.text.trim()).length;
  if (empty) problems.push(`${empty} empty block(s)`);

  // A block with no Japanese is normally one the translator skipped. Not
  // always: where the source block is Greek and nothing else — Against
  // Heresies quotes two lines of the Iliad this way — the rule that Greek
  // stays Greek makes the untouched Greek the correct rendering. Latin
  // script in the source is what marks a block as having prose to carry
  // over, so require it before calling the block untranslated.
  const untranslated = ja.blocks.filter(
    (b, i) =>
      b.text?.trim() &&
      !JAPANESE.test(b.text) &&
      /[A-Za-z]/.test(src.blocks[i]?.text ?? '')
  ).length;
  if (untranslated) problems.push(`${untranslated} block(s) with no Japanese`);

  const srcText = src.blocks.map((b) => b.text).join('\n');
  const jaText = ja.blocks.map((b) => b.text).join('\n');

  // Quotation marks are the feature most easily lost, since the source
  // carries them and Japanese uses different characters entirely.
  const srcQuotes = count(srcText, /“/g);
  const jaQuotes = count(jaText, /[「『]/g);
  if (srcQuotes > 2 && jaQuotes < srcQuotes * 0.6) {
    problems.push(`quotations: source ${srcQuotes}, translation ${jaQuotes}`);
  }

  // Greek must survive as Greek rather than being transliterated away.
  const srcGreek = count(srcText, GREEK);
  const jaGreek = count(jaText, GREEK);
  if (srcGreek > 4 && jaGreek < srcGreek * 0.5) {
    problems.push(
      `Greek: source ${srcGreek} characters, translation ${jaGreek}`
    );
  }

  return problems;
}

async function main() {
  const only = process.argv[2];
  if (!existsSync(JA)) {
    console.log('No translations yet (data/ja does not exist).');
    return;
  }

  const ids = only
    ? [only]
    : (await readdir(JA))
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''))
        .sort();

  if (!ids.length) {
    console.log('No translations yet.');
    return;
  }

  let bad = 0;
  for (const id of ids) {
    const problems = await verify(id);
    if (problems.length) {
      bad++;
      console.log(`\n${id}`);
      for (const p of problems) console.log(`   ✗ ${p}`);
    } else {
      console.log(`${id}  ok`);
    }
  }

  console.log(`\n${ids.length} checked, ${bad} with problems.`);
  if (bad) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
