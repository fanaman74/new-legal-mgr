# Guidance for coding agents

Read `README.md` and `docs/architecture.md` first.

## Project owner preference: no terminal

The project owner does not want to use a terminal. Every user-facing workflow must be
reachable from the double-click launchers (`Start Legal Evidence Manager.bat` / `.command` /
`start.sh`) and the local browser app:

- New features get a button or screen in the app (`src/app/`), not only a CLI command.
  CLIs remain for developers and automation.
- The launchers must keep working without prior setup: they check for Node.js (and download a
  private, checksum-verified copy into `.runtime/` if needed), install or update libraries only
  when needed (`scripts/ensure-deps.mjs`), check prerequisites (`src/app/prereqs.ts`), and
  reopen an already-running instance instead of starting a second one.
- Error messages shown to the user must say what to do in plain language.
- When documenting, lead with the double-click route; terminal commands come second.

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
  slashes, and keep every command an `npm run` script (no Makefile). The only shell scripts are
  the launchers; `.bat`/`.ps1` files must keep CRLF line endings (see `.gitattributes`).
- Parsers return the format-neutral `ParseOutput` (`src/ingestion/parsers/types.ts`). Do not
  leak library types into domain code.
- UK English in documentation and UI text.
- Small, reviewable commits. Run `npm run typecheck && npm test` before committing.
- Ask before adding infrastructure: does it directly improve one of the five POC workflows
  (fact retrieval, chronology, contradiction/change detection, unaddressed evidence,
  citation verification)? Avoid Docker, graph databases, multiple vector stores and agent
  frameworks unless an evaluation failure requires them.
- Versioned prompts live in `config/prompts/<name>.v<N>.md`. Never edit a released version.
