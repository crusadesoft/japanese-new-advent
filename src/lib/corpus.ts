/**
 * Corpus access layer.
 *
 * Merges the ingested English source with whatever Japanese translations
 * exist. Translation runs incrementally over 3,700+ documents, so every read
 * path has to work when a document has not been translated yet — the site
 * shows the English with a notice rather than 404ing or hiding the work.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(process.cwd());
const SRC_DIR = path.join(ROOT, 'data', 'source');
const JA_DIR = path.join(ROOT, 'data', 'ja');
const MANIFEST = path.join(ROOT, 'data', 'manifest.json');

export type BlockType = 'heading' | 'subheading' | 'p' | 'quote' | 'li';

export interface Block {
  type: BlockType;
  text: string;
}

export interface WorkNode {
  id: string;
  title: string | null;
  label?: string;
  slug?: string;
  isToc: boolean;
  words: number;
  children: WorkNode[];
}

export interface Author {
  slug: string;
  name: string;
  dates: string | null;
  isSaint: boolean;
  isDoctor: boolean;
  cathen: string | null;
  works: WorkNode[];
}

export interface Manifest {
  generatedAt: string;
  source: string;
  counts: {
    authors: number;
    works: number;
    documents: number;
    words: number;
  };
  authors: Author[];
}

export interface Document {
  id: string;
  /** Japanese title when translated, else null. */
  title: string | null;
  titleEn: string | null;
  isToc: boolean;
  children: { id: string; label: string }[];
  blocks: Block[];
  blocksEn: Block[];
  translated: boolean;
  words: number;
}

let _manifest: Manifest | null = null;

export function getManifest(): Manifest {
  if (!_manifest) {
    _manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  }
  return _manifest!;
}

const readJson = (file: string) =>
  existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;

export function getDocument(id: string): Document | null {
  const src = readJson(path.join(SRC_DIR, `${id}.json`));
  if (!src) return null;
  const ja = readJson(path.join(JA_DIR, `${id}.json`));

  return {
    id,
    title: ja?.title ?? null,
    titleEn: src.title ?? null,
    isToc: src.isToc,
    children: src.children ?? [],
    blocks: ja?.blocks?.length ? ja.blocks : [],
    blocksEn: src.blocks ?? [],
    translated: Boolean(ja?.blocks?.length),
    words: src.words ?? 0,
  };
}

/** Every document id present in the ingested corpus. */
export function allDocumentIds(): string[] {
  return readdirSync(SRC_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
}

/** Ids that have a Japanese translation on disk. */
export function translatedIds(): Set<string> {
  if (!existsSync(JA_DIR)) return new Set();
  return new Set(
    readdirSync(JA_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
  );
}

/** Corpus-wide translation progress, for the home page and footer. */
export function progress() {
  const done = translatedIds();
  const all = allDocumentIds();
  let translatedWords = 0;
  let totalWords = 0;
  for (const id of all) {
    const src = readJson(path.join(SRC_DIR, `${id}.json`));
    const w = src?.words ?? 0;
    totalWords += w;
    if (done.has(id)) translatedWords += w;
  }
  return {
    documents: all.length,
    translatedDocuments: done.size,
    words: totalWords,
    translatedWords,
    percent: totalWords ? (translatedWords / totalWords) * 100 : 0,
  };
}

/** Walk a work tree, yielding every node depth-first. */
export function flattenWork(node: WorkNode, out: WorkNode[] = []): WorkNode[] {
  out.push(node);
  for (const child of node.children ?? []) flattenWork(child, out);
  return out;
}

/** Reverse index: document id -> its author and top-level work. */
let _index: Map<string, { author: Author; work: WorkNode }> | null = null;

export function locate(id: string) {
  if (!_index) {
    _index = new Map();
    for (const author of getManifest().authors) {
      for (const work of author.works) {
        for (const node of flattenWork(work)) {
          if (!_index.has(node.id)) _index.set(node.id, { author, work });
        }
      }
    }
  }
  return _index.get(id) ?? null;
}

/**
 * Japanese display name for an author, from the translation glossary.
 * Falls back to the English name when no mapping exists.
 */
let _names: Record<string, string> | null = null;

export function authorNameJa(name: string): string {
  if (!_names) {
    const g = JSON.parse(
      readFileSync(path.join(ROOT, 'scripts', 'glossary.json'), 'utf8')
    );
    _names = { ...(g.fathers ?? {}), ...(g.collections ?? {}) };
  }
  return _names![name] ?? name;
}

/** Group authors by the era their works belong to, for the index page. */
export function authorsByEra(authors: Author[]) {
  const eraOf = (a: Author): string => {
    const m = a.dates?.match(/(\d{3,4})/);
    const year = m ? Number(m[1]) : null;
    if (year === null) return '年代不詳';
    if (year < 325) return 'ニカイア公会議以前';
    if (year < 451) return 'ニカイアからカルケドンまで';
    return 'カルケドン公会議以後';
  };
  const order = [
    'ニカイア公会議以前',
    'ニカイアからカルケドンまで',
    'カルケドン公会議以後',
    '年代不詳',
  ];
  const groups = new Map<string, Author[]>();
  for (const a of authors) {
    const era = eraOf(a);
    if (!groups.has(era)) groups.set(era, []);
    groups.get(era)!.push(a);
  }
  return order
    .filter((e) => groups.has(e))
    .map((e) => ({ era: e, authors: groups.get(e)! }));
}
