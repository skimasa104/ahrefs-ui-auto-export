import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

const ROOT_DIR = process.cwd();
const TARGETS_FILE = path.join(ROOT_DIR, "input", "targets.csv");
const DEFAULT_KEYWORDS_FILE = path.join(ROOT_DIR, "input", "keywords.txt");

main().catch((error) => {
  console.error("[fatal]", error?.message || String(error));
  process.exit(1);
});

async function main() {
  assertNodeVersion_();
  await loadDotEnv_(path.join(ROOT_DIR, ".env"));
  const cfg = buildConfig_();
  const keywords = await resolveKeywords_(cfg);

  if (keywords.length === 0) {
    throw new Error(
      "No keywords found. Pass keywords as arguments or create input/keywords.txt with one keyword per line."
    );
  }
  if (!cfg.serperApiKey) {
    throw new Error("Missing env: SERPER_API_KEY");
  }

  await fs.mkdir(path.join(ROOT_DIR, "input"), { recursive: true });

  console.log(`[info] keywords=${keywords.length} source=serper-api`);

  const discovered = [];
  for (let i = 0; i < keywords.length; i += 1) {
    const keyword = keywords[i];
    console.log(`[search] ${i + 1}/${keywords.length} ${keyword}`);
    const urls = await searchWithSerper_(keyword, cfg);
    console.log(`[found] ${keyword} urls=${urls.length}`);

    urls.forEach((u) => {
      discovered.push({
        target: u.url,
        source_keyword: keyword,
        source_rank: String(u.rank),
        source_title: u.title
      });
    });

    await sleep_(cfg.requestDelayMs);
  }

  const { rows, originalColumns } = await readTargetsRows_(TARGETS_FILE);
  const existing = new Set(rows.map((r) => normalizeTargetKey_(r.target)));
  const newlySeen = new Set();
  const now = new Date().toISOString();

  const additions = [];
  for (const item of discovered) {
    const target = normalizeTargetUrl_(item.target);
    if (!target) continue;
    const key = normalizeTargetKey_(target);
    if (!key || existing.has(key) || newlySeen.has(key)) continue;
    newlySeen.add(key);
    additions.push({
      target,
      mode: cfg.defaultMode,
      country: cfg.defaultCountry,
      status: "",
      source_genre: "",
      source_keyword: item.source_keyword,
      source_rank: item.source_rank,
      source_title: item.source_title,
      discovered_at: now
    });
  }

  const allRows = [...rows, ...additions];
  await writeTargetsRows_(TARGETS_FILE, allRows, originalColumns);

  console.log(`[ok] added=${additions.length} total=${allRows.length} file=${TARGETS_FILE}`);
}

function buildConfig_() {
  const args = process.argv.slice(2).map((v) => String(v || "").trim()).filter(Boolean);
  return {
    keywordArgs: args,
    maxKeywords: clampInt_(process.env.DISCOVERY_MAX_KEYWORDS, 15, 1, 200),
    topResults: clampInt_(process.env.DISCOVERY_TOP_RESULTS, 10, 1, 100),
    defaultMode: normalizeMode_(process.env.DISCOVERY_DEFAULT_MODE || "prefix"),
    defaultCountry: normalizeCountry_(process.env.DISCOVERY_DEFAULT_COUNTRY || "jp"),
    requestDelayMs: clampInt_(process.env.DISCOVERY_REQUEST_DELAY_MS, 500, 0, 30000),
    hl: String(process.env.DISCOVERY_HL || "ja").trim().toLowerCase(),
    gl: String(process.env.DISCOVERY_GL || "jp").trim().toLowerCase(),
    serperApiUrl: String(process.env.SERPER_API_URL || "https://google.serper.dev/search").trim(),
    serperApiKey: normalizeSecret_(process.env.SERPER_API_KEY || process.env.SERPER_KEY || process.env.X_API_KEY)
  };
}

async function resolveKeywords_(cfg) {
  if (cfg.keywordArgs.length === 1) {
    const maybeFile = path.resolve(ROOT_DIR, cfg.keywordArgs[0]);
    if (existsSync(maybeFile)) {
      return readKeywordsFile_(maybeFile, cfg.maxKeywords);
    }
  }

  if (cfg.keywordArgs.length > 0) {
    return uniqueKeywords_(cfg.keywordArgs).slice(0, cfg.maxKeywords);
  }

  if (existsSync(DEFAULT_KEYWORDS_FILE)) {
    return readKeywordsFile_(DEFAULT_KEYWORDS_FILE, cfg.maxKeywords);
  }

  return [];
}

async function readKeywordsFile_(filePath, maxKeywords) {
  const text = await fs.readFile(filePath, "utf8");
  const rows = text
    .split(/\r?\n/)
    .map((line) => String(line || "").trim())
    .filter((line) => line && !line.startsWith("#"));
  return uniqueKeywords_(rows).slice(0, maxKeywords);
}

function uniqueKeywords_(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const keyword = String(item || "").trim();
    const key = normalizeKey_(keyword);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(keyword);
  }
  return out;
}

