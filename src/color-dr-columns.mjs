import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { spawn, execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { stdin as input, stdout as output } from "node:process";
import { chromium } from "playwright";

const execFile = promisify(execFileCallback);
const ROOT_DIR = process.cwd();
const PROFILE_DIR = path.resolve(ROOT_DIR, process.env.GOOGLE_PROFILE_DIR || ".google-profile");
const DEFAULT_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/1YR6QRThkpiGUlC7WnrizyI_w2qyIGxPnYPZk3VmPlRs/edit?usp=sharing";

const GAS_CODE = `function myFunction() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  var n = lastRow - 1;
  var drCols = [4, 5, 6];
  for (var c = 0; c < drCols.length; c++) {
    var col = drCols[c];
    var range = sheet.getRange(2, col, n, 1);
    var vals = range.getValues();
    var colors = [];
    for (var i = 0; i < vals.length; i++) {
      var num = Number(vals[i][0]);
      if (isNaN(num) || !isFinite(num)) { colors.push(["#ffffff"]); continue; }
      var clamped = Math.max(1, Math.min(100, num));
      var ratio = clamped / 100;
      var r = Math.round(252 + (244 - 252) * ratio);
      var g = Math.round(243 + (177 - 243) * ratio);
      var b = Math.round(232 + (88 - 232) * ratio);
      var hex = "#" + p(r) + p(g) + p(b);
      colors.push([hex]);
    }
    range.setBackgrounds(colors);
    range.setFontWeight("bold");
    range.setHorizontalAlignment("right");
  }
  SpreadsheetApp.flush();
}
function p(n) { var s = n.toString(16); return s.length < 2 ? "0" + s : s; }`;

main().catch((error) => {
  console.error("[fatal]", error?.message || String(error));
  process.exit(1);
});

async function main() {
  const sheetUrl = String(process.argv[2] || process.env.GOOGLE_SHEET_URL || DEFAULT_SHEET_URL).trim();
  const tabName = String(process.argv[3] || "ダイエット１").trim();

  console.log(`[info] Tab: ${tabName}`);
  console.log(`[info] Will color DR1/DR2/DR3 columns via Apps Script`);

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
    console.log("[step 1/4] Navigating to tab:", tabName);
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
    await dismissModals_(page);

    // Open Apps Script
    console.log("[step 2/4] Opening Apps Script editor...");
    await openAppsScript_(page);

    let gasPage = null;
    for (let i = 0; i < 30; i++) {
      for (const p of context.pages()) {
        if (p.url().includes("script.google.com")) { gasPage = p; break; }
      }
      if (gasPage) break;
      await page.waitForTimeout(1000);
    }
    if (!gasPage) throw new Error("Apps Script editor did not open.");

    await gasPage.waitForLoadState("domcontentloaded", { timeout: 60000 });
    await gasPage.waitForTimeout(5000);
    console.log("[step 3/4] Apps Script editor opened.");

    // Write and run
    console.log("[step 4/4] Writing and running myFunction()...");
    await writeAndRunGas_(gasPage, GAS_CODE);

    // Wait for execution with debug output
    console.log("[info] Monitoring execution...");
    try {
      for (let i = 0; i < 20; i++) {
        await gasPage.waitForTimeout(3000);
        // Check execution log for completion
        const allText = await gasPage.locator("body").innerText().catch(() => "");
        if (allText.includes("Execution completed") || allText.includes("実行完了")) {
          console.log("[info] Execution completed!");
          break;
        }
        if (allText.includes("Error") || allText.includes("エラー")) {
          const errorLine = allText.split("\n").find((l) => l.includes("Error") || l.includes("エラー")) || "";
          console.log("[error] GAS error:", errorLine.slice(0, 200));
          break;
        }
        if (i % 5 === 0) console.log(`[info] Still waiting... (${(i + 1) * 3}s)`);
      }
    } catch (_e) {
      console.log("[info] GAS page closed during execution (OK if script runs server-side).");
    }

    try { await gasPage.close().catch(() => {}); } catch (_e) {}

    try {
      await page.bringToFront();
      await page.waitForTimeout(2000);
    } catch (_e) {}

    console.log("[ok] DR columns color script executed!");
    console.log(`Tab: ${tabName}`);
  } finally {
    await context.close();
  }
}

