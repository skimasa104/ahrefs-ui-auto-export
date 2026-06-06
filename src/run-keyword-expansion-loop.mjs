import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { summarizeDomainsFromWide_ } from "./summarize-rank-domains.mjs";
import {
  OUTPUT_AHREFS_KEYWORDS_MERGED_DIR,
  OUTPUT_AHREFS_BATCH_FINAL_DIR,
  OUTPUT_AHREFS_BATCH_RAW_DIR,
  OUTPUT_AHREFS_BATCH_TOP3_DIR,
  OUTPUT_JENKINS_DOMAINS_DIR,
  OUTPUT_JENKINS_WIDE_DIR,
  OUTPUT_KEYWORD_EXPANSION_SELECTIONS_DIR,
  keywordExpansionKeywordsPath_,
  keywordExpansionSelectionPath_,
  keywordExpansionTargetsPath_,
  ensureOutputStageDirs_,
  resolveLatestFileInDir_,
  timestampToken_
} from "./output-paths.mjs";

const ROOT_DIR = process.cwd();
const TOP_N = Math.max(1, Number(process.env.EXPANSION_TOP_N || "5"));
const COUNTRY = String(process.env.EXPANSION_COUNTRY || "jp").trim().toLowerCase() || "jp";
const RERUN_MAX_KEYWORDS = Math.max(1, Number(process.env.EXPANSION_RERUN_MAX_KEYWORDS || "2000"));
const MIN_RERUN_VOLUME = Math.max(0, Number(process.env.EXPANSION_MIN_VOLUME || "101"));
const DRY_RUN = process.env.EXPANSION_DRY_RUN === "1";
const SHEET_URL = String(process.env.GOOGLE_SHEET_URL || "").trim();
const SHEET_TAB_PREFIX = String(process.env.EXPANSION_SHEET_TAB_PREFIX || "diet_expand").trim() || "diet_expand";

main().catch((error) => {
  console.error("[fatal]", error?.message || String(error));
  process.exit(1);
});

