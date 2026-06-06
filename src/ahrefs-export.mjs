import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import process from "node:process";
import { chromium } from "playwright";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import iconv from "iconv-lite";
import {
  OUTPUT_AHREFS_RAW_DIR,
  ensureOutputStageDirs_,
  perTargetCsvPath_,
  organicAllCsvPath_,
  organicUniqueCsvPath_,
  keywordsTxtPath_,
  timestampToken_
} from "./output-paths.mjs";

const ROOT_DIR = process.cwd();
const INPUT_FILE = process.env.TARGETS_FILE
  ? path.resolve(ROOT_DIR, process.env.TARGETS_FILE)
  : path.join(ROOT_DIR, "input", "targets.csv");
const PROFILE_DIR = path.join(ROOT_DIR, ".ahrefs-profile");
const DOWNLOAD_DIR = path.join(ROOT_DIR, "downloads");
const RAW_OUTPUT_DIR = OUTPUT_AHREFS_RAW_DIR;

const APP_BASE = process.env.AHREFS_APP_BASE || "https://app.ahrefs.com";
const REPORT_PATH = process.env.AHREFS_REPORT_PATH || "/v2-site-explorer/organic-keywords";
const HEADLESS = process.env.HEADLESS === "1";
const PRE_EXPORT_WAIT_MS = Number(process.env.PRE_EXPORT_WAIT_MS || "9000");
const POST_DIALOG_WAIT_MS = Number(process.env.POST_DIALOG_WAIT_MS || "1500");
const EXPORT_RETRY_COUNT = Number(process.env.EXPORT_RETRY_COUNT || "3");
const EXPORT_RETRY_WAIT_MS = Number(process.env.EXPORT_RETRY_WAIT_MS || "5000");
const MIN_VOLUME_ALL = Number(process.env.MIN_VOLUME_ALL || "100");
const MAX_ORGANIC_EXPORT_ROWS = Math.max(1, Number(process.env.MAX_ORGANIC_EXPORT_ROWS || "3000"));

const ALLOWED_MODES = ["exact", "prefix", "domain", "subdomains"];
const MODE_ALIAS = {
  path: "prefix",
  url: "exact"
};
const TARGET_STATE_COLUMNS = [
  "status",
  "planned_at",
  "started_at",
  "completed_at",
  "progress_note",
  "last_run_id",
  "result_rows",
  "result_file",
  "error_message"
];

const COMMAND = (process.argv[2] || "").toLowerCase();

main().catch((error) => {
  console.error("[fatal]", error && error.message ? error.message : error);
  process.exit(1);
});

async function main() {
  if (COMMAND === "login") {
    await runLogin();
    return;
  }

  if (COMMAND === "export") {
    await runExport();
    return;
  }

  console.log("Usage:");
  console.log("  npm run login   # save Ahrefs login session");
  console.log("  npm run export  # export CSV for all targets in input/targets.csv");
}

async function runLogin() {
  await ensureDirectories_();
  const context = await launchContext_({ headless: false });
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(APP_BASE, { waitUntil: "domcontentloaded", timeout: 120000 });

  console.log("");
  console.log("Ahrefs login window opened.");
  console.log("1) Login to Ahrefs (and complete 2FA if needed)");
  console.log("2) When done, come back to terminal and press Enter");
  await waitForEnter_("Press Enter after login is complete...");

  await context.close();
  console.log("Session saved in .ahrefs-profile/");
}

