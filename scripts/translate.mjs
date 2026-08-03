#!/usr/bin/env node
/**
 * Translate the ingested Church Fathers corpus from English into Japanese.
 *
 * Design notes:
 *  - Structure-preserving. Each source block is translated to exactly one
 *    target block, enforced by a structured-output schema, so headings and
 *    paragraphs stay aligned with the original for side-by-side reading.
 *  - Resumable. Completed documents are skipped, so an interrupted run of the
 *    full corpus picks up where it left off.
 *  - Cached. The system prompt is identical on every request, so it sits
 *    behind a cache breakpoint and bills at ~0.1x after the first call.
 *
 * Usage:
 *   node scripts/translate.mjs --pilot            # ~24 representative docs
 *   node scripts/translate.mjs                    # whole corpus
 *   node scripts/translate.mjs --model claude-sonnet-5 --concurrency 8
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC_DIR = path.join(ROOT, 'data', 'source');
const OUT_DIR = path.join(ROOT, 'data', 'ja');
const MANIFEST = path.join(ROOT, 'data', 'manifest.json');

/** USD per million tokens, live API. Halve for the Batch API. */
const PRICING = {
  'claude-opus-5': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};

/**
 * Roughly how many source words to send per request. Kept well below the
 * output ceiling because Japanese renders to more tokens than the English it
 * came from, and a chunk that overflows `max_tokens` is a wasted call.
 */
const WORDS_PER_CHUNK = 1800;
const MAX_TOKENS = 32000;

/**
 * One representative work per major Father, spanning the Apostolic Fathers
 * through Gregory the Great and covering the corpus's genres: apology,
 * letter, homily, treatise, commentary, history and monastic rule.
 * Verified against the ingested corpus — all are content documents, not
 * tables of contents, and sized so the whole pilot is ~71,000 words.
 */
const PILOT_IDS = [
  '0101', // Mathetes — Epistle to Diognetus
  '0104', // Ignatius of Antioch — To the Ephesians
  '0136', // Polycarp — To the Philippians
  '0132', // Justin Martyr — Fragments
  '0103', // Irenaeus — Against Heresies
  '0323', // Tertullian — To the Martyrs
  '02108', // Clement of Alexandria — Stromata VIII
  '080815', // Clement of Rome — Homily 15
  '101505', // Origen — Commentary on John V
  '050668', // Cyprian — Epistle 68
  '2804', // Eusebius — Letter on the Council of Nicaea
  '28156', // Athanasius — History of the Arians VI
  '3202217', // Basil the Great — Letter 217
  '291117', // Gregory of Nyssa — Letter 17
  '310227', // Gregory Nazianzen — First Theological Oration
  '310123', // Cyril of Jerusalem — Catechetical Lecture 23
  '3303053', // Hilary of Poitiers — On Psalm 53
  '3410', // Ambrose — The Memorial
  '140624', // Augustine — Contra Faustum XXIV
  '230605', // John Chrysostom — Homily 5 on First Timothy
  '3006', // Jerome — Life of Malchus
  '350701', // John Cassian — Institutes I
  '3604120', // Leo the Great — Letter 120
  '36014', // Gregory the Great — Pastoral Rule IV
];

function parseArgs(argv) {
  const args = {
    model: 'claude-opus-5',
    concurrency: 4,
    pilot: false,
    titles: false,
    limit: null,
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pilot') args.pilot = true;
    else if (a === '--titles') args.titles = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--model') args.model = argv[++i];
    else if (a === '--concurrency') args.concurrency = Number(argv[++i]);
    else if (a === '--limit') args.limit = Number(argv[++i]);
  }
  return args;
}

/**
 * Translation rules live in prompts/translation-rules.md, shared verbatim with
 * the agent template in prompts/agent-translate.md. Two copies of a prompt
 * drift, and the drift is invisible until the outputs disagree — so there is
 * one copy and both callers read it.
 *
 * The rules deliberately impose no controlled vocabulary. An earlier version
 * injected a 254-term glossary and it made terminology worse, not better: a
 * lookup table cannot see context. It forced 聖人 (a canonised saint) onto
 * Polycarp's ἅγιοι, which there means living believers, and 愛徳 (the
 * theological virtue) onto "love of money".
 */
const RULES = path.join(ROOT, 'prompts', 'translation-rules.md');

