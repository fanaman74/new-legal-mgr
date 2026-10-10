# Guidance for coding agents

Read `README.md` and `docs/architecture.md` first.

## Non-negotiable rules

1. **Never write inside the originals directory** (`data/originals/` or `LEGAL_ORIGINALS_DIR`).
   All writes must go through `src/util/fs-guard.ts` (`safeWriteFile`, `safeWriteNewFile`,
   `safeAppendLine`, `writeJson`, `ensureDir`). Do not call `fs.writeFile*`, `fs.rename*`,
   `fs.rm*`, `fs.unlink*` or `fs.chmod*` on evidence paths. (Test code may set up fixtures directly.)
2. **Never fabricate metadata.** Unknown values are `null`, `[]` or `"unknown"`, and uncertain
   values carry a confidence and a basis. Never invent page numbers for non-paginated formats.
3. **Provenance first.** Every retrievable piece of text must trace to an Evidence ID and to
   a page (PDF) or section/paragraph (other formats), with `chunk.text ===
   unit.text.slice(char_start, char_end)`.
4. **No document content in logs.** The audit log and console output carry IDs, hashes, paths,
   statuses and short errors only.
5. **Local-first.** No network calls at runtime unless explicitly configured. No telemetry.
   External LLMs only behind `ALLOW_EXTERNAL_LLM=true`.
6. **No evidence in Git.** Fixtures are generated (`src/testing/`), never real documents.

## Conventions

- TypeScript strict mode, ES modules (`.js` suffix in relative imports), zod for every
  external/canonical model (`src/evidence/models.ts` is the source of truth; update
  `docs/evidence-schema.md` with it).
- Cross-platform (Windows included): use `path.join`, store relative paths with forward
  slashes, and keep every command an `npm run` script (no bash-only scripts, no Makefile).
- Parsers return the format-neutral `ParseOutput` (`src/ingestion/parsers/types.ts`). Do not
  leak library types into domain code.
- UK English in documentation and UI text.
- Small, reviewable commits. Run `npm run typecheck && npm test` before committing.
- Ask before adding infrastructure: does it directly improve one of the five POC workflows
  (fact retrieval, chronology, contradiction/change detection, unaddressed evidence,
  citation verification)? Avoid Docker, graph databases, multiple vector stores and agent
  frameworks unless an evaluation failure requires them.
- Versioned prompts live in `config/prompts/<name>.v<N>.md`. Never edit a released version.
