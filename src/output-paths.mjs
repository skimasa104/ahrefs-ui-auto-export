import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

export const ROOT_DIR = process.cwd();
export const OUTPUT_ROOT_DIR = path.join(ROOT_DIR, "output");
export const OUTPUT_AHREFS_RAW_DIR = path.join(OUTPUT_ROOT_DIR, "01_ahrefs_raw_csv");
export const OUTPUT_AHREFS_KEYWORDS_DIR = path.join(OUTPUT_ROOT_DIR, "02_keyword_research");
export const OUTPUT_AHREFS_KEYWORDS_PER_TARGET_DIR = path.join(
  OUTPUT_AHREFS_KEYWORDS_DIR,
  "per_target_csv"
);
export const OUTPUT_AHREFS_KEYWORDS_MERGED_DIR = path.join(
  OUTPUT_AHREFS_KEYWORDS_DIR,
  "merged_csv"
);
export const OUTPUT_AHREFS_KEYWORDS_SPREADSHEET_DIR = path.join(
  OUTPUT_AHREFS_KEYWORDS_DIR,
  "spreadsheet_tsv"
);
export const OUTPUT_AHREFS_KEYWORDS_TXT_DIR = path.join(
  OUTPUT_AHREFS_KEYWORDS_DIR,
  "keyword_lists_txt"
);
export const OUTPUT_JENKINS_DIR = path.join(OUTPUT_ROOT_DIR, "03_jenkins_rankchecker");
export const OUTPUT_JENKINS_RAW_DIR = path.join(OUTPUT_JENKINS_DIR, "raw_csv");
export const OUTPUT_JENKINS_WIDE_DIR = path.join(OUTPUT_JENKINS_DIR, "wide_csv");
export const OUTPUT_JENKINS_DOMAINS_DIR = path.join(OUTPUT_JENKINS_DIR, "domain_summary");
export const OUTPUT_AHREFS_BATCH_DIR = path.join(OUTPUT_ROOT_DIR, "04_ahrefs_batch_analysis");
export const OUTPUT_AHREFS_BATCH_TOP3_DIR = path.join(OUTPUT_AHREFS_BATCH_DIR, "top3_inputs");
export const OUTPUT_AHREFS_BATCH_RAW_DIR = path.join(OUTPUT_AHREFS_BATCH_DIR, "raw_csv");
export const OUTPUT_AHREFS_BATCH_FINAL_DIR = path.join(OUTPUT_AHREFS_BATCH_DIR, "final_csv");
export const OUTPUT_KEYWORD_EXPANSION_DIR = path.join(OUTPUT_ROOT_DIR, "05_keyword_expansion");
export const OUTPUT_KEYWORD_EXPANSION_TARGETS_DIR = path.join(
  OUTPUT_KEYWORD_EXPANSION_DIR,
  "ahrefs_targets"
);
export const OUTPUT_KEYWORD_EXPANSION_SELECTIONS_DIR = path.join(
  OUTPUT_KEYWORD_EXPANSION_DIR,
  "selected_clusters"
);
export const OUTPUT_KEYWORD_EXPANSION_KEYWORDS_DIR = path.join(
  OUTPUT_KEYWORD_EXPANSION_DIR,
  "rerun_keywords_txt"
);

