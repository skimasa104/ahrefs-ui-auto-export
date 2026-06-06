import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { chromium } from "playwright";
import {
  OUTPUT_AHREFS_BATCH_TOP3_DIR,
  ahrefsBatchRawPath_,
  ensureOutputStageDirs_,
  resolveLatestFileInDir_,
  timestampToken_
} from "./output-paths.mjs";

const ROOT_DIR = process.cwd();
const PROFILE_DIR = path.resolve(ROOT_DIR, process.env.AHREFS_PROFILE_DIR || ".ahrefs-profile");
const APP_BASE = process.env.AHREFS_APP_BASE || "https://app.ahrefs.com";
const BATCH_ANALYSIS_URL = process.env.AHREFS_BATCH_ANALYSIS_URL || `${APP_BASE}/batch-analysis`;
const HEADLESS = process.env.HEADLESS === "1";
const MAX_BATCH_TARGETS = Math.max(1, Number(process.env.MAX_BATCH_ANALYSIS_TARGETS || "200"));
const RESULTS_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.BATCH_ANALYSIS_RESULTS_TIMEOUT_MS || "900000")
);

main().catch((error) => {
  console.error("[fatal]", error?.message || String(error));
  process.exit(1);
});

async function main() {
  await ensureOutputStageDirs_();

  const inputArg = String(process.argv[2] || "").trim();
  const targetPaths = await resolveTargetsPaths_(inputArg);
  if (targetPaths.length === 0) {
    throw new Error(`Batch targets file not found: ${inputArg || OUTPUT_AHREFS_BATCH_TOP3_DIR}`);
  }

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    acceptDownloads: true,
    viewport: { width: 1440, height: 1000 },
    args: ["--disable-blink-features=AutomationControlled"]
  });

  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(BATCH_ANALYSIS_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
    await handleChallengeIfNeeded_(page);
    await ensureAuthenticated_(page);
    const runStamp = timestampToken_();

    for (let index = 0; index < targetPaths.length; index += 1) {
      const targetsPath = targetPaths[index];
      const targets = await readTargetsFile_(targetsPath);
      if (targets.length === 0) {
        throw new Error(`Batch targets file is empty: ${targetsPath}`);
      }
      if (targets.length > MAX_BATCH_TARGETS) {
        throw new Error(`Batch targets file exceeds ${MAX_BATCH_TARGETS} URLs: ${targetsPath}`);
      }

      await page.goto(BATCH_ANALYSIS_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
      await handleChallengeIfNeeded_(page);

      console.log(`[start] batch part ${index + 1}/${targetPaths.length}`);
      console.log(`input: ${targetsPath}`);
      console.log(`targets: ${targets.length}`);
      await fillTargets_(page, targets);
      await clickAnalyze_(page);
      await waitForResults_(page);
      const downloaded = await exportBatchCsv_(page);

      const outPath =
        targetPaths.length === 1
          ? ahrefsBatchRawPath_(runStamp)
          : rawPartPathFor_(runStamp, index + 1);
      await fs.copyFile(downloaded, outPath);

      console.log("[ok] Ahrefs batch analysis export downloaded");
      console.log(`part: ${index + 1}/${targetPaths.length}`);
      console.log(`targets: ${targets.length}`);
      console.log(`input: ${targetsPath}`);
      console.log(`downloaded: ${downloaded}`);
      console.log(`output: ${outPath}`);
    }
  } finally {
    await context.close();
  }
}

async function resolveTargetsPaths_(configuredPath) {
  if (configuredPath) {
    return resolveTargetPathSet_(path.resolve(ROOT_DIR, configuredPath));
  }
  const latestPart = await resolveLatestFileInDir_(
    OUTPUT_AHREFS_BATCH_TOP3_DIR,
    /^batch_targets_\d{8}_\d{6}_part\d{3}\.txt$/i
  );
  if (latestPart) {
    return resolveTargetPathSet_(latestPart);
  }
  const latestSingle =
    (await resolveLatestFileInDir_(OUTPUT_AHREFS_BATCH_TOP3_DIR, /^batch_targets_\d{8}_\d{6}\.txt$/i)) ||
    (await resolveLatestFileInDir_(OUTPUT_AHREFS_BATCH_TOP3_DIR, /batch_targets.*\.txt$/i));
  return latestSingle ? [latestSingle] : [];
}

async function resolveTargetPathSet_(filePath) {
  if (!existsSync(filePath)) return [];
  const stat = await fs.stat(filePath);
  if (stat.isDirectory()) {
    const latestPart = await resolveLatestFileInDir_(
      filePath,
      /^batch_targets_\d{8}_\d{6}_part\d{3}\.txt$/i
    );
    if (latestPart) return resolveTargetPathSet_(latestPart);
    const latestSingle =
      (await resolveLatestFileInDir_(filePath, /^batch_targets_\d{8}_\d{6}\.txt$/i)) ||
      (await resolveLatestFileInDir_(filePath, /batch_targets.*\.txt$/i));
    return latestSingle ? [latestSingle] : [];
  }

  const parsed = path.parse(filePath);
  const seriesMatch = parsed.name.match(/^(batch_targets_\d{8}_\d{6})(?:_part\d{3})?$/i);
  if (!seriesMatch) return [filePath];

  const prefix = seriesMatch[1];
  const entries = await fs.readdir(parsed.dir, { withFileTypes: true });
  const partFiles = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => new RegExp(`^${prefix}_part\\d{3}\\.txt$`, "i").test(name))
    .sort();

  if (partFiles.length > 0) {
    return partFiles.map((name) => path.join(parsed.dir, name));
  }

  return [filePath];
}