async function runExport() {
  await ensureDirectories_();
  const targetState = await readTargetsWithState_(INPUT_FILE);
  if (targetState.rows.length === 0) {
    throw new Error(`No targets found in ${INPUT_FILE}`);
  }
  const targets = targetState.rows.filter((row) => row.target && !isDoneStatus_(row.status));
  if (targets.length === 0) {
    console.log("[skip] No new targets. All rows are already done.");
    return;
  }

  const context = await launchContext_({ headless: HEADLESS });
  const page = context.pages()[0] || (await context.newPage());
  const allRows = [];
  const failures = [];
  const runStamp = timestampToken_();
  const runId = runStamp;

  for (let i = 0; i < targets.length; i += 1) {
    const item = targets[i];
    item.status = "queued";
    item.planned_at = nowIso_();
    item.last_run_id = runId;
    item.progress_note = `実行予定 (${i + 1}/${targets.length})`;
  }
  await writeTargetsState_(INPUT_FILE, targetState.rows, targetState.originalColumns);

  await page.goto(APP_BASE, { waitUntil: "domcontentloaded", timeout: 120000 });
  await ensureAuthenticated_(page);

  for (let i = 0; i < targets.length; i += 1) {
    const item = targets[i];
    const reportUrl = buildOrganicKeywordsUrl_(item);
    console.log("");
    console.log(`[start] ${item.target} mode=${item.mode} country=${item.country}`);
    item.status = "running";
    item.started_at = nowIso_();
    item.last_run_id = runId;
    item.progress_note = `実行中 (${i + 1}/${targets.length})`;
    await writeTargetsState_(INPUT_FILE, targetState.rows, targetState.originalColumns);

    try {
      await page.goto(reportUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
      await ensureAuthenticated_(page);
      await handleChallengeIfNeeded_(page);
      await waitUntilReportReady_(page);

      const downloaded = await exportFromCurrentPage_(page, item);
      const filtered = await extractKeywordVolume_(downloaded, item.target, runStamp);
      allRows.push(...filtered.rows);

      console.log(
        `[done] ${item.target} downloaded=${path.basename(downloaded)} rows=${filtered.rows.length}`
      );
      item.status = "done";
      item.completed_at = nowIso_();
      item.progress_note = `実行完了 (${i + 1}/${targets.length})`;
      item.result_rows = String(filtered.rows.length);
      item.result_file = path.basename(filtered.outPath || "");
      item.error_message = "";
      item.last_run_id = runId;
      await writeTargetsState_(INPUT_FILE, targetState.rows, targetState.originalColumns);
      await page.waitForTimeout(1200);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      failures.push({ target: item.target, reason: message });
      console.error(`[fail] ${item.target} ${message}`);
      item.status = "error";
      item.completed_at = nowIso_();
      item.progress_note = `実行失敗 (${i + 1}/${targets.length})`;
      item.error_message = truncate_(message, 400);
      item.last_run_id = runId;
      await writeTargetsState_(INPUT_FILE, targetState.rows, targetState.originalColumns);
    }
  }

  if (allRows.length > 0) {
    const sortedAllRows = [...allRows].sort((a, b) => volumeValue_(b.volume) - volumeValue_(a.volume));
    const filteredAllRows = sortedAllRows.filter((row) => volumeValue_(row.volume) > MIN_VOLUME_ALL);
    const outPath = organicAllCsvPath_(runStamp);
    const csv = stringify(filteredAllRows, {
      header: true,
      columns: ["domain", "keyword", "volume"]
    });
    await fs.writeFile(outPath, csv, "utf8");

    const uniqueRows = mergeRowsByKeyword_(filteredAllRows);
    const uniquePath = organicUniqueCsvPath_(runStamp);
    const uniqueCsv = stringify(uniqueRows, {
      header: true,
      columns: ["keyword", "volume", "targets", "target_count"]
    });
    await fs.writeFile(uniquePath, uniqueCsv, "utf8");

    const keywordsTxtPath = keywordsTxtPath_(runStamp);
    const keywordsTxt = filteredAllRows.map((row) => row.keyword).join("\n");
    const keywordsTxtWithLf = keywordsTxt ? `${keywordsTxt}\n` : "";
    await fs.writeFile(keywordsTxtPath, keywordsTxtWithLf, "utf8");

    console.log("");
    console.log(`[output] ${outPath} (${filteredAllRows.length} rows)`);
    console.log(`[output] ${uniquePath} (${uniqueRows.length} rows)`);
    console.log(`[output] ${keywordsTxtPath} (${filteredAllRows.length} lines)`);
  } else {
    console.log("");
    console.log("[output] no rows exported");
  }

  await context.close();

  if (failures.length > 0) {
    console.log("");
    console.log("Some targets failed:");
    for (const f of failures) {
      console.log(`- ${f.target}: ${f.reason}`);
    }
    process.exitCode = 1;
  }
}

async function ensureDirectories_() {
  await fs.mkdir(path.join(ROOT_DIR, "input"), { recursive: true });
  await fs.mkdir(DOWNLOAD_DIR, { recursive: true });
  await ensureOutputStageDirs_();
}

function launchContext_({ headless }) {
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    acceptDownloads: true,
    downloadsPath: DOWNLOAD_DIR,
    viewport: { width: 1440, height: 1000 },
    args: ["--disable-blink-features=AutomationControlled"]
  });
}

