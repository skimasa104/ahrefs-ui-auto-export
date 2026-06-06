import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import {
  OUTPUT_AHREFS_KEYWORDS_MERGED_DIR,
  OUTPUT_JENKINS_RAW_DIR,
  OUTPUT_JENKINS_WIDE_DIR,
  resolveLatestFileInDir_,
  timestampToken_
} from "./output-paths.mjs";

export async function pivotRankCheckFile_({ inputPath, volumePath, outputPath } = {}) {
  const rankPath = await resolveRankCheckPath_(inputPath);
  if (!rankPath || !existsSync(rankPath)) {
    throw new Error(`rank_check csv not found: ${inputPath || OUTPUT_JENKINS_RAW_DIR}`);
  }

  const volumeCsvPath = await resolveVolumeCsvPath_(volumePath);
  const volumeByKeyword = volumeCsvPath ? await buildVolumeMap_(volumeCsvPath) : new Map();

  const rankRows = await readCsv_(rankPath);
  if (rankRows.length === 0) {
    throw new Error(`rank_check csv is empty: ${rankPath}`);
  }

  const keywordCol = findColumn_(Object.keys(rankRows[0] || {}), ["keyword", "キーワード"]);
  const rankCol = findColumn_(Object.keys(rankRows[0] || {}), ["rank", "順位", "position"]);
  const urlCol = findColumn_(Object.keys(rankRows[0] || {}), ["url", "link", "ページ"]);
  if (!keywordCol || !rankCol || !urlCol) {
    throw new Error(
      `required columns not found in rank_check. found=${Object.keys(rankRows[0] || {}).join(", ")}`
    );
  }

  const order = [];
  const byKeyword = new Map();

  for (const row of rankRows) {
    const keyword = String(row[keywordCol] || "").trim();
    if (!keyword) continue;
    const rank = Number(String(row[rankCol] || "").replace(/[^\d.-]/g, ""));
    if (!Number.isFinite(rank) || rank < 1 || rank > 10) continue;
    const idx = Math.floor(rank) - 1;
    const url = String(row[urlCol] || "").trim();

    const key = normalizeKey_(keyword);
    let item = byKeyword.get(key);
    if (!item) {
      item = {
        keyword,
        urls: Array(10).fill(""),
        volume: volumeByKeyword.has(key) ? volumeByKeyword.get(key) : ""
      };
      byKeyword.set(key, item);
      order.push(key);
    }
    if (!item.urls[idx] && url) {
      item.urls[idx] = url;
    }
  }

  const outRows = order.map((key) => {
    const item = byKeyword.get(key);
    return {
      keyword: item.keyword,
      volume: item.volume,
      rank1: item.urls[0],
      rank2: item.urls[1],
      rank3: item.urls[2],
      rank4: item.urls[3],
      rank5: item.urls[4],
      rank6: item.urls[5],
      rank7: item.urls[6],
      rank8: item.urls[7],
      rank9: item.urls[8],
      rank10: item.urls[9]
    };
  });

  const outPath = outputPath
    ? path.resolve(outputPath)
    : path.join(
        OUTPUT_JENKINS_WIDE_DIR,
        `${baseNameWithoutTimestamp_(rankPath)}_wide_${timestampToken_()}.csv`
      );

  const csv = stringify(outRows, {
    header: true,
    columns: [
      "keyword",
      "volume",
      "rank1",
      "rank2",
      "rank3",
      "rank4",
      "rank5",
      "rank6",
      "rank7",
      "rank8",
      "rank9",
      "rank10"
    ]
  });
  await fs.writeFile(outPath, csv, "utf8");
  return { input: rankPath, output: outPath, rows: outRows.length, volumeSource: volumeCsvPath || "" };
}

