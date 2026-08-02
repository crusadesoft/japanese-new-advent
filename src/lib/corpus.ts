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
  markers?: string[];
  children: WorkNode[];
}

export interface Author {
  slug: string;
  name: string;
  dates: string | null;
  markers?: string[];
  isSaint: boolean;
  isDoctor: boolean;
  cathen: string | null;
  works: WorkNode[];
}

/**
 * Classification markers carried by the source index. Sainthood and doctorate
 * attach to authors; the rest attach to individual works and record how the
 * tradition regards them — attribution, origin, or the standing of a council.
 * `tone` drives colour, following the source's own three-way distinction.
 */
export const MARKERS: Record<string, { ja: string; tone: 'saint' | 'doctor' | 'note' }> = {
  SAINT: { ja: '聖人', tone: 'saint' },
  DOCTOR: { ja: '教会博士', tone: 'doctor' },
  SPURIOUS: { ja: '偽作', tone: 'note' },
  ECUMENICAL: { ja: '公会議', tone: 'note' },
  LOCAL: { ja: '地方教会会議', tone: 'note' },
  SYRIAC: { ja: 'シリア語', tone: 'note' },
  GNOSTIC: { ja: 'グノーシス派', tone: 'note' },
  JUDAISTIC: { ja: 'ユダヤ主義', tone: 'note' },
  DOCETIC: { ja: '仮現論', tone: 'note' },
  EBIONITIC: { ja: 'エビオン派', tone: 'note' },
  NESTORIAN: { ja: 'ネストリウス派', tone: 'note' },
  ABYSSINIAN: { ja: 'エチオピア教会', tone: 'note' },
};

export function marker(key: string) {
  return MARKERS[key] ?? { ja: key, tone: 'note' as const };
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

/**
 * Titles-only pass output. Titles drive the entire navigation surface, so
 * they are translated ahead of body text and land in a flat map rather than
 * per-document files. A title here does NOT mark a document as translated —
 * the body is still English and must keep its notice.
 */
let _titles: Record<string, string> | null = null;

function titleJa(id: string): string | null {
  if (_titles === null) {
    _titles = readJson(path.join(ROOT, 'data', 'titles-ja.json')) ?? {};
  }
  return _titles![id] ?? null;
}

export function getDocument(id: string): Document | null {
  const src = readJson(path.join(SRC_DIR, `${id}.json`));
  if (!src) return null;
  const ja = readJson(path.join(JA_DIR, `${id}.json`));

  return {
    id,
    title: ja?.title ?? titleJa(id),
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
 * Japanese display name for an author. This is presentation data — the site
 * has to label navigation without calling a model — and deliberately does not
 * constrain how the texts themselves are translated. Falls back to the
 * English name when no mapping exists.
 */
let _names: Record<string, string> | null = null;

export function authorNameJa(name: string): string {
  if (!_names) {
    _names = JSON.parse(
      readFileSync(path.join(ROOT, 'scripts', 'names.json'), 'utf8')
    );
  }
  return _names![name] ?? name;
}

/**
 * Life dates. The upstream index carries them for only 14 of 69 authors, so
 * a curated table fills the rest — without it, era grouping puts four-fifths
 * of the corpus under "unknown" and stops being useful.
 */
let _dates: Record<string, string> | null = null;

export function authorDates(author: Author): string | null {
  if (!_dates) {
    _dates = JSON.parse(
      readFileSync(path.join(ROOT, 'scripts', 'dates.json'), 'utf8')
    );
  }
  return author.dates ?? _dates![author.name] ?? null;
}

/** Earliest year mentioned in a date string, for sorting. */
function anchorYear(dates: string | null): number | null {
  if (!dates) return null;
  const m = dates.match(/(\d{3,4})/);
  return m ? Number(m[1]) : null;
}

/**
 * Group authors by era, ordered chronologically within each group. Eras are
 * cut at the two councils that patristic scholarship conventionally uses as
 * dividing lines.
 */
export function authorsByEra(authors: Author[]) {
  const order = [
    'ニカイア公会議以前（〜325年）',
    'ニカイアからカルケドンまで（325〜451年）',
    'カルケドン公会議以後（451年〜）',
    '年代不詳',
  ];

  const eraOf = (year: number | null): string => {
    if (year === null) return order[3];
    if (year < 325) return order[0];
    if (year < 451) return order[1];
    return order[2];
  };

  const groups = new Map<string, { author: Author; dates: string | null }[]>();
  for (const a of authors) {
    const dates = authorDates(a);
    const era = eraOf(anchorYear(dates));
    if (!groups.has(era)) groups.set(era, []);
    groups.get(era)!.push({ author: a, dates });
  }

  for (const list of groups.values()) {
    list.sort((x, y) => {
      const ax = anchorYear(x.dates);
      const ay = anchorYear(y.dates);
      if (ax !== null && ay !== null && ax !== ay) return ax - ay;
      return x.author.name.localeCompare(y.author.name);
    });
  }

  return order
    .filter((e) => groups.has(e))
    .map((e) => ({ era: e, entries: groups.get(e)! }));
}
