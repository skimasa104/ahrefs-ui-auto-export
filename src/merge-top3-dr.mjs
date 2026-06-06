import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import iconv from "iconv-lite";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import {
  OUTPUT_AHREFS_KEYWORDS_MERGED_DIR,
  OUTPUT_AHREFS_BATCH_FINAL_DIR,
  OUTPUT_AHREFS_BATCH_RAW_DIR,
  OUTPUT_AHREFS_BATCH_TOP3_DIR,
  ahrefsBatchFinalPath_,
  ensureOutputStageDirs_,
  resolveLatestFileInDir_,
  timestampToken_
} from "./output-paths.mjs";

main().catch((error) => {
  console.error("[fatal]", error?.message || String(error));
  process.exit(1);
});

async function main() {
  await ensureOutputStageDirs_();

  const top3Arg = String(process.argv[2] || "").trim();
  const batchArg = String(process.argv[3] || "").trim();

  const top3Path = await resolveTop3Path_(top3Arg);
  const batchPaths = await resolveBatchPaths_(batchArg);

  if (!top3Path || !existsSync(top3Path)) {
    throw new Error(`Top3 wide file not found: ${top3Arg || OUTPUT_AHREFS_BATCH_TOP3_DIR}`);
  }
  if (batchPaths.length === 0) {
    throw new Error(`Batch Analysis csv not found: ${batchArg || OUTPUT_AHREFS_BATCH_RAW_DIR}`);
  }

  const top3Rows = await readCsvUtf8_(top3Path);
  const batchRows = [];
  for (const batchPath of batchPaths) {
    batchRows.push(...(await readCsvAuto_(batchPath)));
  }
  if (top3Rows.length === 0) {
    throw new Error(`Top3 wide csv is empty: ${top3Path}`);
  }
  if (batchRows.length === 0) {
    throw new Error(`Batch Analysis csv is empty: ${batchPath}`);
  }

  const targetCol = findColumn_(Object.keys(batchRows[0] || {}), [
    "target",
    "url",
    "page",
    "address"
  ]);
  const drCol = findColumn_(Object.keys(batchRows[0] || {}), ["dr", "domain rating"]);
  if (!targetCol || !drCol) {
    throw new Error(
      `Batch Analysis required columns not found. found=${Object.keys(batchRows[0] || {}).join(", ")}`
    );
  }

  const drByTarget = new Map();
  const drByHost = new Map();
  for (const row of batchRows) {
    const target = String(row[targetCol] || "").trim();
    const key = normalizeTargetKey_(target);
    if (!key) continue;
    const drValue = parseNumericValue_(row[drCol]);
    if (!drByTarget.has(key) || drValue > parseNumericValue_(drByTarget.get(key))) {
      drByTarget.set(key, drValue);
    }
    const hostKey = normalizeHostKey_(target);
    if (hostKey && (!drByHost.has(hostKey) || drValue > parseNumericValue_(drByHost.get(hostKey)))) {
      drByHost.set(hostKey, drValue);
    }
  }

  const volumeByKeyword = await buildVolumeLookup_(top3Rows);

  const finalRows = top3Rows.map((row) => {
    const keyword = String(row.keyword || "").trim();
    const url1 = String(row.URL1 || row.url1 || "").trim();
    const url2 = String(row.URL2 || row.url2 || "").trim();
    const url3 = String(row.URL3 || row.url3 || "").trim();
    const top3Volume = normalizeVolumeValue_(row.volume);
    const resolvedVolume = top3Volume || volumeByKeyword.get(normalizeKeyword_(keyword)) || "";
    return {
      keyword,
      volume: resolvedVolume,
      DR1: lookupDr_(drByTarget, drByHost, url1),
      DR2: lookupDr_(drByTarget, drByHost, url2),
      DR3: lookupDr_(drByTarget, drByHost, url3),
      URL1: url1,
      URL2: url2,
      URL3: url3
    };
  });
  finalRows.sort((a, b) => volumeSortValue_(b.volume) - volumeSortValue_(a.volume));

  const outPath = ahrefsBatchFinalPath_(timestampToken_());
  await fs.writeFile(
    outPath,
    stringify(finalRows, {
      header: true,
      columns: ["keyword", "volume", "DR1", "DR2", "DR3", "URL1", "URL2", "URL3"]
    }),
    "utf8"
  );

  console.log("[ok] top3 DR csv created");
  console.log(`top3: ${top3Path}`);
  console.log(`batch_files: ${batchPaths.length}`);
  for (const batchPath of batchPaths) {
    console.log(`batch: ${batchPath}`);
  }
  console.log(`rows: ${finalRows.length}`);
  console.log(`output: ${outPath}`);
}

async function resolveTop3Path_(configuredPath) {
  if (configuredPath) {
    return path.resolve(configuredPath);
  }
  return (
    (await resolveLatestFileInDir_(OUTPUT_AHREFS_BATCH_TOP3_DIR, /^rank_check_top3_wide_\d{8}_\d{6}\.csv$/i)) ||
    (await resolveLatestFileInDir_(OUTPUT_AHREFS_BATCH_TOP3_DIR, /rank_check_top3_wide.*\.csv$/i))
  );
}

async function resolveBatchPaths_(configuredPath) {
  if (configuredPath) {
    return resolveBatchPathSet_(path.resolve(configuredPath));
  }
  const latestPart = await resolveLatestFileInDir_(
    OUTPUT_AHREFS_BATCH_RAW_DIR,
    /^batch_analysis_\d{8}_\d{6}_part\d{3}\.csv$/i
  );
  if (latestPart) {
    return resolveBatchPathSet_(latestPart);
  }
  const latestSingle =
    (await resolveLatestFileInDir_(OUTPUT_AHREFS_BATCH_RAW_DIR, /^batch_analysis_\d{8}_\d{6}\.csv$/i)) ||
    (await resolveLatestFileInDir_(OUTPUT_AHREFS_BATCH_RAW_DIR, /batch_analysis.*\.csv$/i));
  return latestSingle ? [latestSingle] : [];
}