async function readTargetsFile_(targetsPath) {
  return (await fs.readFile(targetsPath, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function ensureAuthenticated_(page) {
  const url = String(page.url() || "").toLowerCase();
  const hasLoginFields =
    (await page.locator("input[type='email'], input[name='email']").count().catch(() => 0)) > 0 ||
    (await page.locator("input[type='password'], input[name='password']").count().catch(() => 0)) > 0;
  const needsLogin =
    url.includes("login") ||
    url.includes("signin") ||
    url.includes("sessions-exceeded") ||
    hasLoginFields;

  if (!needsLogin) return;
  if (HEADLESS) {
    throw new Error("Ahrefs login required. Re-run without HEADLESS and complete login.");
  }
  console.log("Ahrefs login is required. Complete it in the browser.");
  await waitForEnter_("Press Enter after Ahrefs login is complete...");
}

async function handleChallengeIfNeeded_(page) {
  const title = String(await page.title().catch(() => "")).toLowerCase();
  const text = String(await page.locator("body").innerText().catch(() => "")).toLowerCase();
  const blocked =
    title.includes("just a moment") ||
    title.includes("attention required") ||
    title.includes("checking your browser") ||
    text.includes("performing security verification");

  if (!blocked) return;

  if (HEADLESS) {
    throw new Error(
      "Anti-bot check detected on Ahrefs Batch Analysis. Re-run without HEADLESS and complete the check manually."
    );
  }

  console.log("Ahrefs anti-bot check detected. Complete it in the browser window.");
  await waitForEnter_("Press Enter after the check is completed...");
}

async function fillTargets_(page, targets) {
  const targetText = targets.join("\n");
  await page.waitForTimeout(1500);
  await page.locator("textarea, input[type='file'], [contenteditable='true']").first().waitFor({
    state: "visible",
    timeout: 30000
  }).catch(() => {});
  const textarea = await firstVisible_([
    page.locator("textarea").first(),
    page.getByPlaceholder(/one target per line|enter targets|paste/i).first(),
    page.locator("[contenteditable='true']").first()
  ]);

  if (!textarea) {
    throw new Error("Batch Analysis target input not found.");
  }

  const tagName = await textarea.evaluate((el) => el.tagName.toLowerCase()).catch(() => "");
  if (tagName === "textarea") {
    await textarea.fill(targetText);
    return;
  }

  await textarea.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.type(targetText);
}

async function clickAnalyze_(page) {
  const button = await firstVisible_([
    page.getByRole("button", { name: /analyze|analyse|show results|run/i }).first(),
    page.locator("button:has-text('Analyze')").first(),
    page.locator("button:has-text('Show results')").first()
  ]);

  if (!button) {
    throw new Error("Batch Analysis analyze button not found.");
  }

  await Promise.all([
    page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {}),
    button.click()
  ]);
}

async function waitForResults_(page) {
  const timeoutMs = RESULTS_TIMEOUT_MS;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await handleChallengeIfNeeded_(page);

    const exportButton = await findExportButton_(page);
    if (exportButton) return;

    const rows = await page.locator("table tbody tr").count().catch(() => 0);
    if (rows > 0) {
      await page.waitForTimeout(1500);
      continue;
    }

    await page.waitForTimeout(1000);
  }

  throw new Error("Timed out waiting for Ahrefs Batch Analysis results.");
}

async function exportBatchCsv_(page) {
  const exportButton = await waitForExportButton_(page, 120000);
  if (!exportButton) {
    throw new Error("Export button not found on Batch Analysis results page.");
  }

  const downloadPromise = page.waitForEvent("download", { timeout: 120000 });
  await exportButton.click();
  await clickExportConfirmIfNeeded_(page);
  const download = await downloadPromise;

  const downloadPath = await download.path();
  if (downloadPath) return downloadPath;

  const suggested = download.suggestedFilename();
  const fallback = path.join(ROOT_DIR, "downloads", suggested || `batch_analysis_${timestampToken_()}.csv`);
  await fs.mkdir(path.dirname(fallback), { recursive: true });
  await download.saveAs(fallback);
  return fallback;
}

async function waitForExportButton_(page, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await handleChallengeIfNeeded_(page);
    const button = await findExportButton_(page);
    if (button) return button;
    await page.waitForTimeout(1000);
  }
  return null;
}

async function findExportButton_(page) {
  return firstVisible_([
    page.getByRole("button", { name: /^Export$/i }).first(),
    page.locator("button:has-text('Export')").first(),
    page.locator("[role='button']:has-text('Export')").first()
  ]);
}

async function clickExportConfirmIfNeeded_(page) {
  await page.waitForTimeout(500);

  const dialog = await firstVisible_([
    page.getByRole("dialog").first(),
    page.locator("[role='dialog']").first()
  ]);
  if (!dialog) return;

  const confirmButton = await firstVisible_([
    dialog.getByRole("button", { name: /^Export$/i }).last(),
    dialog.locator("button:has-text('Export')").last()
  ]);
  if (!confirmButton) return;

  await confirmButton.click();
}

async function firstVisible_(locators) {
  for (const locator of locators) {
    if (await locator.isVisible().catch(() => false)) {
      return locator;
    }
  }
  return null;
}

async function waitForEnter_(message) {
  const rl = readline.createInterface({ input, output });
  await rl.question(`${message}\n`);
  rl.close();
}

function rawPartPathFor_(stamp, partNumber) {
  const base = ahrefsBatchRawPath_(stamp);
  const parsed = path.parse(base);
  return path.join(parsed.dir, `${parsed.name}_part${String(partNumber).padStart(3, "0")}${parsed.ext}`);
}
