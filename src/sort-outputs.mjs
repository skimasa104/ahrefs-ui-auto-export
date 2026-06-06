import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import {
  OUTPUT_AHREFS_KEYWORDS_MERGED_DIR,
  OUTPUT_AHREFS_KEYWORDS_PER_TARGET_DIR,
  organicAllCsvPath_,
  organicUniqueCsvPath_,
  keywordsTxtPath_,
  resolveLatestFileInDir_,
  timestampToken_
} from "./output-paths.mjs";

const MIN_VOLUME_ALL = Number(process.env.MIN_VOLUME_ALL || "100");

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});

async function main() {
  const perTargetFiles = await listPerTargetCsvFiles_();
  let sortedPerTargetCount = 0;
  for (const filePath of perTargetFiles) {
    const rows = await readCsvSafe_(filePath);
    if (!rows) continue;
    rows.sort((a, b) => volumeValue_(b.volume) - volumeValue_(a.volume));
    await writeCsv_(filePath, rows, ["keyword", "volume"]);
    sortedPerTargetCount += 1;
  }

  const latestAllPath = await resolveLatestFileInDir_(
    OUTPUT_AHREFS_KEYWORDS_MERGED_DIR,
    /^organic_keywords_all_\d{8}_\d{6}\.csv$/i
  );
  if (!latestAllPath) {
    console.log("organic_keywords_all_*.csv not found, skipped");
    return;
  }

  const allRows = await readCsvSafe_(latestAllPath);
  if (!allRows) {
    console.log("organic_keywords_all latest file could not be read, skipped");
    return;
  }
  allRows.sort((a, b) => volumeValue_(b.volume) - volumeValue_(a.volume));
  const filteredAllRows = allRows.filter((r) => volumeValue_(r.volume) > MIN_VOLUME_ALL);

  const stamp = timestampToken_();
  const allOutPath = organicAllCsvPath_(stamp);
  await writeCsv_(allOutPath, filteredAllRows, ["domain", "keyword", "volume"]);

  const uniqueRows = mergeRowsByKeyword_(filteredAllRows);
  const uniqueOutPath = organicUniqueCsvPath_(stamp);
  await writeCsv_(uniqueOutPath, uniqueRows, ["keyword", "volume", "targets", "target_count"]);

  const keywordsTxtPath = keywordsTxtPath_(stamp);
  const keywordsTxt = filteredAllRows.map((r) => String(r.keyword || "").trim()).filter(Boolean).join("\n");
  await fs.writeFile(keywordsTxtPath, keywordsTxt ? `${keywordsTxt}\n` : "", "utf8");

  console.log(
    `sorted per_target_files=${sortedPerTargetCount} all=${filteredAllRows.length} unique=${uniqueRows.length}`
  );
  console.log(`output all=${allOutPath}`);
  console.log(`output unique=${uniqueOutPath}`);
  console.log(`output txt=${keywordsTxtPath}`);
}

async function listPerTargetCsvFiles_() {
  if (!existsSync(OUTPUT_AHREFS_KEYWORDS_PER_TARGET_DIR)) return [];
  const entries = await fs.readdir(OUTPUT_AHREFS_KEYWORDS_PER_TARGET_DIR, {
    withFileTypes: true
  });
  return entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => name.endsWith(".csv"))
    .filter((name) => !/^organic_keywords_(all|unique)_\d{8}_\d{6}\.csv$/i.test(name))
    .map((name) => path.join(OUTPUT_AHREFS_KEYWORDS_PER_TARGET_DIR, name));
}

async function readCsvSafe_(filePath) {
  if (!existsSync(filePath)) return null;
  const text = await fs.readFile(filePath, "utf8");
  return parse(text, { columns: true, skip_empty_lines: true, bom: true });
}

async function writeCsv_(filePath, rows, columns) {
  const text = stringify(rows, { header: true, columns });
  await fs.writeFile(filePath, text, "utf8");
}

function volumeValue_(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const n = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function normalizeKey_(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function mergeRowsByKeyword_(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = normalizeKey_(row.keyword);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        keyword: row.keyword,
        volume: row.volume,
        targets: new Set([row.domain]),
        target_count: 1
      });
      continue;
    }

    if (volumeValue_(row.volume) > volumeValue_(existing.volume)) {
      existing.volume = row.volume;
      existing.keyword = row.keyword;
    }
    existing.targets.add(row.domain);
    existing.target_count = existing.targets.size;
  }

  return Array.from(map.values())
    .map((item) => ({
      keyword: item.keyword,
      volume: item.volume,
      targets: Array.from(item.targets).join(" | "),
      target_count: item.target_count
    }))
    .sort((a, b) => volumeValue_(b.volume) - volumeValue_(a.volume));
}
