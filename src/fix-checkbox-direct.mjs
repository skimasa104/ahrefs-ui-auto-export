import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { spawn, execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { stdin as input, stdout as output } from "node:process";
import { chromium } from "playwright";
import { parse } from "csv-parse/sync";

const execFile = promisify(execFileCallback);
const ROOT_DIR = process.cwd();
const PROFILE_DIR = path.resolve(ROOT_DIR, process.env.GOOGLE_PROFILE_DIR || ".google-profile");
const DEFAULT_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/1YR6QRThkpiGUlC7WnrizyI_w2qyIGxPnYPZk3VmPlRs/edit?usp=sharing";
const DR_THRESHOLD = 40;

main().catch((error) => {
  console.error("[fatal]", error?.message || String(error));
  process.exit(1);
});

async function main() {
  const sheetUrl = String(process.argv[2] || process.env.GOOGLE_SHEET_URL || DEFAULT_SHEET_URL).trim();
  const csvPath = path.resolve(ROOT_DIR, String(process.argv[3] || "").trim());
  const tabName = String(process.argv[4] || "包茎").trim();

  if (!csvPath || !existsSync(csvPath)) throw new Error(`CSV not found: ${csvPath}`);

  // Read CSV and compute checkbox values locally
  const csvText = await fs.readFile(csvPath, "utf8");
  const records = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    relax_quotes: true,
    relax_column_count: true
  });
  if (!records.length) throw new Error(`CSV is empty: ${csvPath}`);

  const rowCount = records.length;
  const checkValues = records.map((row, i) => {
    const dr1 = Number(row.DR1 ?? row.dr1 ?? Infinity);
    const dr2 = Number(row.DR2 ?? row.dr2 ?? Infinity);
    const dr3 = Number(row.DR3 ?? row.dr3 ?? Infinity);
    const shouldCheck = dr1 <= DR_THRESHOLD || dr2 <= DR_THRESHOLD || dr3 <= DR_THRESHOLD;
    return shouldCheck;
  });

  // Verify a few rows
  console.log("[verify] Row 9 (おちんちん): DR1=24, DR3=14 → should be TRUE:", checkValues[8]);
  console.log("[verify] Row 10 (精を出す): DR1=82, DR2=84, DR3=84 → should be FALSE:", checkValues[9]);
  console.log("[verify] Row 12 (かんとんほうけい): DR1=44, DR2=91, DR3=48 → should be FALSE:", checkValues[11]);
  console.log("[verify] Row 15 (真性包茎): DR3=28 → should be TRUE:", checkValues[14]);
  console.log("[verify] Row 16 (粗チン): DR1=44, DR2=52, DR3=44 → should be FALSE:", checkValues[15]);
  console.log("[verify] Row 19 (長茎術): DR1=18, DR2=39 → should be TRUE:", checkValues[18]);
  console.log("[verify] Row 20 (カントン包茎): DR1=44, DR2=48, DR3=91 → should be FALSE:", checkValues[19]);

  const checkedCount = checkValues.filter(Boolean).length;
  console.log(`[info] Total: ${rowCount} rows, ${checkedCount} checked, ${rowCount - checkedCount} unchecked`);

  // Build bitmask for GAS (1=TRUE, 0=FALSE)
  const bitmask = checkValues.map((v) => (v ? "1" : "0")).join("");

  // Build GAS code with hardcoded bitmask
  const gasCode = `function fixCheckboxes() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var bitmask = "${bitmask}";
  var n = bitmask.length;

  var range = sheet.getRange(2, 1, n, 1);
  range.clearContent();
  range.clearDataValidations();

  var values = [];
  for (var i = 0; i < n; i++) {
    values.push([bitmask.charAt(i) === "1"]);
  }

  var rule = SpreadsheetApp.newDataValidation().requireCheckbox().build();
  range.setDataValidation(rule);
  range.setValues(values);
  SpreadsheetApp.flush();
  Logger.log("Done: " + n + " rows, checked=" + bitmask.split("1").length + " unchecked=" + bitmask.split("0").length);
}`;

  console.log(`[info] GAS code: ${gasCode.length} chars, bitmask: ${bitmask.length} chars`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1440, height: 1000 },
    args: ["--disable-blink-features=AutomationControlled"]
  });

  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(sheetUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForTimeout(5000);
    await ensureGoogleAuthenticated_(page);
    await bringBrowserToFront_();
    await dismissModals_(page);

    // Navigate to tab
    console.log("[step 1/5] Navigating to tab:", tabName);
    const tab = page
      .locator(".docs-sheet-tab-name")
      .filter({ hasText: new RegExp(`^${tabName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) })
      .first();
    if (await tab.isVisible().catch(() => false)) {
      await tab.click();
      await page.waitForTimeout(2000);
    }

    // Open Apps Script
    console.log("[step 2/5] Opening Apps Script editor...");
    await openAppsScript_(page);

    // Wait for Apps Script tab
    let gasPage = null;
    for (let attempt = 0; attempt < 30; attempt++) {
      for (const p of context.pages()) {
        if (p.url().includes("script.google.com")) {
          gasPage = p;
          break;
        }
      }
      if (gasPage) break;
      await page.waitForTimeout(1000);
    }
    if (!gasPage) throw new Error("Apps Script editor did not open.");

    await gasPage.waitForLoadState("domcontentloaded", { timeout: 60000 });
    await gasPage.waitForTimeout(5000);
    console.log("[step 3/5] Apps Script editor opened.");

    // Write and run GAS code
    console.log("[step 4/5] Writing and running fixCheckboxes()...");
    await writeAndRunGas_(gasPage, gasCode);

    console.log("[step 5/5] Waiting for execution to complete...");
    // Wait longer for 2000 rows
    await gasPage.waitForTimeout(20000);

    // Check for execution log
    const logText = await gasPage.locator(".execution-log, .apps-script-log, [class*='log']").first().innerText().catch(() => "");
    if (logText) console.log("[gas-log]", logText.slice(0, 200));

    await gasPage.close().catch(() => {});
    await page.bringToFront();
    await page.waitForTimeout(2000);

    console.log("[ok] Checkboxes fixed with hardcoded values from CSV!");
    console.log(`Tab: ${tabName}`);
    console.log(`Rows: ${rowCount}, Checked: ${checkedCount}`);
  } finally {
    await context.close();
  }
}

async function openAppsScript_(page) {
  const menuTexts = ["拡張機能", "Extensions"];
  for (const text of menuTexts) {
    const menu = page
      .locator(`.menu-button, [role="menuitem"]`)
      .filter({ hasText: new RegExp(`^${text}$`) })
      .first();
    if (await menu.isVisible().catch(() => false)) {
      await menu.click();
      await page.waitForTimeout(1000);
      break;
    }
  }

  const menuItems = page.locator('[role="menuitem"], .goog-menuitem');
  const allItems = await menuItems.all();
  for (const item of allItems) {
    const text = (await item.innerText().catch(() => "")).trim();
    if (text.includes("Apps Script") || text.includes("Apps\xa0Script")) {
      await item.click();
      await page.waitForTimeout(3000);
      return;
    }
  }
  throw new Error("Apps Script menu item not found.");
}

async function writeAndRunGas_(gasPage, code) {
  await gasPage.waitForTimeout(3000);

  // Click on editor area
  const editorSelectors = [
    ".monaco-editor .view-lines",
    ".CodeMirror",
    "[role='code']",
    ".monaco-editor"
  ];
  for (const sel of editorSelectors) {
    const editor = gasPage.locator(sel).first();
    if (await editor.isVisible().catch(() => false)) {
      await editor.click();
      break;
    }
  }
  await gasPage.waitForTimeout(500);

  // Select all and delete
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await gasPage.keyboard.press(`${mod}+A`);
  await gasPage.waitForTimeout(300);
  await gasPage.keyboard.press("Backspace");
  await gasPage.waitForTimeout(500);

  // Paste new code
  await copyToClipboard_(code);
  await gasPage.keyboard.press(`${mod}+V`);
  await gasPage.waitForTimeout(2000);

  // Save
  await gasPage.keyboard.press(`${mod}+S`);
  await gasPage.waitForTimeout(4000);

  // Click Run button
  const runSelectors = [
    'button[aria-label="Run"]',
    'button:has-text("実行")',
    'button:has-text("Run")',
    '[data-tooltip="Run"]',
    '[aria-label="Run"]'
  ];
  for (const sel of runSelectors) {
    const btn = gasPage.locator(sel).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      console.log("[info] Clicked Run button");
      break;
    }
  }
  await gasPage.waitForTimeout(3000);

  // Handle authorization
  await handleAuth_(gasPage);
}

async function handleAuth_(gasPage) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const buttons = await gasPage.locator('button, [role="button"]').all();
    for (const btn of buttons) {
      const text = (await btn.innerText().catch(() => "")).trim();
      if (
        text.includes("権限を確認") ||
        text.includes("Review permissions") ||
        text.includes("承認") ||
        text.includes("許可")
      ) {
        console.log("[info] Auth dialog detected, clicking:", text);
        await btn.click();
        await gasPage.waitForTimeout(5000);

        // Handle the OAuth popup
        for (const p of gasPage.context().pages()) {
          if (p.url().includes("accounts.google.com")) {
            console.log("[info] Google OAuth popup detected. Please authorize in the browser.");
            await waitForEnter_("Authorize the script, then press Enter...");
          }
        }
        return;
      }
    }
    await gasPage.waitForTimeout(1000);
  }
}

async function dismissModals_(page) {
  for (let i = 0; i < 3; i++) {
    const modalBg = page.locator(".modal-dialog-bg").first();
    if (!(await modalBg.isVisible().catch(() => false))) break;
    const btns = await page.locator('.modal-dialog button, .modal-dialog-buttons button').all().catch(() => []);
    if (btns.length > 0) {
      await btns[btns.length - 1].click().catch(() => {});
      await page.waitForTimeout(1000);
      continue;
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1000);
  }
}

async function ensureGoogleAuthenticated_(page) {
  const url = String(page.url() || "").toLowerCase();
  const hasLogin = (await page.locator("input[type='email'], input[type='password']").count().catch(() => 0)) > 0;
  if (url.includes("accounts.google.com") || hasLogin) {
    console.log("Google login required. Complete it in the browser.");
    await waitForEnter_("Press Enter after login...");
    await page.waitForLoadState("domcontentloaded", { timeout: 120000 }).catch(() => {});
    await page.waitForTimeout(3000);
  }
}

async function copyToClipboard_(text) {
  await new Promise((resolve, reject) => {
    const child = spawn("pbcopy");
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`pbcopy: ${code}`))));
    child.stdin.end(text, "utf8");
  });
}

async function bringBrowserToFront_() {
  for (const app of ["Google Chrome", "Google Chrome for Testing", "Chromium"]) {
    try { await execFile("osascript", ["-e", `tell application "${app}" to activate`]); return; } catch (_e) {}
  }
}

async function waitForEnter_(msg) {
  const rl = readline.createInterface({ input, output });
  await rl.question(`${msg}\n`);
  rl.close();
}