async function main() {
  await ensureOutputStageDirs_();

  const wideArg = String(process.argv[2] || "").trim();
  const widePath = await resolveWidePath_(wideArg);
  if (!widePath || !existsSync(widePath)) {
    throw new Error(`rank_check_wide csv not found: ${wideArg || OUTPUT_JENKINS_WIDE_DIR}`);
  }

  const seedKeywords = await readSeedKeywordsFromWide_(widePath);
  if (seedKeywords.length === 0) {
    throw new Error(`No keywords found in wide csv: ${widePath}`);
  }

  const summary = await summarizeDomainsFromWide_({ inputPath: widePath });
  const clusterRows = await readCsv_(summary.clusterOutput);
  const selectedClusters = selectTopClusters_(clusterRows, TOP_N);
  if (selectedClusters.length === 0) {
    throw new Error(`No media clusters found: ${summary.clusterOutput}`);
  }

  const stamp = timestampToken_();
  const selectedPath = keywordExpansionSelectionPath_(stamp);
  await writeCsv_(
    selectedPath,
    selectedClusters,
    ["target", "count", "host", "grouping", "first_directory"]
  );

  const targetsRows = selectedClusters.map((row) => toAhrefsTargetRow_(row, COUNTRY));
  const targetsPath = keywordExpansionTargetsPath_(stamp);
  await writeCsv_(
    targetsPath,
    targetsRows,
    [
      "target",
      "mode",
      "country",
      "source_cluster",
      "source_count",
      "source_host",
      "source_grouping",
      "source_first_directory"
    ]
  );

  console.log("[ok] keyword expansion targets prepared");
  console.log(`wide: ${widePath}`);
  console.log(`seed_keywords: ${seedKeywords.length}`);
  console.log(`selected_clusters: ${selectedPath}`);
  console.log(`ahrefs_targets: ${targetsPath}`);

  if (DRY_RUN) {
    console.log("[skip] EXPANSION_DRY_RUN=1 so Ahrefs export and Jenkins rerun were not executed.");
    return;
  }

  const ahrefsStartedAt = Date.now();
  await runNodeScript_("src/ahrefs-export.mjs", ["export"], {
    ...process.env,
    TARGETS_FILE: targetsPath
  });

  const uniqueCsvPath = await resolveLatestCreatedAfter_(
    OUTPUT_AHREFS_KEYWORDS_MERGED_DIR,
    /^organic_keywords_unique_\d{8}_\d{6}\.csv$/i,
    ahrefsStartedAt
  );
  if (!uniqueCsvPath) {
    throw new Error("Expanded unique keywords csv not found after Ahrefs export.");
  }

  const expandedRows = await readCsv_(uniqueCsvPath);
  const rerunKeywords = mergeSeedAndExpandedKeywords_(seedKeywords, expandedRows);
  const rerunKeywordsPath = keywordExpansionKeywordsPath_(stamp);
  await fs.writeFile(
    rerunKeywordsPath,
    rerunKeywords.map((row) => row.keyword).join("\n") + "\n",
    "utf8"
  );

  console.log("[ok] rerun keyword list created");
  console.log(`expanded_unique: ${uniqueCsvPath}`);
  console.log(`rerun_keywords: ${rerunKeywordsPath}`);
  console.log(`rerun_keyword_count: ${rerunKeywords.length}`);

  const jenkinsStartedAt = Date.now();
  await runNodeScript_("src/run-jenkins-rankchecker.mjs", [], {
    ...process.env,
    JENKINS_KEYWORDS_FILE: rerunKeywordsPath
  });

  const rerunWidePath = await resolveLatestCreatedAfter_(
    OUTPUT_JENKINS_WIDE_DIR,
    /^rank_check_wide_\d{8}_\d{6}\.csv$/i,
    jenkinsStartedAt
  );
  if (!rerunWidePath) {
    throw new Error("Rerun rank_check_wide csv not found after Jenkins rerun.");
  }

  const rerunMediaClustersPath = await resolveLatestCreatedAfter_(
    OUTPUT_JENKINS_DOMAINS_DIR,
    /^rank_check_wide_media_clusters_\d{8}_\d{6}\.csv$/i,
    jenkinsStartedAt
  );

  const top3StartedAt = Date.now();
  await runNodeScript_("src/prepare-top3-batch-analysis.mjs", [rerunWidePath], process.env);
  const rerunTop3WidePath = await resolveLatestCreatedAfter_(
    OUTPUT_AHREFS_BATCH_TOP3_DIR,
    /^rank_check_top3_wide_\d{8}_\d{6}\.csv$/i,
    top3StartedAt
  );
  const rerunBatchTargetsPath = await resolveLatestCreatedAfter_(
    OUTPUT_AHREFS_BATCH_TOP3_DIR,
    /^batch_targets_\d{8}_\d{6}\.txt$/i,
    top3StartedAt
  );
  if (!rerunTop3WidePath || !rerunBatchTargetsPath) {
    throw new Error("Top3 or Batch Analysis targets were not created after rankcheck:top3.");
  }

  const batchStartedAt = Date.now();
  await runNodeScript_("src/run-ahrefs-batch-analysis.mjs", [rerunBatchTargetsPath], process.env);
  const rerunBatchRawPath = await resolveLatestCreatedAfter_(
    OUTPUT_AHREFS_BATCH_RAW_DIR,
    /^batch_analysis_\d{8}_\d{6}(?:_part\d{3})?\.csv$/i,
    batchStartedAt
  );
  if (!rerunBatchRawPath) {
    throw new Error("Batch Analysis raw csv was not created.");
  }

  const mergeStartedAt = Date.now();
  await runNodeScript_("src/merge-top3-dr.mjs", [rerunTop3WidePath, rerunBatchRawPath], process.env);
  const rerunFinalDrPath = await resolveLatestCreatedAfter_(
    OUTPUT_AHREFS_BATCH_FINAL_DIR,
    /^rank_check_top3_dr_\d{8}_\d{6}\.csv$/i,
    mergeStartedAt
  );
  if (!rerunFinalDrPath) {
    throw new Error("Final rank_check_top3_dr csv was not created.");
  }

  const tabStamp = timestampToken_();
  const sheetTabName = `${SHEET_TAB_PREFIX}_${tabStamp}`;
  const sheetEnv = {
    ...process.env,
    GOOGLE_SHEET_TAB_NAME: sheetTabName
  };
  sheetEnv.GOOGLE_SHEET_URL = SHEET_URL || process.env.GOOGLE_SHEET_URL || "";
  await runNodeScript_(
    "src/paste-top3-dr-to-google-sheet.mjs",
    [sheetEnv.GOOGLE_SHEET_URL, rerunFinalDrPath],
    sheetEnv
  );

  console.log("[ok] keyword expansion loop finished");
  console.log(`rerun_wide: ${rerunWidePath}`);
  if (rerunMediaClustersPath) {
    console.log(`rerun_media_clusters: ${rerunMediaClustersPath}`);
  }
  console.log(`rerun_top3_wide: ${rerunTop3WidePath}`);
  console.log(`rerun_batch_targets: ${rerunBatchTargetsPath}`);
  console.log(`rerun_batch_raw: ${rerunBatchRawPath}`);
  console.log(`rerun_top3_dr: ${rerunFinalDrPath}`);
  console.log(`sheet_tab: ${sheetTabName}`);
}

