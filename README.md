# 教父文庫 — The Church Fathers in Japanese

Japanese translations of the Church Fathers, built from public-domain sources
and published as a free, ad-free static site.

**Scope:** 69 Fathers, 420 works, 3,727 documents, ~15.3 million words of
English source text.

---

## Provenance

The English base texts are the standard nineteenth-century series:

- _Ante-Nicene Fathers_ (1885–1887)
- _Nicene and Post-Nicene Fathers_, First and Second Series (1886–1900)

Both were edited by Philip Schaff and others, published more than a century
ago, and are unambiguously in the public domain. The same editions are hosted
in clean form by the [Christian Classics Ethereal Library](https://ccel.org),
which is the recommended reference for verifying any passage.

The Japanese translations, the theological glossary, and the site code
produced in this repository are released under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) — public domain,
no attribution required.

**On the ingest source.** `scripts/ingest.mjs` reads a directory of upstream
HTML files. The structure and document numbering follow newadvent.org, whose
pages carry an editorial copyright over their own modernizations and hyperlink
apparatus — not over the public-domain text beneath. This repository does not
redistribute those files (`data/raw/` is gitignored) and does not reproduce
that editorial layer; translation works from the public-domain text. This
project is unaffiliated with newadvent.org.

**Scripture.** Every modern Japanese Bible translation (新共同訳, 聖書協会共同訳)
is under active copyright. Scripture quotations inside patristic texts are
therefore translated as part of the Father's own text, never substituted from a
published Japanese Bible.

---

## Pipeline

```
upstream HTML  ──ingest──▶  data/source/*.json  ──translate──▶  data/ja/*.json  ──astro──▶  dist/
                            data/manifest.json
```

### 1. Ingest

```bash
npm install
npm run ingest -- --src /path/to/fathers
```

Parses each document's content well into ordered blocks (`heading`,
`subheading`, `p`, `quote`, `li`), strips site chrome, distinguishes
table-of-contents pages from prose, and resolves the author → work → chapter
tree into `data/manifest.json`.

Two upstream data quirks are repaired here, both of which silently destroy
documents if ignored:

- **Unclosed page markers.** 145 occurrences of `<!--kNN--` are never
  terminated. A conforming parser treats the rest of the file as a comment,
  emptying the document. These are removed _before_ well-formed comments, so
  a stray marker cannot pair with a later legitimate `-->` and delete every
  paragraph in between.
- **Nested boilerplate.** The "About this page" credits block sits _inside_
  the content well, so it must be pruned explicitly or it ends up translated
  onto every page.

### 2. Translate

```bash
export ANTHROPIC_API_KEY=sk-ant-...

npm run translate:titles                # all 3,727 titles (~$0.94)
npm run translate:pilot                 # 24 representative documents (~$4)
npm run translate                       # full corpus (resumable)
npm run translate -- --dry-run          # cost estimate only
```

**Start with titles.** Document titles are ~0.1% of the corpus by volume but
carry the entire navigation surface — author pages, work trees, chapter lists,
page headings. Translating them alone makes the site read as Japanese
throughout its structure for under a dollar, long before body text is done.
Output goes to `data/titles-ja.json`; a translated title does not mark a
document as translated, so the body keeps its English notice.

Design points that matter at this scale:

- **Structure-preserving.** A structured-output schema forces exactly one
  translated block per source block, so headings and paragraphs stay aligned
  with the original and side-by-side reading stays possible.
- **Resumable.** Completed documents are skipped; an interrupted run resumes.
- **Cached.** The system prompt and glossary are byte-identical on every
  request and sit behind a cache breakpoint, billing at ~0.1× after the first
  call. One document is translated first to warm the cache before the workers
  fan out.
- **Glossary-enforced.** `scripts/glossary.json` fixes 254 terms — doctrine,
  church offices, sacraments, heresies, and every Father's name — following
  Catholic Bishops' Conference of Japan (カトリック中央協議会) usage.
  Consistency across thousands of documents matters more than local elegance.

Options: `--model`, `--concurrency`, `--limit`, `--dry-run`, `--pilot`.

#### Cost

Measured against the real corpus (15.3M source words):

| Model           | Live API | Batch API (50% off) |
| --------------- | -------: | ------------------: |
| `claude-opus-5`   |    ~$951 |                ~$476 |
| `claude-sonnet-5` |    ~$571 |                ~$285 |

The pilot costs about $4. Prompt caching reduces these further in practice —
the estimates above do not assume cache hits. For the full corpus the
[Batch API](https://platform.claude.com/docs/en/build-with-claude/batch-processing)
is the right choice: the work is not latency-sensitive and the discount is
straightforward.

### 3. Build

```bash
npm run dev      # local preview
npm run build    # static output to dist/
```

Every document gets a page whether or not it has been translated. Untranslated
documents render the English source with a notice, so the site is navigable
and useful from the first day and improves continuously as translation
proceeds.

---

## Deployment

GitHub Actions builds and publishes to GitHub Pages on every push to `main`.

The site currently deploys as a **project page** at a subpath, so the build
sets `base` accordingly:

```
SITE_URL=https://crusadesoft.github.io
BASE_PATH=/japanese-new-advent
```

Every internal link is built through `withBase()` in `src/lib/paths.ts`.
Hardcoding `/authors/…` will silently 404 on the subpath deployment — use the
helpers.

### Moving to 教父.jp

The intended production domain is **教父.jp**, an internationalized domain
name. Astro and the `CNAME` file both need the punycode form,
`xn--wcv59z.jp`. Once the domain is registered:

1. Add `public/CNAME` containing `xn--wcv59z.jp`.
2. Point the domain's DNS at GitHub Pages.
3. Change the workflow environment to `SITE_URL=https://xn--wcv59z.jp` and
   `BASE_PATH=/`.

`.jp` registration generally requires a Japanese address or a registrar
trustee service — worth confirming before committing to the name.

---

## Contributing

Corrections are the most valuable contribution. The translations are
machine-produced and have not been fully reviewed by hand; patristic Greek and
Latin filtered through Victorian English into Japanese leaves real room for
error, particularly in trinitarian and christological vocabulary.

Open an issue with the document URL and the passage in question.
