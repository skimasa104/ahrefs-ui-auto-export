import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import {
  OUTPUT_JENKINS_DOMAINS_DIR,
  OUTPUT_JENKINS_WIDE_DIR,
  resolveLatestFileInDir_,
  timestampToken_
} from "./output-paths.mjs";

export async function summarizeDomainsFromWide_({ inputPath, outputPath } = {}) {
  const widePath = await resolveWidePath_(inputPath);
  if (!widePath || !existsSync(widePath)) {
    throw new Error(`rank_check_wide csv not found: ${inputPath || OUTPUT_JENKINS_WIDE_DIR}`);
  }

  const rows = await readCsv_(widePath);
  if (rows.length === 0) {
    throw new Error(`rank_check_wide csv is empty: ${widePath}`);
  }

  const headers = Object.keys(rows[0] || {});
  const rankCols = headers.filter((h) => /^rank(10|[1-9])$/i.test(String(h || "").trim()));
  if (rankCols.length === 0) {
    throw new Error(`rank columns not found in wide csv. found=${headers.join(", ")}`);
  }

  const countMap = new Map();
  const rankTargets = [];
  for (const row of rows) {
    for (const col of rankCols) {
      const rawUrl = String(row[col] || "").trim();
      if (!rawUrl) continue;
      const target = parseRankTarget_(rawUrl);
      if (!target?.host) continue;
      rankTargets.push(target);
      countMap.set(target.host, (countMap.get(target.host) || 0) + 1);
    }
  }

  const outRows = Array.from(countMap.entries())
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));

  const clusterRows = summarizeMediaClusters_(rankTargets);

  const outPath = outputPath
    ? path.resolve(outputPath)
    : path.join(
        OUTPUT_JENKINS_DOMAINS_DIR,
        `${baseNameWithoutTimestamp_(widePath)}_domains_${timestampToken_()}.csv`
      );
  const clusterOutPath = path.join(
    OUTPUT_JENKINS_DOMAINS_DIR,
    `${baseNameWithoutTimestamp_(widePath)}_media_clusters_${timestampToken_()}.csv`
  );

  const csv = stringify(outRows, { header: false, columns: ["domain", "count"] });
  await fs.writeFile(outPath, csv, "utf8");
  const clusterCsv = stringify(clusterRows, {
    header: true,
    columns: ["target", "count", "host", "grouping", "first_directory"]
  });
  await fs.writeFile(clusterOutPath, clusterCsv, "utf8");

  return {
    input: widePath,
    output: outPath,
    clusterOutput: clusterOutPath,
    rows: outRows.length,
    clusterRows: clusterRows.length
  };
}

async function main() {
  const inputArg = process.argv[2] || "";
  const outputArg = process.argv[3] || "";
  const result = await summarizeDomainsFromWide_({ inputPath: inputArg, outputPath: outputArg });
  console.log("[ok] domain summary created");
  console.log(`input: ${result.input}`);
  console.log(`rows: ${result.rows}`);
  console.log(`output: ${result.output}`);
  console.log(`cluster_rows: ${result.clusterRows}`);
  console.log(`cluster_output: ${result.clusterOutput}`);
}

if (process.argv[1] && process.argv[1].endsWith("summarize-rank-domains.mjs")) {
  main().catch((error) => {
    console.error("[fatal]", error?.message || String(error));
    process.exit(1);
  });
}

async function resolveWidePath_(configuredPath) {
  if (configuredPath) {
    const p = path.resolve(configuredPath);
    if (!existsSync(p)) return "";
    const stat = await fs.stat(p);
    if (stat.isDirectory()) {
      return (
        (await resolveLatestFileInDir_(p, /^rank_check_wide_\d{8}_\d{6}\.csv$/i)) ||
        (await resolveLatestFileInDir_(p, /rank_check_wide.*\.csv$/i))
      );
    }
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

function parseRankTarget_(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = String(u.hostname || "").toLowerCase().replace(/\.+$/, "");
    const firstDirectory = extractFirstDirectory_(u.pathname);
    return {
      host,
      firstDirectory
    };
  } catch (_e) {
    return null;
  }
}

function baseNameWithoutTimestamp_(filePath) {
  const parsed = path.parse(path.basename(filePath));
  return parsed.name.replace(/_\d{8}_\d{6}$/i, "");
}

function extractFirstDirectory_(pathname) {
  const parts = String(pathname || "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts[0] || "";
}

function summarizeMediaClusters_(rankTargets) {
  const hostProfiles = buildHostProfiles_(rankTargets);
  const countMap = new Map();
  const metaMap = new Map();

  for (const target of rankTargets) {
    const profile = hostProfiles.get(target.host);
    const grouped = buildClusterKey_(target, profile);
    countMap.set(grouped.target, (countMap.get(grouped.target) || 0) + 1);
    if (!metaMap.has(grouped.target)) {
      metaMap.set(grouped.target, grouped);
    }
  }

  return Array.from(countMap.entries())
    .map(([target, count]) => {
      const meta = metaMap.get(target) || {};
      return {
        target,
        count,
        host: meta.host || "",
        grouping: meta.grouping || "host",
        first_directory: meta.firstDirectory || ""
      };
    })
    .sort((a, b) => b.count - a.count || a.target.localeCompare(b.target));
}

function buildHostProfiles_(rankTargets) {
  const profiles = new Map();

  for (const target of rankTargets) {
    if (!profiles.has(target.host)) {
      profiles.set(target.host, {
        totalCount: 0,
        rootCount: 0,
        dirCounts: new Map()
      });
    }
    const profile = profiles.get(target.host);
    profile.totalCount += 1;
    if (!isDirectoryLike_(target.firstDirectory)) {
      profile.rootCount += 1;
      continue;
    }
    profile.dirCounts.set(
      target.firstDirectory,
      (profile.dirCounts.get(target.firstDirectory) || 0) + 1
    );
  }

  for (const profile of profiles.values()) {
    const rankedDirs = Array.from(profile.dirCounts.entries()).sort((a, b) => b[1] - a[1]);
    const [dominantFirstDirectory = "", dominantCount = 0] = rankedDirs[0] || [];
    const dominantRatio = profile.totalCount > 0 ? dominantCount / profile.totalCount : 0;
    profile.dominantFirstDirectory = dominantFirstDirectory;
    profile.useFirstDirectory =
      Boolean(dominantFirstDirectory) &&
      dominantCount >= 2 &&
      ((profile.rootCount === 0 && dominantRatio >= 0.5) || dominantRatio >= 0.6);
  }

  return profiles;
}

function buildClusterKey_(target, profile) {
  const firstDirectory = target.firstDirectory || "";
  if (
    profile?.useFirstDirectory &&
    isDirectoryLike_(firstDirectory) &&
    firstDirectory === profile.dominantFirstDirectory
  ) {
    return {
      target: `${target.host}/${firstDirectory}`,
      host: target.host,
      grouping: "host_first_directory",
      firstDirectory
    };
  }

  return {
    target: target.host,
    host: target.host,
    grouping: "host",
    firstDirectory: ""
  };
}

function isDirectoryLike_(segment) {
  const raw = String(segment || "").trim();
  if (!raw) return false;
  if (raw.includes("%")) return false;

  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch (_e) {
    // keep raw segment
  }

  if (decoded.includes(".")) return false;
  if (/^\d+$/.test(decoded)) return false;
  if (decoded.length > 30) return false;
  return true;
}