async function resolveWidePath_(configuredPath) {
  if (configuredPath) {
    return path.resolve(ROOT_DIR, configuredPath);
  }
  return (
    (await resolveLatestFileInDir_(OUTPUT_JENKINS_WIDE_DIR, /^rank_check_wide_\d{8}_\d{6}\.csv$/i)) ||
    (await resolveLatestFileInDir_(OUTPUT_JENKINS_WIDE_DIR, /rank_check_wide.*\.csv$/i))
  );
}

async function readSeedKeywordsFromWide_(widePath) {
  const rows = await readCsv_(widePath);
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const keyword = String(row.keyword || row["キーワード"] || "").trim();
    const volume = String(row.volume || row["検索ボリューム"] || "").trim();
    if (!keyword) continue;
    const key = normalizeKey_(keyword);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ keyword, volume });
  }
  return out;
}

function selectTopClusters_(clusterRows, topN) {
  return clusterRows
    .map((row) => ({
      target: String(row.target || "").trim(),
      count: String(row.count || "").trim(),
      host: String(row.host || "").trim().toLowerCase(),
      grouping: String(row.grouping || "").trim() || "host",
      first_directory: String(row.first_directory || "").trim()
    }))
    .filter((row) => row.target && row.host)
    .slice(0, topN);
}

function toAhrefsTargetRow_(row, country) {
  const host = String(row.host || "").trim().toLowerCase();
  const firstDirectory = String(row.first_directory || "").trim();
  const grouping = String(row.grouping || "").trim();
  const isPathCluster = grouping === "host_first_directory" && firstDirectory;
  const target = isPathCluster ? `https://${host}/${firstDirectory}/` : host;
  return {
    target,
    mode: isPathCluster ? "prefix" : "domain",
    country,
    source_cluster: row.target,
    source_count: row.count,
    source_host: host,
    source_grouping: grouping || "host",
    source_first_directory: firstDirectory
  };
}

function mergeSeedAndExpandedKeywords_(seedKeywords, expandedRows) {
  const merged = [];
  const seen = new Set();

  for (const row of seedKeywords) {
    const keyword = String(row.keyword || "").trim();
    const volume = String(row.volume || "").trim();
    const key = normalizeKey_(keyword);
    if (!key || seen.has(key)) continue;
    if (volume && volumeValue_(volume) < MIN_RERUN_VOLUME) continue;
    seen.add(key);
    merged.push({ keyword, volume });
  }

  const sortedExpanded = [...expandedRows].sort(
    (a, b) => volumeValue_(b.volume) - volumeValue_(a.volume)
  );
  for (const row of sortedExpanded) {
    const keyword = String(row.keyword || "").trim();
    const volume = String(row.volume || "").trim();
    const key = normalizeKey_(keyword);
    if (!key || seen.has(key)) continue;
    if (volumeValue_(volume) < MIN_RERUN_VOLUME) continue;
    seen.add(key);
    merged.push({ keyword, volume });
    if (merged.length >= RERUN_MAX_KEYWORDS) break;
  }

  return merged.slice(0, RERUN_MAX_KEYWORDS);
}

async function resolveLatestCreatedAfter_(dirPath, regex, startedAtMs) {
  if (!existsSync(dirPath)) return "";
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (regex && !regex.test(entry.name)) continue;
    const filePath = path.join(dirPath, entry.name);
    const stat = await fs.stat(filePath);
    if (stat.mtimeMs >= startedAtMs) {
      candidates.push({ filePath, mtimeMs: stat.mtimeMs });
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.filePath || "";
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

async function writeCsv_(filePath, rows, columns) {
  const text = stringify(rows, { header: true, columns });
  await fs.writeFile(filePath, text, "utf8");
}

function normalizeKey_(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function volumeValue_(value) {
  const n = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}

async function runNodeScript_(relativeScriptPath, args, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [relativeScriptPath, ...args], {
      cwd: ROOT_DIR,
      env,
      stdio: "inherit"
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(relativeScriptPath)} exited with code ${code}`));
    });
  });
}