async function systemPrompt() {
  const rules = await readFile(RULES, 'utf8');
  return `${rules.trim()}

## Output

You receive an array of text blocks. Return exactly one Japanese translation per input block, in the same order. Never merge, split, reorder, or omit blocks. Translate every block, including short headings.

Also return \`notes\`. These are printed at the foot of the page as 訳注, so write them in Japanese, for a Japanese reader, not as a report. Each has a \`kind\` of "source" (a defect in the 1885 edition you translated as it stands — a Scripture reference pointing at the wrong verse, a misnumbered chapter) or "choice" (a rendering you judged genuinely debatable), an optional \`locus\` such as 第六章, and the \`note\` itself. Include only what a reader benefits from knowing; an empty array is a fine answer.`;
}

/**
 * Titles carry the whole navigation surface — author pages, work trees,
 * chapter lists, page headings — for about 0.1% of the corpus by volume.
 * Translating them alone makes the site read as Japanese throughout its
 * structure long before the body text is done, so it is worth a separate
 * cheap pass.
 */
function titleSystemPrompt() {
  return `You translate titles of patristic works into Japanese for a scholarly reference collection.

These are titles of works, books, chapters, letters, homilies and sections from the Church Fathers, as given in the Schaff English editions.

RULES
- Set each title as a Japanese book or chapter title is set: noun-final, no trailing punctuation, no ですます.
- Use established Japanese Catholic and patristic usage, chosen for the sense of this particular title.
- Keep structural numbering, in Japanese form: "Book I" → 「第一巻」, "Chapter 12" → 「第十二章」, "Letter 68" → 「書簡六十八」, "Homily 5" → 「説教五」, "Psalm 53" → 「詩編五十三」.
- "Against X" → 「X駁論」 or 「Xに対する反論」, whichever reads better. "On X" / "Concerning X" → 「Xについて」 or 「X論」.
- A Latin title given in Latin (De fide, Contra Faustum) keeps its Latin only where the English supplies a gloss; otherwise translate the English.
- Transliterate proper names into katakana from the Greek or Latin form.
- Keep it short. A title is not a sentence.

OUTPUT
You receive an array of English titles. Return exactly one Japanese title per input, in the same order. Never merge, split, reorder, or omit.`;
}

const TITLES_SCHEMA = {
  type: 'object',
  properties: {
    titles: {
      type: 'array',
      description: 'Japanese titles, exactly one per input title, same order.',
      items: { type: 'string' },
    },
  },
  required: ['titles'],
  additionalProperties: false,
};

const TRANSLATION_SCHEMA = {
  type: 'object',
  properties: {
    blocks: {
      type: 'array',
      description:
        'Japanese translations, exactly one per input block, in the same order.',
      items: { type: 'string' },
    },
    notes: {
      type: 'array',
      description:
        "Translator's notes in Japanese, printed as 訳注 at the foot of the page.",
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['source', 'choice'] },
          locus: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['kind', 'note'],
        additionalProperties: false,
      },
    },
  },
  required: ['blocks', 'notes'],
  additionalProperties: false,
};

/** Split a document's blocks into request-sized groups. */
function chunkBlocks(blocks) {
  const chunks = [];
  let current = [];
  let words = 0;
  for (const block of blocks) {
    const n = block.text.split(/\s+/).length;
    // Keep at least one block per chunk even if a single block is oversized.
    if (current.length && words + n > WORDS_PER_CHUNK) {
      chunks.push(current);
      current = [];
      words = 0;
    }
    current.push(block);
    words += n;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

async function translateChunk(client, model, system, blocks, context) {
  const payload = blocks.map((b, i) => ({
    i,
    type: b.type,
    text: b.text,
  }));

  const userText = `Work: ${context.title || '(untitled)'}${
    context.author ? `\nAuthor: ${context.author}` : ''
  }

Translate each block below into Japanese. Return ${blocks.length} translation${
    blocks.length === 1 ? '' : 's'
  }, one per block, in order.

${JSON.stringify(payload, null, 1)}`;

  const stream = client.messages.stream({
    model,
    max_tokens: MAX_TOKENS,
    system: [
      {
        type: 'text',
        text: system,
        // Identical on every request across the whole corpus — cache it.
        cache_control: { type: 'ephemeral' },
      },
    ],
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: TRANSLATION_SCHEMA },
    },
    messages: [{ role: 'user', content: userText }],
  });

  const message = await stream.finalMessage();

  if (message.stop_reason === 'refusal') {
    throw new Error(`refused: ${message.stop_details?.category ?? 'unknown'}`);
  }
  if (message.stop_reason === 'max_tokens') {
    throw new Error('output truncated — chunk too large');
  }

  const text = message.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('no text block in response');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('response was not valid JSON');
  }

  const out = parsed.blocks;
  if (!Array.isArray(out) || out.length !== blocks.length) {
    throw new Error(
      `block count mismatch: sent ${blocks.length}, received ${
        Array.isArray(out) ? out.length : 'non-array'
      }`
    );
  }

  return {
    translations: out,
    notes: Array.isArray(parsed.notes) ? parsed.notes : [],
    usage: message.usage,
  };
}

