import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { ensureOutputStageDirs_, spreadsheetTsvPathForCsv_ } from "./output-paths.mjs";

const ROOT_DIR = process.cwd();

main().catch((error) => {
  console.error("[fatal]", error?.message || String(error));
  process.exit(1);
});

async function main() {
  const inputArg = String(process.argv[2] || "").trim();
  const outputArg = String(process.argv[3] || "").trim();

  if (!inputArg) {
    throw new Error("Usage: node src/export-spreadsheet-tsv.mjs <input.csv> [output.tsv]");
  }

  const inputPath = path.resolve(ROOT_DIR, inputArg);
  if (!existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  await ensureOutputStageDirs_();

  const outputPath = outputArg
    ? path.resolve(ROOT_DIR, outputArg)
    : deriveOutputPath_(inputPath);

  const csvText = await fs.readFile(inputPath, "utf8");
  const rows = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    bom: true
  });

  const columns = Object.keys(rows[0] || {});
  if (columns.length === 0) {
    throw new Error(`No header columns found in: ${inputPath}`);
  }

  const tsvText = stringify(rows, {
    header: true,
    columns,
    delimiter: "\t"
  });

  await fs.writeFile(outputPath, tsvText, "utf8");

  console.log("[ok] spreadsheet tsv created");
  console.log(`input: ${inputPath}`);
  console.log(`rows: ${rows.length}`);
  console.log(`output: ${outputPath}`);
}

function deriveOutputPath_(inputPath) {
  return spreadsheetTsvPathForCsv_(inputPath);
}
