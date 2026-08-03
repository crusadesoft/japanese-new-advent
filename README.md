# 教父文庫 — The Church Fathers in Japanese

Japanese translations of the Church Fathers, published as a free static site.

69 Fathers · 420 works · 3,727 documents · ~15.3M words of English source.

## Sources and licence

- _Ante-Nicene Fathers_ (1885–1887) and _Nicene and Post-Nicene Fathers_,
  First and Second Series (1886–1900), ed. Philip Schaff and others.
  Public domain. Also hosted by [CCEL](https://ccel.org).
- Translations and site code: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
- Document numbering follows newadvent.org. Upstream HTML is not
  redistributed (`data/raw/` is gitignored). Unaffiliated with that site.
- Modern Japanese Bible translations are under copyright and are not used.

## Pipeline

```
upstream HTML ──ingest──▶ data/source/*.json ──translate──▶ data/ja/*.json ──astro──▶ dist/
                          data/manifest.json                data/titles-ja.json
```

### Ingest

```bash
npm install
npm run ingest -- --src /path/to/fathers
```

Emits one JSON file per document with ordered blocks (`heading`,
`subheading`, `p`, `quote`, `li`), plus `data/manifest.json` holding the
author → work → chapter tree.

### Translate

```bash
export ANTHROPIC_API_KEY=sk-ant-...

npm run translate:titles      # all document titles → data/titles-ja.json
npm run translate:pilot       # 24 representative documents
npm run translate             # full corpus, resumable
npm run translate -- --dry-run
```

Options: `--model`, `--concurrency`, `--limit`, `--dry-run`, `--pilot`,
`--titles`.

Rules live in `prompts/translation-rules.md`, read by `translate.mjs` and
pasted into agent prompts. `prompts/agent-translate.md` is the agent
template. Each translated document carries a `notes` array rendered as 訳注
at the foot of its page and anchored to the block it annotates.

### Build

```bash
npm run dev
npm run build
```

Untranslated documents render the English source with a notice.

### Checks

```bash
node scripts/verify-translations.mjs        # structure and feature carry-over
node scripts/audit-ingest.mjs --other DIR   # parser vs an independent extraction
```

## Deployment

GitHub Actions → GitHub Pages on push to `main`.

```
SITE_URL=https://crusadesoft.github.io
BASE_PATH=/japanese-new-advent
```

Build internal links with `withBase()` from `src/lib/paths.ts`.

For a custom domain: add `public/CNAME`, point DNS at GitHub Pages, and set
`SITE_URL` to the domain with `BASE_PATH=/`.

## Contributing

Open an issue with the document URL and the passage in question.