async function ensureAuthenticated_(page) {
  const lowerUrl = page.url().toLowerCase();
  if (lowerUrl.includes("login") || lowerUrl.includes("signin")) {
    if (HEADLESS) {
      throw new Error("Login required. Re-run with HEADLESS=0 and run `npm run login` first.");
    }
    console.log("Login required. Complete login in browser.");
    await waitForEnter_("Press Enter after you finish login...");
    return;
  }

  const loginButton = page.getByRole("button", { name: /log in|sign in/i }).first();
  if (await loginButton.isVisible().catch(() => false)) {
    if (HEADLESS) {
      throw new Error("Login required. Re-run with HEADLESS=0 and run `npm run login` first.");
    }
    console.log("Login required. Complete login in browser.");
    await waitForEnter_("Press Enter after you finish login...");
  }
}

async function waitUntilReportReady_(page) {
  const candidates = [
    page.getByText(/Organic keywords/i).first(),
    page.getByRole("tab", { name: /Organic keywords/i }).first(),
    page.locator("text=Organic keywords").first()
  ];

  for (const locator of candidates) {
    try {
      await locator.waitFor({ state: "visible", timeout: 30000 });
      return;
    } catch (error) {
      // try next candidate
    }
  }

  // Fallback short wait for slower pages.
  await page.waitForTimeout(5000);
}

async function waitForReportStable_(page) {
  await handleChallengeIfNeeded_(page);

  try {
    await page.waitForLoadState("networkidle", { timeout: 20000 });
  } catch (error) {
    // Ahrefs can keep some background requests alive.
  }

  const loadingHints = [
    page.locator("text=Loading").first(),
    page.locator("text=読み込み").first(),
    page.locator("[aria-busy='true']").first()
  ];

  const deadline = Date.now() + PRE_EXPORT_WAIT_MS;
  while (Date.now() < deadline) {
    let busy = false;
    for (const hint of loadingHints) {
      if (await hint.isVisible().catch(() => false)) {
        busy = true;
        break;
      }
    }
    if (!busy) break;
    await sleep_(500);
  }

  // Final cushion to avoid racing the dialog state.
  await sleep_(Math.max(1000, PRE_EXPORT_WAIT_MS - 2000));
}

async function exportFromCurrentPage_(page, item) {
  await waitForReportStable_(page);

  const dialog = await openExportDialog_(page);
  let lastError = null;

  for (let attempt = 1; attempt <= EXPORT_RETRY_COUNT; attempt += 1) {
    await sleep_(POST_DIALOG_WAIT_MS);
    await chooseAllRows_(dialog);
    await chooseCsvUtf16_(dialog);
    await ensureDialogSelections_(dialog);
    await sleep_(POST_DIALOG_WAIT_MS);

    const confirm = await waitForEnabledExportButton_(dialog, 20000);
    const beforeFiles = await listDownloadFiles_();

    const downloadPromise = page
      .waitForEvent("download", { timeout: 45000 })
      .then(async (download) => {
        const fileName = `${slug_(item.target)}_${timestamp_()}.csv`;
        const downloadedPath = path.join(DOWNLOAD_DIR, fileName);
        await download.saveAs(downloadedPath);
        return downloadedPath;
      })
      .catch(() => null);

    await confirm.click();

    let downloadedPath = await downloadPromise;
    if (!downloadedPath) {
      downloadedPath = await waitForNewFileInDownloads_(beforeFiles, 70000);
    }

    if (downloadedPath) {
      const rawCopyPath = path.join(RAW_OUTPUT_DIR, path.basename(downloadedPath));
      await fs.copyFile(downloadedPath, rawCopyPath);
      return downloadedPath;
    }

    const retryable = await hasRetryableExportError_(page, dialog);
    if (retryable && attempt < EXPORT_RETRY_COUNT) {
      console.log(`[warn] export failed on attempt ${attempt}, retrying...`);
      await sleep_(EXPORT_RETRY_WAIT_MS);
      continue;
    }

    lastError = retryable
      ? new Error(`Ahrefs export dialog returned an error after ${attempt} attempt(s).`)
      : new Error("Export clicked but no CSV file was detected.");
    break;
  }

  throw lastError || new Error("Export failed for unknown reason.");
}