export function timestampToken_(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}_${hh}${mi}${ss}`;
}

export function withTimestampedName_(baseName, stamp) {
  const parsed = path.parse(baseName);
  return `${parsed.name}_${stamp}${parsed.ext}`;
}

export function perTargetCsvPath_(slug, stamp) {
  return path.join(OUTPUT_AHREFS_KEYWORDS_PER_TARGET_DIR, `${slug}_${stamp}.csv`);
}

export function organicAllCsvPath_(stamp) {
  return path.join(
    OUTPUT_AHREFS_KEYWORDS_MERGED_DIR,
    withTimestampedName_("organic_keywords_all.csv", stamp)
  );
}

export function organicUniqueCsvPath_(stamp) {
  return path.join(
    OUTPUT_AHREFS_KEYWORDS_MERGED_DIR,
    withTimestampedName_("organic_keywords_unique.csv", stamp)
  );
}

export function keywordsTxtPath_(stamp) {
  return path.join(
    OUTPUT_AHREFS_KEYWORDS_TXT_DIR,
    withTimestampedName_("organic_keywords_all_keywords.txt", stamp)
  );
}

export function spreadsheetTsvPathForCsv_(inputCsvPath) {
  const parsed = path.parse(path.basename(inputCsvPath));
  return path.join(OUTPUT_AHREFS_KEYWORDS_SPREADSHEET_DIR, `${parsed.name}_spreadsheet.tsv`);
}

export function jenkinsLatestArtifactPath_(artifactName, stamp) {
  return path.join(OUTPUT_JENKINS_RAW_DIR, withTimestampedName_(artifactName, stamp));
}

export function jenkinsVersionedArtifactPath_(buildNo, artifactName, stamp) {
  const parsed = path.parse(artifactName);
  return path.join(
    OUTPUT_JENKINS_RAW_DIR,
    `build_${buildNo}_${parsed.name}_${stamp}${parsed.ext}`
  );
}

export function ahrefsBatchTop3WidePath_(stamp) {
  return path.join(OUTPUT_AHREFS_BATCH_TOP3_DIR, withTimestampedName_("rank_check_top3_wide.csv", stamp));
}

export function ahrefsBatchTop3LongPath_(stamp) {
  return path.join(OUTPUT_AHREFS_BATCH_TOP3_DIR, withTimestampedName_("rank_check_top3_long.csv", stamp));
}

export function ahrefsBatchTargetsPath_(stamp) {
  return path.join(OUTPUT_AHREFS_BATCH_TOP3_DIR, withTimestampedName_("batch_targets.txt", stamp));
}

export function ahrefsBatchRawPath_(stamp) {
  return path.join(OUTPUT_AHREFS_BATCH_RAW_DIR, withTimestampedName_("batch_analysis.csv", stamp));
}

export function ahrefsBatchFinalPath_(stamp) {
  return path.join(OUTPUT_AHREFS_BATCH_FINAL_DIR, withTimestampedName_("rank_check_top3_dr.csv", stamp));
}

export function keywordExpansionTargetsPath_(stamp) {
  return path.join(
    OUTPUT_KEYWORD_EXPANSION_TARGETS_DIR,
    withTimestampedName_("keyword_expansion_targets.csv", stamp)
  );
}

export function keywordExpansionSelectionPath_(stamp) {
  return path.join(
    OUTPUT_KEYWORD_EXPANSION_SELECTIONS_DIR,
    withTimestampedName_("keyword_expansion_selected_clusters.csv", stamp)
  );
}

export function keywordExpansionKeywordsPath_(stamp) {
  return path.join(
    OUTPUT_KEYWORD_EXPANSION_KEYWORDS_DIR,
    withTimestampedName_("keyword_expansion_rerun_keywords.txt", stamp)
  );
}

export async function resolveLatestFileInDir_(dirPath, regex) {
  if (!existsSync(dirPath)) return "";
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => (regex ? regex.test(name) : true));
  if (files.length === 0) return "";

  const withStats = await Promise.all(
    files.map(async (name) => {
      const filePath = path.join(dirPath, name);
      const stat = await fs.stat(filePath);
      return { filePath, mtimeMs: stat.mtimeMs };
    })
  );
  withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withStats[0].filePath;
}

export async function ensureOutputStageDirs_() {
  await fs.mkdir(OUTPUT_ROOT_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_AHREFS_RAW_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_AHREFS_KEYWORDS_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_AHREFS_KEYWORDS_PER_TARGET_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_AHREFS_KEYWORDS_MERGED_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_AHREFS_KEYWORDS_SPREADSHEET_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_AHREFS_KEYWORDS_TXT_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_JENKINS_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_JENKINS_RAW_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_JENKINS_WIDE_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_JENKINS_DOMAINS_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_AHREFS_BATCH_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_AHREFS_BATCH_TOP3_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_AHREFS_BATCH_RAW_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_AHREFS_BATCH_FINAL_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_KEYWORD_EXPANSION_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_KEYWORD_EXPANSION_TARGETS_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_KEYWORD_EXPANSION_SELECTIONS_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_KEYWORD_EXPANSION_KEYWORDS_DIR, { recursive: true });
}