async function translateDocument(client, args, system, doc, context) {
  const chunks = chunkBlocks(doc.blocks);
  const translated = [];
  // A long document is translated in several requests, so notes arrive a
  // chunk at a time and are collected into one apparatus for the page.
  const notes = [];
  const usage = {
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheRead: 0,
  };

  for (const chunk of chunks) {
    let lastErr;
    // Retry transient failures, and shrink on truncation.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await translateChunk(
          client,
          args.model,
          system,
          chunk,
          context
        );
        chunk.forEach((b, i) => {
          translated.push({ type: b.type, text: res.translations[i] });
        });
        notes.push(...res.notes);
        usage.input += res.usage.input_tokens ?? 0;
        usage.output += res.usage.output_tokens ?? 0;
        usage.cacheWrite += res.usage.cache_creation_input_tokens ?? 0;
        usage.cacheRead += res.usage.cache_read_input_tokens ?? 0;
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (err instanceof Anthropic.RateLimitError) {
          await sleep(5000 * (attempt + 1));
        } else if (err instanceof Anthropic.APIConnectionError) {
          await sleep(2000 * (attempt + 1));
        } else if (attempt === 2) {
          break;
        } else {
          await sleep(1000);
        }
      }
    }
    if (lastErr) throw lastErr;
  }

  // Titles are short and worth translating in the document's own context.
  let title = null;
  if (doc.title) {
    const res = await translateChunk(
      client,
      args.model,
      system,
      [{ type: 'title', text: doc.title }],
      context
    );
    title = res.translations[0];
    usage.input += res.usage.input_tokens ?? 0;
    usage.output += res.usage.output_tokens ?? 0;
    usage.cacheWrite += res.usage.cache_creation_input_tokens ?? 0;
    usage.cacheRead += res.usage.cache_read_input_tokens ?? 0;
  }

  return {
    doc: {
      id: doc.id,
      title,
      titleEn: doc.title,
      isToc: doc.isToc,
      children: doc.children,
      blocks: translated,
      notes,
      model: args.model,
      translatedAt: new Date().toISOString(),
    },
    usage,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cost(model, usage) {
  const p = PRICING[model] ?? PRICING['claude-opus-5'];
  return (
    (usage.input / 1e6) * p.in +
    (usage.cacheWrite / 1e6) * p.in * 1.25 +
    (usage.cacheRead / 1e6) * p.in * 0.1 +
    (usage.output / 1e6) * p.out
  );
}

/**
 * Translate every document title in one cheap pass, writing a flat
 * id -> title map. Titles are short, so many fit in a single request; the
 * limit is the response size, not the prompt.
 */
async function runTitles(client, args) {
  const TITLES_FILE = path.join(ROOT, 'data', 'titles-ja.json');
  const TITLES_PER_CHUNK = 100;

  const existing = existsSync(TITLES_FILE)
    ? JSON.parse(await readFile(TITLES_FILE, 'utf8'))
    : {};

  const ids = (await readdir(SRC_DIR))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));

  const pending = [];
  for (const id of ids) {
    if (existing[id]) continue;
    const src = JSON.parse(
      await readFile(path.join(SRC_DIR, `${id}.json`), 'utf8')
    );
    if (src.title) pending.push({ id, title: src.title });
  }

  const queue = args.limit ? pending.slice(0, args.limit) : pending;

  console.log(`Titles already done: ${Object.keys(existing).length}`);
  console.log(`Titles to translate: ${queue.length}`);

  if (args.dryRun) {
    const words = queue.reduce((n, t) => n + t.title.split(/\s+/).length, 0);
    const p = PRICING[args.model] ?? PRICING['claude-opus-5'];
    const live = (words * 1.4) / 1e6 * p.in + (words * 2.2) / 1e6 * p.out;
    console.log(`\n${words.toLocaleString()} words of titles`);
    console.log(`  est. live API : $${live.toFixed(2)}`);
    console.log(`  est. batch API: $${(live / 2).toFixed(2)}`);
    return;
  }

  if (!queue.length) {
    console.log('\nNothing to do.');
    return;
  }

  const system = titleSystemPrompt();
  const chunks = [];
  for (let i = 0; i < queue.length; i += TITLES_PER_CHUNK) {
    chunks.push(queue.slice(i, i + TITLES_PER_CHUNK));
  }

  const usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  let done = 0;

  const runChunk = async (chunk) => {
    const stream = client.messages.stream({
      model: args.model,
      max_tokens: MAX_TOKENS,
      system: [
        { type: 'text', text: system, cache_control: { type: 'ephemeral' } },
      ],
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: TITLES_SCHEMA },
      },
      messages: [
        {
          role: 'user',
          content: `Translate these ${chunk.length} titles into Japanese. Return ${chunk.length} titles, in order.\n\n${JSON.stringify(
            chunk.map((c) => c.title),
            null,
            1
          )}`,
        },
      ],
    });

    const message = await stream.finalMessage();
    if (message.stop_reason === 'refusal') throw new Error('refused');
    if (message.stop_reason === 'max_tokens') throw new Error('truncated');

    const text = message.content.find((b) => b.type === 'text')?.text;
    const out = JSON.parse(text).titles;
    if (!Array.isArray(out) || out.length !== chunk.length) {
      throw new Error(
        `count mismatch: sent ${chunk.length}, got ${out?.length ?? '?'}`
      );
    }

    chunk.forEach((c, i) => {
      existing[c.id] = out[i];
    });
    usage.input += message.usage.input_tokens ?? 0;
    usage.output += message.usage.output_tokens ?? 0;
    usage.cacheWrite += message.usage.cache_creation_input_tokens ?? 0;
    usage.cacheRead += message.usage.cache_read_input_tokens ?? 0;
  };

  // Warm the cache on one chunk before fanning out.
  const rest = [...chunks];
  const first = rest.shift();
  await runChunk(first);
  done += first.length;
  await writeFile(TITLES_FILE, JSON.stringify(existing, null, 1), 'utf8');
  console.log(`  ✓ ${done}/${queue.length}`);

  const workers = Array.from(
    { length: Math.max(1, args.concurrency) },
    async () => {
      while (rest.length) {
        const chunk = rest.shift();
        try {
          await runChunk(chunk);
          done += chunk.length;
          // Persist as we go, so an interrupted run keeps its progress.
          await writeFile(
            TITLES_FILE,
            JSON.stringify(existing, null, 1),
            'utf8'
          );
          console.log(
            `  ✓ ${done}/${queue.length}  $${cost(args.model, usage).toFixed(2)}`
          );
        } catch (err) {
          console.error(`  ✗ chunk of ${chunk.length}: ${err.message}`);
        }
      }
    }
  );
  await Promise.all(workers);

  console.log(`\nTranslated ${done} titles. Cost: $${cost(args.model, usage).toFixed(2)}`);
  console.log(`Wrote ${TITLES_FILE}`);
}

