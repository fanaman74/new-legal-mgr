import path from "node:path";
import { Command } from "commander";
import { REPO_ROOT } from "../src/config.js";
import { generateSampleCorpus } from "../src/testing/sample-corpus.js";

const program = new Command()
  .name("sample-corpus")
  .description("Generate a small, entirely fictional sample corpus for trying the POC.")
  .option("--out <dir>", "output directory (must be empty)", path.join(REPO_ROOT, "data", "sample-originals"))
  .parse();

const { out } = program.opts<{ out: string }>();
const files = await generateSampleCorpus(path.resolve(out));
for (const f of files) console.log(`${f.relativePath.padEnd(62)} ${f.description}`);
console.log(`\n${files.length} file(s) written to ${out}`);
const rel = path.relative(process.cwd(), out) || ".";
console.log(`Ingest them with: npm run ingest -- --originals ${rel} --data ${path.join(path.dirname(rel), "sample-data")}`);
