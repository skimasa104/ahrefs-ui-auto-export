import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { stdin as input, stdout as output } from "node:process";
import { chromium } from "playwright";

const execFile = promisify(execFileCallback);
const ROOT_DIR = process.cwd();
const PROFILE_DIR = path.resolve(ROOT_DIR, process.env.GOOGLE_PROFILE_DIR || ".google-profile");
const DEFAULT_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/1YR6QRThkpiGUlC7WnrizyI_w2qyIGxPnYPZk3VmPlRs/edit?usp=sharing";

const GAS_CODE = `
function fixCheckboxes() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log("No data rows"); return; }

  var range = sheet.getRange(2, 1, lastRow - 1, 1);
  range.clearContent();
  range.clearDataValidations();

  // DR1=D, DR2=E, DR3=F
  var drData = sheet.getRange(2, 4, lastRow - 1, 3).getValues();
  var values = drData.map(function(row) {
    var dr1 = Number(row[0]);
    var dr2 = Number(row[1]);
    var dr3 = Number(row[2]);
    return [dr1 <= 40 || dr2 <= 40 || dr3 <= 40];
  });

  var rule = SpreadsheetApp.newDataValidation().requireCheckbox().build();
  range.setDataValidation(rule);
  range.setValues(values);
  Logger.log("Done: " + (lastRow - 1) + " rows processed");
}
`;

main().catch((error) => {
  console.error("[fatal]", error?.message || String(error));
  process.exit(1);
});