async function openExportDialog_(page) {
  await handleChallengeIfNeeded_(page);

  const exportLabel = /^(Export|エクスポート)$/i;
  const byRole = page.getByRole("button", { name: exportLabel }).first();
  if (await byRole.isVisible().catch(() => false)) {
    await byRole.click();
  } else {
    const fallback = [
      page.locator("button:has-text('Export')").first(),
      page.locator("button:has-text('エクスポート')").first(),
      page.locator("[role='button']:has-text('Export')").first(),
      page.locator("[role='button']:has-text('エクスポート')").first()
    ];
    let clicked = false;
    for (const locator of fallback) {
      if (await locator.isVisible().catch(() => false)) {
        await locator.click();
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      await handleChallengeIfNeeded_(page);
      const title = await page.title().catch(() => "");
      throw new Error(
        `Export button not found. url=${page.url()} title=${title}`
      );
    }
  }

  const dialog = page.locator("[role='dialog']").last();
  await dialog.waitFor({ state: "visible", timeout: 30000 });
  return dialog;
}

async function handleChallengeIfNeeded_(page) {
  const title = String(await page.title().catch(() => "")).toLowerCase();
  const blocked =
    title.includes("just a moment") ||
    title.includes("attention required") ||
    title.includes("checking your browser");

  if (!blocked) return;

  if (HEADLESS) {
    throw new Error(
      "Anti-bot check detected (Just a moment...). Run without HEADLESS and complete the check manually."
    );
  }

  console.log("Anti-bot check detected. Complete it in the browser window.");
  await waitForEnter_("Press Enter after the check is completed...");
}

async function chooseAllRows_(dialog) {
  const selectedLabel = await dialog.evaluate((el, maxRows) => {
    const labels = Array.from(el.querySelectorAll("label"));
    const candidates = labels
      .map((label) => {
        const text = (label.textContent || "").trim();
        const radio = label.querySelector("input[type='radio']");
        if (!radio || radio.disabled) return null;

        const lower = text.toLowerCase();
        if (lower.includes("all") || text.includes("すべて")) {
          return { label, score: Number.MAX_SAFE_INTEGER, text, isAll: true };
        }

        const match = text.match(/(\d[\d,]*)/);
        const n = match ? Number(match[1].replace(/,/g, "")) : 0;
        return { label, score: Number.isFinite(n) ? n : 0, text, isAll: false };
      })
      .filter(Boolean);

    if (candidates.length === 0) return "";

    const numericWithinLimit = candidates
      .filter((item) => !item.isAll && item.score > 0 && (!maxRows || item.score <= maxRows))
      .sort((a, b) => b.score - a.score);

    const best =
      numericWithinLimit[0] ||
      candidates.find((item) => item.isAll) ||
      candidates.sort((a, b) => b.score - a.score)[0];

    const radio = best.label.querySelector("input[type='radio']");
    if (radio) {
      radio.click();
      radio.dispatchEvent(new Event("input", { bubbles: true }));
      radio.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      best.label.click();
    }
    return best.text;
  }, MAX_ORGANIC_EXPORT_ROWS);

  if (selectedLabel) {
    console.log(`[info] row option selected: ${selectedLabel}`);
  }
}

async function chooseCsvUtf16_(dialog) {
  const utf16Candidates = [
    dialog.getByLabel(/CSV\s*\(UTF-16/i).first(),
    dialog.locator("label:has-text('CSV (UTF-16')").first(),
    dialog.locator("text=CSV (UTF-16").first()
  ];

  for (const option of utf16Candidates) {
    if (await option.isVisible().catch(() => false)) {
      await option.click();
      return;
    }
  }

  const anyCsv = [
    dialog.getByLabel(/CSV/i).first(),
    dialog.locator("label:has-text('CSV')").first()
  ];
  for (const option of anyCsv) {
    if (await option.isVisible().catch(() => false)) {
      await option.click();
      return true;
    }
  }

  const exportButton = await getExportButton_(dialog);
  if (exportButton && (await exportButton.isVisible().catch(() => false))) {
    console.log("[info] CSV format option not shown; using dialog default format.");
    return false;
  }

  throw new Error("CSV format option not found in Export dialog.");
}

async function waitForEnabledExportButton_(dialog, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const button = await getExportButton_(dialog);
    if (button && (await button.isVisible().catch(() => false))) {
      const disabled = await button.isDisabled().catch(() => true);
      if (!disabled) return button;
      await chooseCsvUtf16_(dialog).catch(() => {});
    }
    await sleep_(300);
  }
  const debug = await dialog.innerText().catch(() => "");
  throw new Error("Export button is still disabled in dialog. " + truncate_(debug, 220));
}

async function getExportButton_(dialog) {
  const candidates = [
    dialog.getByRole("button", { name: /^(Export|エクスポート)$/i }).first(),
    dialog.locator("button:has-text('Export')").first(),
    dialog.locator("button:has-text('エクスポート')").first(),
    dialog.locator("button").last()
  ];

  for (const locator of candidates) {
    if (await locator.isVisible().catch(() => false)) {
      return locator;
    }
  }
  return null;
}

async function ensureDialogSelections_(dialog) {
  await dialog.evaluate((el) => {
    const radios = Array.from(el.querySelectorAll("input[type='radio']"));
    if (radios.length === 0) return;

    const groups = new Map();
    for (const r of radios) {
      if (r.disabled) continue;
      const name = r.name || "__no_name__";
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(r);
    }

    for (const [, group] of groups) {
      const checked = group.find((r) => r.checked);
      const target = checked || group[0];
      if (!target) continue;
      target.click();
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
    }

    // If Google Sheets is selected, switch to CSV.
    const labels = Array.from(el.querySelectorAll("label"));
    const gsLabel = labels.find((label) =>
      /google sheets/i.test(label.textContent || "")
    );
    const gsRadio = gsLabel?.querySelector("input[type='radio']");
    if (gsRadio && gsRadio.checked) {
      const csvLabel =
        labels.find((label) => /csv\s*\(utf-16/i.test(label.textContent || "")) ||
        labels.find((label) => /csv/i.test(label.textContent || ""));
      const csvRadio = csvLabel?.querySelector("input[type='radio']");
      if (csvRadio && !csvRadio.disabled) {
        csvRadio.click();
        csvRadio.dispatchEvent(new Event("input", { bubbles: true }));
        csvRadio.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
  });
}

function truncate_(text, maxLength) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (s.length <= maxLength) return s;
  return s.slice(0, maxLength) + "...";
}

async function hasRetryableExportError_(page, dialog) {
  const targets = [
    dialog.locator("text=Something went wrong").first(),
    dialog.locator("text=Please try again").first(),
    page.locator("text=Something went wrong").first(),
    page.locator("text=Request id").first()
  ];
  for (const locator of targets) {
    if (await locator.isVisible().catch(() => false)) {
      return true;
    }
  }
  return false;
}

async function extractKeywordVolume_(filePath, domain, stamp) {
  if (!existsSync(filePath)) {
    throw new Error("Downloaded file not found: " + filePath);
  }

  const buffer = await fs.readFile(filePath);
  const text = decodeCsvBuffer_(buffer);
  const records = parseCsvRecords_(text);

  if (!Array.isArray(records) || records.length === 0) {
    return { rows: [], outPath: null };
  }

  const headers = Object.keys(records[0]);
  const keywordCol = findColumn_(headers, ["keyword", "keywords"]);
  const volumeCol = findColumn_(headers, ["volume", "monthly volume", "search volume"]);

  if (!keywordCol || !volumeCol) {
    throw new Error(
      "Could not find keyword/volume columns. Found: " + headers.join(", ")
    );
  }

  const rows = records
    .map((r) => ({
      domain,
      keyword: String(r[keywordCol] || "").trim(),
      volume: normalizeVolume_(r[volumeCol])
    }))
    .filter((r) => r.keyword);

  const dedupedRows = dedupeKeywordRows_(rows);
  const sortedRows = dedupedRows.sort((a, b) => volumeValue_(b.volume) - volumeValue_(a.volume));
  const perDomainPath = perTargetCsvPath_(slug_(domain), stamp);
  const csv = stringify(
    sortedRows.map((r) => ({ keyword: r.keyword, volume: r.volume })),
    { header: true, columns: ["keyword", "volume"] }
  );
  await fs.writeFile(perDomainPath, csv, "utf8");

  return { rows: sortedRows, outPath: perDomainPath };
}

function normalizeVolume_(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : raw;
}

function volumeValue_(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const n = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function decodeCsvBuffer_(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return iconv.decode(buffer, "utf16le");
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.toString("utf8");
  }
  return buffer.toString("utf8");
}

function parseCsvRecords_(text) {
  try {
    return parse(text, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
      bom: true,
      delimiter: [",", "\t", ";"]
    });
  } catch (error) {
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length < 2) return [];

    const delimiter = lines[0].includes("\t") ? "\t" : ",";
    const headers = lines[0].split(delimiter).map((h) => h.replace(/^"|"$/g, ""));
    return lines.slice(1).map((line) => {
      const cols = line.split(delimiter).map((c) => c.replace(/^"|"$/g, ""));
      const row = {};
      headers.forEach((h, i) => {
        row[h] = cols[i] ?? "";
      });
      return row;
    });
  }
}

function findColumn_(headers, candidates) {
  const normalized = headers.map((h) => ({ raw: h, key: normalizeKey_(h) }));
  for (const candidate of candidates) {
    const key = normalizeKey_(candidate);
    const found = normalized.find((h) => h.key === key);
    if (found) return found.raw;
  }
  return null;
}

function normalizeKey_(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeKeywordRows_(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = normalizeKey_(row.keyword);
    const existing = map.get(key);
    if (!existing || volumeValue_(row.volume) > volumeValue_(existing.volume)) {
      map.set(key, row);
    }
  }
  return Array.from(map.values());
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

async function readTargetsWithState_(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`${filePath} not found`);
  }

  const csv = await fs.readFile(filePath, "utf8");
  const rows = parse(csv, { columns: true, skip_empty_lines: true, trim: true, bom: true });
  const originalColumns = collectColumns_(rows);

  const normalizedRows = rows
    .map((row) => {
      const target = String(row.target || row.url || "").trim();
      if (!target) return null;
      return {
        ...row,
        target,
        mode: normalizeMode_(row.mode),
        country: normalizeCountry_(row.country),
        status: normalizeStatus_(row.status),
        planned_at: String(row.planned_at || "").trim(),
        started_at: String(row.started_at || "").trim(),
        completed_at: String(row.completed_at || "").trim(),
        progress_note: String(row.progress_note || "").trim(),
        last_run_id: String(row.last_run_id || "").trim(),
        result_rows: String(row.result_rows || "").trim(),
        result_file: String(row.result_file || "").trim(),
        error_message: String(row.error_message || "").trim()
      };
    })
    .filter(Boolean);

  return {
    rows: normalizedRows,
    originalColumns
  };
}