/** Map every document id to its author and work, for translation context. */
function buildContextIndex(manifest) {
  const index = new Map();
  const walk = (node, author, work) => {
    index.set(node.id, { author, work });
    for (const child of node.children ?? []) walk(child, author, work);
  };
  for (const author of manifest.authors) {
    for (const work of author.works) walk(work, author.name, work.title);
  }
  return index;
}

async function main() {
  const args = parseArgs(process.argv);

  if (!PRICING[args.model]) {
    console.warn(`Unknown model "${args.model}" — cost estimates will be off.`);
  }

  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
  const system = await systemPrompt();
  const contextIndex = buildContextIndex(manifest);

  await mkdir(OUT_DIR, { recursive: true });

  if (args.titles) {
    console.log(`Model:       ${args.model}`);
    // Dry run needs no client, so build it only when actually translating.
    const client = args.dryRun ? null : new Anthropic();
    await runTitles(client, args);
    return;
  }

  let ids;
  if (args.pilot) {
    ids = PILOT_IDS.filter((id) => existsSync(path.join(SRC_DIR, `${id}.json`)));
    const missing = PILOT_IDS.filter(
      (id) => !existsSync(path.join(SRC_DIR, `${id}.json`))
    );
    if (missing.length) {
      console.warn(`Pilot ids not found in corpus, skipping: ${missing.join(', ')}`);
    }
  } else {
    ids = (await readdir(SRC_DIR))
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
  }

  // Resume: skip anything already translated.
  const pending = ids.filter(
    (id) => !existsSync(path.join(OUT_DIR, `${id}.json`))
  );
  const done = ids.length - pending.length;

  const queue = args.limit ? pending.slice(0, args.limit) : pending;

  console.log(`Model:       ${args.model}`);
  console.log(`Selected:    ${ids.length} documents`);
  console.log(`Already done:${String(done).padStart(6)}`);
  console.log(`To translate:${String(queue.length).padStart(6)}`);

  if (args.dryRun) {
    let words = 0;
    for (const id of queue) {
      const doc = JSON.parse(
        await readFile(path.join(SRC_DIR, `${id}.json`), 'utf8')
      );
      words += doc.words;
    }
    // ~1.4 source tokens per English word; Japanese output runs heavier.
    const inTok = words * 1.4;
    const outTok = words * 2.2;
    const p = PRICING[args.model] ?? PRICING['claude-opus-5'];
    const live = (inTok / 1e6) * p.in + (outTok / 1e6) * p.out;
    console.log(`\nDry run: ${words.toLocaleString()} source words`);
    console.log(`  est. live API : $${live.toFixed(2)}`);
    console.log(`  est. batch API: $${(live / 2).toFixed(2)} (50% discount)`);
    return;
  }

  if (!queue.length) {
    console.log('\nNothing to do.');
    return;
  }

  const client = new Anthropic();

  const total = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  let completed = 0;
  let failed = 0;
  const failures = [];
  const started = Date.now();

  // Warm the cache with one document before fanning out, so the concurrent
  // workers read the cached system prompt instead of each writing their own.
  const workerIds = [...queue];
  const first = workerIds.shift();

  const runOne = async (id) => {
    const doc = JSON.parse(
      await readFile(path.join(SRC_DIR, `${id}.json`), 'utf8')
    );
    if (!doc.blocks.length) {
      await writeFile(
        path.join(OUT_DIR, `${id}.json`),
        JSON.stringify({ ...doc, title: null, blocks: [], notes: [] }, null, 1),
        'utf8'
      );
      completed++;
      return;
    }
    const ctx = contextIndex.get(id) ?? {};
    const { doc: out, usage } = await translateDocument(
      client,
      args,
      system,
      doc,
      { title: doc.title ?? ctx.work, author: ctx.author }
    );
    await writeFile(
      path.join(OUT_DIR, `${id}.json`),
      JSON.stringify(out, null, 1),
      'utf8'
    );
    total.input += usage.input;
    total.output += usage.output;
    total.cacheWrite += usage.cacheWrite;
    total.cacheRead += usage.cacheRead;
    completed++;
  };

  const report = (id, err) => {
    failed++;
    failures.push({ id, error: err.message });
    console.error(`  ✗ ${id}: ${err.message}`);
  };

  console.log('\nWarming cache…');
  try {
    await runOne(first);
    console.log(`  ✓ ${first}`);
  } catch (err) {
    report(first, err);
  }

  const workers = Array.from(
    { length: Math.max(1, args.concurrency) },
    async () => {
      while (workerIds.length) {
        const id = workerIds.shift();
        try {
          await runOne(id);
          const pct = ((completed / queue.length) * 100).toFixed(1);
          const spend = cost(args.model, total);
          console.log(
            `  ✓ ${id}  [${completed}/${queue.length} ${pct}%]  $${spend.toFixed(2)}`
          );
        } catch (err) {
          report(id, err);
        }
      }
    }
  );

  await Promise.all(workers);

  const mins = ((Date.now() - started) / 60000).toFixed(1);
  console.log(`\nTranslated ${completed}, failed ${failed}, in ${mins} min`);
  console.log(
    `Tokens: ${total.input.toLocaleString()} in, ${total.output.toLocaleString()} out, ` +
      `${total.cacheRead.toLocaleString()} cache-read`
  );
  console.log(`Cost: $${cost(args.model, total).toFixed(2)}`);

  if (failures.length) {
    await writeFile(
      path.join(ROOT, 'data', 'failures.json'),
      JSON.stringify(failures, null, 1),
      'utf8'
    );
    console.log(`\nFailures written to data/failures.json — rerun to retry.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