async function main() {
  const sheetUrl = String(process.argv[2] || process.env.GOOGLE_SHEET_URL || DEFAULT_SHEET_URL).trim();
  const tabName = String(process.argv[3] || "包茎").trim();

  console.log(`[info] Sheet URL: ${sheetUrl}`);
  console.log(`[info] Tab: ${tabName}`);
  console.log(`[info] Will fix checkboxes via Google Apps Script`);

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

    // Dismiss modals
    await dismissModals_(page);

    // Navigate to the target tab
    console.log("[step 1/5] Navigating to tab:", tabName);
    const tab = page
      .locator(".docs-sheet-tab-name")
      .filter({ hasText: new RegExp(`^${tabName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) })
      .first();
    if (await tab.isVisible().catch(() => false)) {
      await tab.click();
      await page.waitForTimeout(2000);
    } else {
      console.log("[warn] Tab not found, using active sheet");
    }

    // Open Extensions > Apps Script
    console.log("[step 2/5] Opening Apps Script editor...");
    await openAppsScript_(page);

    // Wait for Apps Script tab to open
    const pages = context.pages();
    let gasPage = null;
    for (let attempt = 0; attempt < 30; attempt++) {
      const allPages = context.pages();
      for (const p of allPages) {
        const url = p.url();
        if (url.includes("script.google.com")) {
          gasPage = p;
          break;
        }
      }
      if (gasPage) break;
      await page.waitForTimeout(1000);
    }

    if (!gasPage) {
      throw new Error("Apps Script editor tab did not open.");
    }

    await gasPage.waitForLoadState("domcontentloaded", { timeout: 60000 });
    await gasPage.waitForTimeout(5000);
    console.log("[step 3/5] Apps Script editor opened.");

    // Write the GAS code
    console.log("[step 4/5] Writing and running fixCheckboxes()...");
    await writeAndRunGasCode_(gasPage);

    // Wait for execution
    await gasPage.waitForTimeout(8000);

    // Close the Apps Script tab
    await gasPage.close().catch(() => {});
    console.log("[step 5/5] Apps Script tab closed.");

    // Switch back to the sheet
    await page.bringToFront();
    await page.waitForTimeout(2000);

    console.log("[ok] Checkboxes fixed via Google Apps Script!");
    console.log(`Tab: ${tabName}`);
    console.log("Logic: checked if any of DR1, DR2, DR3 <= 40");
  } finally {
    await context.close();
  }
}

async function openAppsScript_(page) {
  // Try clicking Extensions menu
  const menuTexts = ["拡張機能", "Extensions"];
  for (const text of menuTexts) {
    const menu = page.locator(`.menu-button, [role="menuitem"]`).filter({ hasText: new RegExp(`^${text}$`) }).first();
    if (await menu.isVisible().catch(() => false)) {
      await menu.click();
      await page.waitForTimeout(1000);
      break;
    }
  }

  // Click Apps Script
  const gasTexts = ["Apps Script", "Apps\xa0Script"];
  const menuItems = page.locator('[role="menuitem"], .goog-menuitem');
  const allItems = await menuItems.all();
  for (const item of allItems) {
    const text = (await item.innerText().catch(() => "")).trim();
    if (gasTexts.some((t) => text.includes(t))) {
      await item.click();
      await page.waitForTimeout(3000);
      return;
    }
  }

  throw new Error("Could not find Apps Script menu item.");
}

async function writeAndRunGasCode_(gasPage) {
  // Wait for the code editor to be ready
  await gasPage.waitForTimeout(3000);

  // The Apps Script editor uses Monaco or CodeMirror.
  // Try to select all existing code and replace it.

  // Click on the editor area first
  const editorSelectors = [
    ".monaco-editor .view-lines",
    ".CodeMirror",
    "[role='code']",
    ".monaco-editor"
  ];

  let editorClicked = false;
  for (const sel of editorSelectors) {
    const editor = gasPage.locator(sel).first();
    if (await editor.isVisible().catch(() => false)) {
      await editor.click();
      editorClicked = true;
      break;
    }
  }

  if (!editorClicked) {
    // Fallback: click at the center of the page
    await gasPage.mouse.click(700, 400);
  }
  await gasPage.waitForTimeout(500);

  // Select all existing code
  const selectAllKey = process.platform === "darwin" ? "Meta+A" : "Control+A";
  await gasPage.keyboard.press(selectAllKey);
  await gasPage.waitForTimeout(300);

  // Delete existing code
  await gasPage.keyboard.press("Backspace");
  await gasPage.waitForTimeout(500);

  // Type the new code
  // Using clipboard for speed
  await copyToClipboard_(GAS_CODE.trim());
  const pasteKey = process.platform === "darwin" ? "Meta+V" : "Control+V";
  await gasPage.keyboard.press(pasteKey);
  await gasPage.waitForTimeout(2000);

  // Save the script (Cmd+S)
  const saveKey = process.platform === "darwin" ? "Meta+S" : "Control+S";
  await gasPage.keyboard.press(saveKey);
  await gasPage.waitForTimeout(3000);

  // Click the Run button
  const runBtn = gasPage.locator('button[aria-label="Run"], button:has-text("実行"), button:has-text("Run")').first();
  if (await runBtn.isVisible().catch(() => false)) {
    await runBtn.click();
  } else {
    // Try the toolbar run button (play icon)
    const playBtn = gasPage.locator('[data-tooltip="Run"], [aria-label="Run"]').first();
    if (await playBtn.isVisible().catch(() => false)) {
      await playBtn.click();
    } else {
      // Try by icon
      const buttons = gasPage.locator("button");
      const allButtons = await buttons.all();
      for (const btn of allButtons) {
        const text = (await btn.innerText().catch(() => "")).trim();
        const label = (await btn.getAttribute("aria-label").catch(() => "")) || "";
        if (text === "実行" || text === "Run" || label.includes("Run") || label.includes("実行")) {
          await btn.click();
          break;
        }
      }
    }
  }

  await gasPage.waitForTimeout(3000);

  // Handle authorization dialog if it appears
  await handleGasAuthorization_(gasPage);

  // Wait for execution to complete
  console.log("[info] Waiting for script execution...");
  await gasPage.waitForTimeout(15000);
}

async function handleGasAuthorization_(gasPage) {
  // Check if authorization dialog appeared
  const authTexts = ["承認が必要です", "Authorization required", "Review permissions", "権限を確認"];

  for (let attempt = 0; attempt < 5; attempt++) {
    const dialogBtns = gasPage.locator('button, [role="button"]');
    const allBtns = await dialogBtns.all();
    for (const btn of allBtns) {
      const text = (await btn.innerText().catch(() => "")).trim();
      if (authTexts.some((t) => text.includes(t)) || text === "権限を確認" || text === "Review permissions") {
        console.log("[info] Authorization dialog detected, clicking:", text);
        await btn.click();
        await gasPage.waitForTimeout(3000);

        // A new window might open for Google OAuth
        const pages = gasPage.context().pages();
        for (const p of pages) {
          const url = p.url();
          if (url.includes("accounts.google.com")) {
            // Need to authorize
            console.log("[info] Google OAuth window detected. Waiting for user to authorize...");
            await waitForEnter_("Authorize the script in the browser, then press Enter...");
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

    const dialogBtns = page.locator(
      '.modal-dialog button, .modal-dialog [role="button"], .modal-dialog-buttons button'
    );
    const allBtns = await dialogBtns.all().catch(() => []);
    if (allBtns.length > 0) {
      await allBtns[allBtns.length - 1].click().catch(() => {});
      await page.waitForTimeout(1000);
      continue;
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1000);
  }
}

async function ensureGoogleAuthenticated_(page) {
  const url = String(page.url() || "").toLowerCase();
  const hasLoginFields =
    (await page.locator("input[type='email'], input[type='password']").count().catch(() => 0)) > 0;
  if (url.includes("accounts.google.com") || hasLoginFields) {
    console.log("Google login is required. Complete it in the browser.");
    await waitForEnter_("Press Enter after Google login is complete...");
    await page.waitForLoadState("domcontentloaded", { timeout: 120000 }).catch(() => {});
    await page.waitForTimeout(3000);
  }
}

async function copyToClipboard_(text) {
  const { spawn } = await import("node:child_process");
  await new Promise((resolve, reject) => {
    const child = spawn("pbcopy");
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pbcopy exited with code ${code}`));
    });
    child.stdin.end(text, "utf8");
  });
}

async function bringBrowserToFront_() {
  const scripts = [
    'tell application "Google Chrome" to activate',
    'tell application "Google Chrome for Testing" to activate',
    'tell application "Chromium" to activate'
  ];
  for (const script of scripts) {
    try { await execFile("osascript", ["-e", script]); return; } catch (_e) {}
  }
}

async function waitForEnter_(message) {
  const rl = readline.createInterface({ input, output });
  await rl.question(`${message}\n`);
  rl.close();
}