async function resolveBatchPathSet_(filePath) {
  if (!existsSync(filePath)) return [];
  const stat = await fs.stat(filePath);
  if (stat.isDirectory()) {
    const latestPart = await resolveLatestFileInDir_(
      filePath,
      /^batch_analysis_\d{8}_\d{6}_part\d{3}\.csv$/i
    );
    if (latestPart) return resolveBatchPathSet_(latestPart);
    const latestSingle =
      (await resolveLatestFileInDir_(filePath, /^batch_analysis_\d{8}_\d{6}\.csv$/i)) ||
      (await resolveLatestFileInDir_(filePath, /batch_analysis.*\.csv$/i));
    return latestSingle ? [latestSingle] : [];
  }

  const parsed = path.parse(filePath);
  const seriesMatch = parsed.name.match(/^(batch_analysis_\d{8}_\d{6})(?:_part\d{3})?$/i);
  if (!seriesMatch) return [filePath];

  const prefix = seriesMatch[1];
  const entries = await fs.readdir(parsed.dir, { withFileTypes: true });
  const partFiles = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => new RegExp(`^${prefix}_part\\d{3}\\.csv$`, "i").test(name))
    .sort();
  if (partFiles.length > 0) {
    return partFiles.map((name) => path.join(parsed.dir, name));
  }
  return [filePath];
}

async function readCsvUtf8_(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return parseCsvText_(text);
}

async function readCsvAuto_(filePath) {
  const buffer = await fs.readFile(filePath);
  const isUtf16Le =
    (buffer[0] === 0xff && buffer[1] === 0xfe) ||
    (buffer.length > 4 && buffer[1] === 0 && buffer[3] === 0);
  const text = isUtf16Le ? iconv.decode(buffer, "utf16-le") : buffer.toString("utf8");
  return parseCsvText_(text);
}

function parseCsvText_(text) {
  return parse(text, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    delimiter: [",", "\t"],
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

function lookupDr_(exactMap, hostMap, url) {
  const key = normalizeTargetKey_(url);
  if (key) {
    const exactValue = exactMap.get(key);
    if (exactValue !== undefined && exactValue !== null) {
      return exactValue;
    }
  }

  const hostKey = normalizeHostKey_(url);
  if (!hostKey) return "";
  const hostValue = hostMap.get(hostKey);
  return hostValue === undefined || hostValue === null ? "" : hostValue;
}

function normalizeTargetKey_(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const input = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const u = new URL(input);
    const host = String(u.hostname || "").toLowerCase();
    let pathname = u.pathname || "/";
    if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
    const search = u.search || "";
    return `${host}${pathname}${search}`;
  } catch (_e) {
    return raw.replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
  }
}

function normalizeHostKey_(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const input = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return String(new URL(input).hostname || "").toLowerCase();
  } catch (_e) {
    return raw.replace(/^https?:\/\//i, "").split("/")[0].toLowerCase();
  }
}

function normalizeKey_(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeKeyword_(value) {
  return normalizeKey_(value);
}

function parseNumericValue_(value) {
  const raw = String(value ?? "").replace(/,/g, "").trim();
  const n = Number(raw);
  return Number.isFinite(n) ? n : raw;
}

async function buildVolumeLookup_(top3Rows) {
  const candidates = await resolveVolumeCandidatePaths_();
  if (candidates.length === 0) return new Map();

  const wantedKeywords = new Set(
    top3Rows.map((row) => normalizeKeyword_(row.keyword || "")).filter(Boolean)
  );
  let bestMap = new Map();
  let bestHits = 0;

  for (const candidatePath of candidates) {
    const rows = await readCsvUtf8_(candidatePath).catch(() => []);
    if (rows.length === 0) continue;

    const keywordCol = findColumn_(Object.keys(rows[0] || {}), ["keyword", "keywords"]);
    const volumeCol = findColumn_(Object.keys(rows[0] || {}), ["volume", "monthly volume", "search volume"]);
    if (!keywordCol || !volumeCol) continue;

    const map = new Map();
    let hits = 0;
    for (const row of rows) {
      const keyword = normalizeKeyword_(row[keywordCol]);
      const volume = normalizeVolumeValue_(row[volumeCol]);
      if (!keyword || !volume) continue;
      if (!map.has(keyword) || volumeSortValue_(volume) > volumeSortValue_(map.get(keyword))) {
        map.set(keyword, volume);
      }
      if (wantedKeywords.has(keyword)) hits += 1;
    }

    if (hits > bestHits) {
      bestHits = hits;
      bestMap = map;
    }
  }

  return bestMap;
}

async function resolveVolumeCandidatePaths_() {
  if (!existsSync(OUTPUT_AHREFS_KEYWORDS_MERGED_DIR)) return [];
  const entries = await fs.readdir(OUTPUT_AHREFS_KEYWORDS_MERGED_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".csv"))
    .map((entry) => path.join(OUTPUT_AHREFS_KEYWORDS_MERGED_DIR, entry.name));
}

function normalizeVolumeValue_(value) {
  const raw = String(value ?? "").replace(/,/g, "").trim();
  if (!raw) return "";
  const n = Number(raw);
  return Number.isFinite(n) ? String(n) : raw;
}

function volumeSortValue_(value) {
  const n = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : -1;
}