async function writeTargetsState_(filePath, rows, originalColumns) {
  const required = ["target", "mode", "country"];
  const extras = (originalColumns || [])
    .map((c) => String(c || "").trim())
    .filter(Boolean)
    .filter((c) => !required.includes(c) && !TARGET_STATE_COLUMNS.includes(c));

  const columns = [...required, ...TARGET_STATE_COLUMNS, ...extras];
  const outRows = rows
    .filter((r) => String(r.target || "").trim())
    .map((r) => {
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

function isDoneStatus_(status) {
  const s = normalizeStatus_(status);
  return s === "done" || s === "completed" || s === "success" || s === "ok";
}

function normalizeStatus_(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeMode_(value) {
  const lower = String(value || "domain").trim().toLowerCase();
  const aliased = MODE_ALIAS[lower] || lower;
  return ALLOWED_MODES.includes(aliased) ? aliased : "domain";
}

function normalizeCountry_(value) {
  const lower = String(value || "jp").trim().toLowerCase();
  return /^[a-z]{2}$/.test(lower) ? lower : "jp";
}

function buildOrganicKeywordsUrl_(item) {
  const url = new URL(REPORT_PATH, APP_BASE);
  url.searchParams.set("target", item.target);
  url.searchParams.set("mode", item.mode);
  url.searchParams.set("country", item.country);
  return url.toString();
}

function slug_(value) {
  return String(value)
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function timestamp_() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function nowIso_() {
  return new Date().toISOString();
}

async function waitForEnter_(message) {
  const rl = readline.createInterface({ input, output });
  await rl.question(`${message}\n`);
  rl.close();
}

async function listDownloadFiles_() {
  const entries = await fs.readdir(DOWNLOAD_DIR, { withFileTypes: true });
  return new Set(
    entries
      .filter((e) => e.isFile())
      .map((e) => e.name)
  );
}

async function waitForNewFileInDownloads_(beforeFiles, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = await fs.readdir(DOWNLOAD_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (beforeFiles.has(entry.name)) continue;
      if (entry.name.endsWith(".crdownload")) continue;
      return path.join(DOWNLOAD_DIR, entry.name);
    }
    await sleep_(700);
  }
  return null;
}

function sleep_(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
