import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import {
  OUTPUT_JENKINS_WIDE_DIR,
  ahrefsBatchTargetsPath_,
  ahrefsBatchTop3LongPath_,
  ahrefsBatchTop3WidePath_,
  ensureOutputStageDirs_,
  resolveLatestFileInDir_,
  timestampToken_
} from "./output-paths.mjs";

const MAX_BATCH_TARGETS = Math.max(1, Number(process.env.MAX_BATCH_ANALYSIS_TARGETS || "200"));
const BATCH_TARGET_MODE = String(process.env.BATCH_ANALYSIS_TARGET_MODE || "domain").trim().toLowerCase();

main().catch((error) => {
  console.error("[fatal]", error?.message || String(error));
  process.exit(1);
});

async function main() {
  await ensureOutputStageDirs_();

  const inputArg = String(process.argv[2] || "").trim();
  const widePath = await resolveWidePath_(inputArg);
  if (!widePath || !existsSync(widePath)) {
    throw new Error(`rank_check_wide csv not found: ${inputArg || OUTPUT_JENKINS_WIDE_DIR}`);
  }

  const rows = await readCsv_(widePath);
  if (rows.length === 0) {
    throw new Error(`rank_check_wide csv is empty: ${widePath}`);
  }

  const stamp = timestampToken_();
  const top3WidePath = ahrefsBatchTop3WidePath_(stamp);
  const top3LongPath = ahrefsBatchTop3LongPath_(stamp);
  const targetsPath = ahrefsBatchTargetsPath_(stamp);

  const wideRows = [];
  const longRows = [];
  const uniqueTargets = [];
  const seenTargets = new Set();

  for (const row of rows) {
    const keyword = String(row.keyword || row["キーワード"] || "").trim();
    if (!keyword) continue;

    const url1 = String(row.rank1 || "").trim();
    const url2 = String(row.rank2 || "").trim();
    const url3 = String(row.rank3 || "").trim();

    wideRows.push({
      keyword,
      volume: String(row.volume || "").trim(),
      URL1: url1,
      URL2: url2,
      URL3: url3
    });

    [url1, url2, url3].forEach((url, index) => {
      if (!url) return;
      longRows.push({
        keyword,
        rank: index + 1,
        url
      });

      const normalizedTarget = toBatchTarget_(url);
      const key = normalizeTargetKey_(normalizedTarget);
      if (!key || seenTargets.has(key)) return;
      seenTargets.add(key);
      uniqueTargets.push(normalizedTarget);
    });
  }

  await fs.writeFile(
    top3WidePath,
    stringify(wideRows, {
      header: true,
      columns: ["keyword", "volume", "URL1", "URL2", "URL3"]
    }),
    "utf8"
  );
  await fs.writeFile(
    top3LongPath,
    stringify(longRows, {
      header: true,
      columns: ["keyword", "rank", "url"]
    }),
    "utf8"
  );
  await fs.writeFile(targetsPath, uniqueTargets.join("\n") + (uniqueTargets.length ? "\n" : ""), "utf8");
  const chunkPaths = [];
  const targetChunks = chunkArray_(uniqueTargets, MAX_BATCH_TARGETS);
  for (let i = 0; i < targetChunks.length; i += 1) {
    const chunkPath = chunkPathFor_(targetsPath, i + 1);
    await fs.writeFile(
      chunkPath,
      targetChunks[i].join("\n") + (targetChunks[i].length ? "\n" : ""),
      "utf8"
    );
    chunkPaths.push(chunkPath);
  }

  console.log("[ok] top3 batch-analysis inputs created");
  console.log(`input: ${widePath}`);
  console.log(`wide: ${top3WidePath}`);
  console.log(`long: ${top3LongPath}`);
  console.log(`targets: ${targetsPath}`);
  console.log(`target_mode: ${BATCH_TARGET_MODE}`);
  if (chunkPaths.length > 0) {
    console.log(`targets_chunks: ${chunkPaths.length}`);
    for (const chunkPath of chunkPaths) {
      console.log(`targets_chunk: ${chunkPath}`);
    }
  }
  console.log(`keywords: ${wideRows.length}`);
  console.log(`targets_unique: ${uniqueTargets.length}`);
}

async function resolveWidePath_(configuredPath) {
  if (configuredPath) {
    const p = path.resolve(configuredPath);
    if (!existsSync(p)) return "";
    return p;
  }

  return (
    (await resolveLatestFileInDir_(OUTPUT_JENKINS_WIDE_DIR, /^rank_check_wide_\d{8}_\d{6}\.csv$/i)) ||
    (await resolveLatestFileInDir_(OUTPUT_JENKINS_WIDE_DIR, /rank_check_wide.*\.csv$/i))
  );
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

function normalizeTargetKey_(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    const host = String(u.hostname || "").toLowerCase();
    let pathname = u.pathname || "/";
    if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
    const search = u.search || "";
    return `${host}${pathname}${search}`;
  } catch (_e) {
    return raw.replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
  }
}

function toBatchTarget_(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  if (BATCH_TARGET_MODE === "url" || BATCH_TARGET_MODE === "path") {
    return raw;
  }

  try {
    return new URL(raw).hostname.toLowerCase();
  } catch (_e) {
    return raw.replace(/^https?:\/\//i, "").split("/")[0].toLowerCase();
  }
}

function chunkArray_(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function chunkPathFor_(targetsPath, partNumber) {
  const parsed = path.parse(targetsPath);
  return path.join(parsed.dir, `${parsed.name}_part${String(partNumber).padStart(3, "0")}${parsed.ext}`);
}
