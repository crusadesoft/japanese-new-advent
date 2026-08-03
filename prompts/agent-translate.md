# Agent translation template

Copy the block below into an agent prompt, substituting `{{ID}}` and `{{WORK}}`.
Everything between the rules markers is `translation-rules.md` verbatim — paste
its current contents rather than an older copy, so the agents and the pipeline
stay in step.

Keep it as it is. It states the task, the input, the output shape, and asks for
a report. Do not add to it:

- **Do not read the source first to hardcode facts about it** ("exactly 30
  blocks"). The agent reads the file and works that out; a stale count from
  your own earlier read becomes a constraint that fights the document.
- **Do not embed verification commands.** Verify the output yourself
  afterwards. An agent asked to self-verify reports that it passed.
- **Do not ask leading questions** about terms you expect to see. You get back
  the answers you fished for instead of what the agent actually found.
- **Delete any existing output file before re-running.** "Overwrite it" leaves
  the old translation readable, and the agent may anchor on it — which
  silently invalidates any comparison you were running.

---

```
Translate a Church Father's text from English into Japanese. Work in /Users/gfelter/code/japanese-new-advent.

Read `data/source/{{ID}}.json` — {{WORK}}. It has a `title` (string) and `blocks`.

Instructions

<<< paste translation-rules.md here >>>

OUTPUT
Write `data/ja/{{ID}}.json`. Mirror the source file's structure: same keys, one translated block per source block in the same order with the same `type`. Set `title` to the Japanese title, add `titleEn` with the original English title, and add `model` and `translatedAt` fields.

Also add a `notes` array. These are printed at the foot of the page as 訳注, so write them in Japanese, for a Japanese reader, not as a report to me. Each entry is `{"kind": "source"|"choice", "locus": "第六章", "note": "..."}`, where `locus` is optional:

- `source` — a defect in the 1885 edition you translated as it stands: a Scripture reference pointing at the wrong verse, a misnumbered chapter. Say what the source has and what it appears to be for.
- `choice` — a rendering you judged genuinely debatable, where a competent translator could reasonably differ. Say what you chose and what the alternative was.

Include only what a reader benefits from knowing. An empty array is a fine answer for a document that raised nothing.

Then report back briefly: the Japanese title, and anything about the document worth my attention.
```

---

## Batching

For several documents in one agent, replace the read line with a list and the
output line with the directory:

```
Read these files in data/source/: 0101.json, 0104.json, 0136.json

OUTPUT
For each, write data/ja/<id>.json, mirroring that file's structure.
```

Six documents per agent runs about 70–120k tokens. Beyond that the agent
starts economising on the later documents.

## After the run

Verify yourself — do not rely on the agent's own check:

```bash
node scripts/verify-translations.mjs
```

That checks block count, per-block type alignment, empty blocks, untranslated
blocks, and quotation-mark recovery against the source.