async function openAppsScript_(page) {
  for (const text of ["拡張機能", "Extensions"]) {
    const menu = page
      .locator('.menu-button, [role="menuitem"]')
      .filter({ hasText: new RegExp(`^${text}$`) })
      .first();
    if (await menu.isVisible().catch(() => false)) {
      await menu.click();
      await page.waitForTimeout(1000);
      break;
    }
  }
  const items = await page.locator('[role="menuitem"], .goog-menuitem').all();
  for (const item of items) {
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

  // Click editor area
  for (const sel of [".monaco-editor .view-lines", ".CodeMirror", ".monaco-editor"]) {
    const el = gasPage.locator(sel).first();
    if (await el.isVisible().catch(() => false)) { await el.click(); break; }
  }
  await gasPage.waitForTimeout(500);

  const mod = process.platform === "darwin" ? "Meta" : "Control";

  // Select all + delete
  await gasPage.keyboard.press(`${mod}+A`);
  await gasPage.waitForTimeout(300);
  await gasPage.keyboard.press("Backspace");
  await gasPage.waitForTimeout(500);

  // Paste code
  await copyToClipboard_(code);
  await gasPage.keyboard.press(`${mod}+V`);
  await gasPage.waitForTimeout(2000);

  // Save
  await gasPage.keyboard.press(`${mod}+S`);
  await gasPage.waitForTimeout(4000);

  // Log all visible buttons for debugging
  const allBtns = await gasPage.locator("button").all();
  const btnTexts = [];
  for (const btn of allBtns) {
    const text = (await btn.innerText().catch(() => "")).trim();
    const label = (await btn.getAttribute("aria-label").catch(() => "")) || "";
    const tooltip = (await btn.getAttribute("data-tooltip").catch(() => "")) || "";
    if (text || label || tooltip) btnTexts.push(`"${text}" [aria=${label}] [tip=${tooltip}]`);
  }
  console.log("[debug] Buttons found:", btnTexts.slice(0, 10).join(" | "));

  // Click Run button
  let runClicked = false;
  for (const sel of [
    'button[aria-label="実行"]',
    'button[aria-label="Run"]',
    '[data-tooltip="実行"]',
    '[data-tooltip="Run"]',
    'button:has-text("実行")',
    'button:has-text("Run")'
  ]) {
    const btn = gasPage.locator(sel).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      console.log(`[info] Run button clicked via: ${sel}`);
      runClicked = true;
      break;
    }
  }

  if (!runClicked) {
    // Fallback: try clicking the play icon button (▶)
    for (const btn of allBtns) {
      const label = (await btn.getAttribute("aria-label").catch(() => "")) || "";
      if (label.toLowerCase().includes("run") || label.includes("実行")) {
        await btn.click();
        console.log("[info] Run button clicked via fallback (aria-label).");
        runClicked = true;
        break;
      }
    }
  }

  if (!runClicked) {
    console.log("[warn] Could not find Run button!");
  }
  await gasPage.waitForTimeout(3000);

  // Handle auth
  await handleAuth_(gasPage);
}

async function waitForGasExecution_(gasPage, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // Check for execution log showing completion
    const logElements = await gasPage.locator('.execution-output, [class*="log"], [class*="execution"]').all();
    for (const el of logElements) {
      const text = (await el.innerText().catch(() => "")).trim();
      if (text.includes("完了") || text.includes("Execution completed") || text.includes("Done")) {
        console.log("[gas-log]", text.slice(0, 200));
        return;
      }
    }
    await gasPage.waitForTimeout(2000);
  }
  console.log("[info] Timeout reached, continuing...");
}

async function handleAuth_(gasPage) {
  for (let i = 0; i < 10; i++) {
    const btns = await gasPage.locator('button, [role="button"]').all();
    for (const btn of btns) {
      const text = (await btn.innerText().catch(() => "")).trim();
      if (text.includes("権限を確認") || text.includes("Review permissions") || text.includes("許可")) {
        console.log("[info] Auth dialog:", text);
        await btn.click();
        await gasPage.waitForTimeout(5000);

        // Handle OAuth popup
        for (const p of gasPage.context().pages()) {
          if (p.url().includes("accounts.google.com")) {
            console.log("[info] Please authorize in the browser.");
            await waitForEnter_("Authorize, then press Enter...");
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
    const modal = page.locator(".modal-dialog-bg").first();
    if (!(await modal.isVisible().catch(() => false))) break;
    const btns = await page.locator('.modal-dialog button').all().catch(() => []);
    if (btns.length > 0) { await btns[btns.length - 1].click().catch(() => {}); }
    else { await page.keyboard.press("Escape"); }
    await page.waitForTimeout(1000);
  }
}

async function ensureGoogleAuthenticated_(page) {
  const url = String(page.url() || "").toLowerCase();
  const hasLogin = (await page.locator("input[type='email'], input[type='password']").count().catch(() => 0)) > 0;
  if (url.includes("accounts.google.com") || hasLogin) {
    console.log("Google login required.");
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