async function main() {
  const inputArg = process.argv[2] || "";
  const volumeArg = process.argv[3] || "";
  const result = await pivotRankCheckFile_({ inputPath: inputArg, volumePath: volumeArg });
  console.log(`[ok] pivot file created`);
  console.log(`input: ${result.input}`);
  if (result.volumeSource) console.log(`volume: ${result.volumeSource}`);
  console.log(`rows: ${result.rows}`);
  console.log(`output: ${result.output}`);
}

if (process.argv[1] && process.argv[1].endsWith("pivot-rank-check.mjs")) {
  main().catch((error) => {
    console.error("[fatal]", error?.message || String(error));
    process.exit(1);
  });
}

async function resolveRankCheckPath_(configuredPath) {
  if (configuredPath) {
    const p = path.resolve(configuredPath);
    if (!existsSync(p)) return "";
    const stat = await fs.stat(p);
    if (stat.isDirectory()) {
      const latestCanonical = await resolveLatestFileInDir_(p, /^rank_check_\d{8}_\d{6}\.csv$/i);
      if (latestCanonical) return latestCanonical;
      return await resolveLatestFileInDir_(p, /rank_check.*\.csv$/i);
    }
    return p;
  }

  const latestCanonical = await resolveLatestFileInDir_(
    OUTPUT_JENKINS_RAW_DIR,
    /^rank_check_\d{8}_\d{6}\.csv$/i
  );
  if (latestCanonical) return latestCanonical;
  return await resolveLatestFileInDir_(OUTPUT_JENKINS_RAW_DIR, /rank_check.*\.csv$/i);
}

async function resolveVolumeCsvPath_(configuredPath) {
  if (configuredPath) {
    const p = path.resolve(configuredPath);
    if (!existsSync(p)) return "";
    const stat = await fs.stat(p);
    if (stat.isDirectory()) {
      return (
        (await resolveLatestFileInDir_(p, /^organic_keywords_all_\d{8}_\d{6}\.csv$/i)) ||
        (await resolveLatestFileInDir_(p, /organic_keywords_all.*\.csv$/i))
      );
    }
    return p;
  }

  return (
    (await resolveLatestFileInDir_(OUTPUT_AHREFS_KEYWORDS_MERGED_DIR, /^organic_keywords_all_\d{8}_\d{6}\.csv$/i)) ||
    (await resolveLatestFileInDir_(OUTPUT_AHREFS_KEYWORDS_MERGED_DIR, /organic_keywords_all.*\.csv$/i))
  );
}

async function buildVolumeMap_(csvPath) {
  const rows = await readCsv_(csvPath);
  if (rows.length === 0) return new Map();
  const keywordCol = findColumn_(Object.keys(rows[0] || {}), ["keyword", "キーワード"]);
  const volumeCol = findColumn_(Object.keys(rows[0] || {}), ["volume", "search volume", "月間検索数"]);
  if (!keywordCol || !volumeCol) return new Map();

  const map = new Map();
  for (const row of rows) {
    const keyword = String(row[keywordCol] || "").trim();
    if (!keyword) continue;
    const key = normalizeKey_(keyword);
    const volumeRaw = String(row[volumeCol] || "").trim();
    const volumeNum = Number(volumeRaw.replace(/,/g, ""));
    if (!Number.isFinite(volumeNum)) continue;
    const prev = map.get(key);
    if (!Number.isFinite(prev) || volumeNum > prev) {
      map.set(key, volumeNum);
    }
  }
  return map;
}

async function readCsv_(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return parse(text, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    relax_quotes: true,
    relax_column_count: true
  });
}

function findColumn_(headers, candidates) {
  const normalized = headers.map((h) => ({ raw: h, key: normalizeKey_(h) }));
  for (const c of candidates) {
    const key = normalizeKey_(c);
    const found = normalized.find((h) => h.key === key);
    if (found) return found.raw;
  }
  return "";
}

function normalizeKey_(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function baseNameWithoutTimestamp_(filePath) {
  const parsed = path.parse(path.basename(filePath));
  return parsed.name.replace(/_\d{8}_\d{6}$/i, "");
}