async function searchWithSerper_(keyword, cfg) {
  const unique = [];
  const seen = new Set();
  const perPage = 10;
  const maxPage = Math.max(1, Math.ceil(cfg.topResults / perPage));

  for (let page = 1; page <= maxPage && unique.length < cfg.topResults; page += 1) {
    const remaining = cfg.topResults - unique.length;
    const payload = {
      q: keyword,
      gl: cfg.gl,
      hl: cfg.hl,
      page
    };
    if (remaining < perPage) {
      payload.num = remaining;
    }

    const json = await postJsonWithTimeout_(cfg.serperApiUrl, payload, cfg.serperApiKey, 30000);
    const organic = Array.isArray(json?.organic) ? json.organic : [];
    if (organic.length === 0) break;

    for (const item of organic) {
      const normalized = normalizeTargetUrl_(String(item?.link || ""));
      if (!normalized) continue;
      const key = normalizeTargetKey_(normalized);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      unique.push({
        url: normalized,
        title: String(item?.title || "").trim()
      });
      if (unique.length >= cfg.topResults) break;
    }

    await sleep_(cfg.requestDelayMs);
  }

  return unique.map((u, i) => ({ ...u, rank: i + 1 }));
}

async function postJsonWithTimeout_(url, body, apiKey, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      signal: ac.signal,
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": apiKey
      },
      body: JSON.stringify(body)
    });

    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch (_e) {
      throw new Error(`Serper API returned invalid JSON. status=${response.status}`);
    }

    if (!response.ok) {
      const msg = String(data?.message || data?.error || `HTTP ${response.status}`).trim();
      throw new Error(`Serper API error (${response.status}): ${msg}`);
    }
    return data;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Serper API timeout (${timeoutMs}ms)`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function assertNodeVersion_() {
  const major = Number(String(process.versions.node || "0").split(".")[0] || 0);
  if (major < 18) {
    throw new Error(`Node.js 18+ required. Current: ${process.versions.node}. Run: nvm use 20`);
  }
}

function normalizeTargetUrl_(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (!/^https?:$/.test(u.protocol)) return "";
    const host = u.hostname.toLowerCase();
    if (host.includes("google.") || host === "webcache.googleusercontent.com") return "";
    u.hash = "";
    for (const key of Array.from(u.searchParams.keys())) {
      if (/^(utm_|gclid|fbclid|yclid|mc_cid|mc_eid)/i.test(key)) {
        u.searchParams.delete(key);
      }
    }
    let pathName = u.pathname || "/";
    if (pathName.length > 1 && pathName.endsWith("/")) {
      pathName = pathName.slice(0, -1);
    }
    u.pathname = pathName;
    return `${u.origin}${u.pathname}${u.search ? `?${u.searchParams.toString()}` : ""}`;
  } catch (_e) {
    return "";
  }
}

function normalizeTargetKey_(value) {
  return normalizeKey_(String(value || "").replace(/^https?:\/\//i, "").replace(/\/+$/, ""));
}

async function readTargetsRows_(filePath) {
  if (!existsSync(filePath)) {
    return { rows: [], originalColumns: [] };
  }
  const csv = await fs.readFile(filePath, "utf8");
  const rows = parse(csv, { columns: true, skip_empty_lines: true, trim: true, bom: true });
  return {
    rows: rows
      .map((r) => ({
        ...r,
        target: String(r.target || r.url || "").trim(),
        mode: normalizeMode_(r.mode),
        country: normalizeCountry_(r.country)
      }))
      .filter((r) => r.target),
    originalColumns: collectColumns_(rows)
  };
}

async function writeTargetsRows_(filePath, rows, originalColumns) {
  const required = ["target", "mode", "country"];
  const extraDiscovery = ["status", "source_genre", "source_keyword", "source_rank", "source_title", "discovered_at"];
  const extras = (originalColumns || [])
    .filter(Boolean)
    .map((c) => String(c).trim())
    .filter((c) => !required.includes(c) && !extraDiscovery.includes(c));
  const columns = [...required, ...extraDiscovery, ...extras];

  const outRows = rows.map((r) => {
    const row = {};
    for (const c of columns) {
      row[c] = c === "mode" ? normalizeMode_(r[c]) : c === "country" ? normalizeCountry_(r[c]) : String(r[c] ?? "");
    }
    return row;
  });

  const outCsv = stringify(outRows, { header: true, columns });
  await fs.writeFile(filePath, outCsv, "utf8");
}

function collectColumns_(rows) {
  const set = new Set();
  for (const row of rows) {
    for (const k of Object.keys(row || {})) {
      const key = String(k || "").trim();
      if (key) set.add(key);
    }
  }
  return Array.from(set);
}

function normalizeMode_(value) {
  const lower = String(value || "prefix").trim().toLowerCase();
  return ["exact", "prefix", "domain", "subdomains"].includes(lower) ? lower : "prefix";
}

function normalizeCountry_(value) {
  const lower = String(value || "jp").trim().toLowerCase();
  return /^[a-z]{2}$/.test(lower) ? lower : "jp";
}

function normalizeKey_(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

async function loadDotEnv_(filePath) {
  if (!existsSync(filePath)) return;
  const content = await fs.readFile(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function normalizeSecret_(value) {
  const v = String(value || "").trim();
  if (!v || v.startsWith("your-")) return "";
  return v;
}

function clampInt_(raw, fallback, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function sleep_(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
