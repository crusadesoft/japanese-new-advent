# japanese-new-advent

Japanese translations of the Church Fathers, published as a static site.

## Background

The English base texts are the _Ante-Nicene Fathers_ (1885–1887) and _Nicene
and Post-Nicene Fathers_, First and Second Series (1886–1900), edited by
Philip Schaff and others. They are in the public domain and are also hosted
by [CCEL](https://ccel.org).

Document numbering follows newadvent.org. This project is unaffiliated with
that site and does not redistribute its HTML.

## Install

```bash
git clone https://github.com/crusadesoft/japanese-new-advent.git
cd japanese-new-advent
npm install
```

Requires Node 22 or later.

## Usage

The corpus moves through three stages:

```
upstream HTML ──ingest──▶ data/source/ ──translate──▶ data/ja/ ──build──▶ dist/
```

### Ingest

Parses upstream HTML into one JSON file per document, plus
`data/manifest.json` holding the author → work → chapter tree.

```bash
npm run ingest -- --src /path/to/fathers
```

### Translate

```bash
export ANTHROPIC_API_KEY=sk-ant-...

npm run translate:titles      # document titles only
npm run translate:pilot       # 24 representative documents
npm run translate             # full corpus, resumable
```

Flags: `--model`, `--concurrency`, `--limit`, `--dry-run`, `--pilot`,
`--titles`.

Translation rules live in `prompts/translation-rules.md`, read by the
pipeline and pasted into agent prompts. `prompts/agent-translate.md` is the
template for translating with agents instead.

### Build

```bash
npm run dev      # local server
npm run build    # static output to dist/
```

Documents without a translation render their English source.

### Verify

```bash
node scripts/verify-translations.mjs        # translations against sources
node scripts/audit-ingest.mjs --other DIR   # parser against another extraction
```

## Deployment

Pushing to `main` builds and publishes to GitHub Pages.

```
SITE_URL=https://crusadesoft.github.io
BASE_PATH=/japanese-new-advent
```

Internal links use `withBase()` from `src/lib/paths.ts`.

To serve from a custom domain, add `public/CNAME`, point DNS at GitHub
Pages, and set `SITE_URL` to the domain with `BASE_PATH=/`.

## Contributing

Issues and pull requests are welcome. For a translation problem, open an
issue with the page URL and the passage.

## License

[CC0-1.0](LICENSE) — public domain, no attribution required.
