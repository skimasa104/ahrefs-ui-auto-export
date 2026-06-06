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
  const tabName = String(process.argv[4] || process.env.GOOGLE_SHEET_TAB_NAME || "").trim();

  if (!sheetUrl) throw new Error("Usage: node paste-with-checkbox.mjs <sheetUrl> <csvPath> <tabName>");
  if (!csvPath || !existsSync(csvPath)) throw new Error(`CSV not found: ${csvPath}`);
  if (!tabName) throw new Error("Tab name is required (arg3 or GOOGLE_SHEET_TAB_NAME).");

  const csvText = await fs.readFile(csvPath, "utf8");
  const records = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    relax_quotes: true,
    relax_column_count: true
  });
  if (!records.length) throw new Error(`CSV is empty: ${csvPath}`);

  const headers = Object.keys(records[0]);
  const rowCount = records.length;

  // Build TSV with checkbox column prepended
  const tsvLines = [];
  tsvLines.push(["", ...headers].join("\t"));
  for (const row of records) {
    const dr1 = Number(row.DR1 ?? row.dr1 ?? Infinity);
    const dr2 = Number(row.DR2 ?? row.dr2 ?? Infinity);
    const dr3 = Number(row.DR3 ?? row.dr3 ?? Infinity);
    const shouldCheck = dr1 <= DR_THRESHOLD || dr2 <= DR_THRESHOLD || dr3 <= DR_THRESHOLD;
    const cells = [shouldCheck ? "TRUE" : "FALSE", ...headers.map((h) => sanitize_(row[h]))];
    tsvLines.push(cells.join("\t"));
  }
  const tsvText = tsvLines.join("\n");
  const htmlText = buildHtmlWithCheckbox_(headers, records);

  console.log(`[info] CSV: ${csvPath}`);
  console.log(`[info] Tab: ${tabName}`);
  console.log(`[info] Rows: ${rowCount}`);
  console.log(`[info] DR threshold: <= ${DR_THRESHOLD}`);

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

    // Dismiss any initial modals
    await dismissModals_(page);

    // --- Step 1 & 2: Find or create tab ---
    const existingTab = page
      .locator(".docs-sheet-tab-name")
      .filter({ hasText: new RegExp(`^${escapeRegex_(tabName)}$`) })
      .first();
    const tabExists = await existingTab.isVisible().catch(() => false);

    if (tabExists) {
      console.log("[step 1/4] Tab already exists, navigating to:", tabName);
      await existingTab.click();
      await page.waitForTimeout(2000);
      await dismissModals_(page);
      console.log("[step 2/4] Using existing tab.");
    } else {
      console.log("[step 1/4] Creating new tab...");
      const beforeCount = await page.locator(".docs-sheet-tab").count().catch(() => 0);
      const addBtn = await findAddSheetButton_(page);
      if (!addBtn) throw new Error("Add sheet button not found.");
      await addBtn.click();
      await waitForSheetCountIncrease_(page, beforeCount);
      await page.waitForTimeout(1500);

      console.log("[step 2/4] Renaming tab to:", tabName);
      await renameActiveSheet_(page, tabName);
      await page.waitForTimeout(1000);
    }

    // --- Step 3: Paste data ---
    console.log("[step 3/4] Pasting data...");
    await dismissModals_(page);
    await focusGridCellA1_(page);
    const pastedViaEvent = await pasteStructuredData_(page, { tsvText, htmlText });
    let pasteMode = "structured_event";
    if (!pastedViaEvent) {
      const richCopied = await copyHtmlTableToClipboard_(context, htmlText);
      if (!richCopied) {
        await copyTextToClipboard_(tsvText);
      }
      await pasteIntoA1_(page);
      pasteMode = richCopied ? "rich_html" : "plain_tsv";
    }
    await page.waitForTimeout(4000);
    console.log(`[info] paste_mode: ${pasteMode}`);

    // --- Step 4: Apply checkbox to column A ---
    console.log("[step 4/4] Applying checkboxes to column A...");
    await applyCheckboxToColumnA_(page, rowCount);

    const activeSheetName = await page
      .locator(".docs-sheet-active-tab .docs-sheet-tab-name")
      .first()
      .innerText()
      .catch(() => tabName);

    console.log("[ok] Done!");
    console.log(`sheet_url: ${sheetUrl}`);
    console.log(`csv: ${csvPath}`);
    console.log(`sheet_tab: ${String(activeSheetName || "").trim()}`);
    console.log(`rows: ${rowCount}`);
    console.log(`paste_mode: ${pasteMode}`);
  } finally {
    await context.close();
  }
}

// ── Apply checkbox data validation to A2:A(rowCount+1) ──

async function applyCheckboxToColumnA_(page, rowCount) {
  // Select A2:A(lastRow) via name box
  const nameBox = page.locator("input.waffle-name-box").first();
  await nameBox.waitFor({ state: "visible", timeout: 30000 });
  await nameBox.click();
  await page.waitForTimeout(300);
  await nameBox.fill(`A2:A${rowCount + 1}`);
  await nameBox.press("Enter");
  await page.waitForTimeout(1000);

  // Try Insert > Checkbox via menu
  const inserted = await tryInsertCheckboxMenu_(page);
  if (inserted) {
    console.log("[info] Checkboxes applied via Insert menu.");
    return;
  }

  // Fallback: try Data > Data validation
  const validated = await tryDataValidationCheckbox_(page, rowCount);
  if (validated) {
    console.log("[info] Checkboxes applied via Data validation.");
    return;
  }

  console.log("[warn] Could not apply checkbox formatting automatically.");
  console.log("[warn] Please manually: select A2:A" + (rowCount + 1) + " -> Insert -> Checkbox");
}

async function tryInsertCheckboxMenu_(page) {
  try {
    // Click Insert menu (Japanese: 挿入, English: Insert)
    const insertMenu = page.locator("#docs-insert-menu").first();
    if (!(await insertMenu.isVisible().catch(() => false))) {
      // Fallback: text-based selector
      const menuBar = page.locator('.menu-button, [role="menuitem"]');
      const all = await menuBar.all();
      for (const el of all) {
        const text = (await el.innerText().catch(() => "")).trim();
        if (text === "挿入" || text === "Insert") {
          await el.click();
          break;
        }
      }
    } else {
      await insertMenu.click();
    }
    await page.waitForTimeout(800);

    // Click Checkbox item
    const menuItems = page.locator('[role="menuitem"], .goog-menuitem');
    const allItems = await menuItems.all();
    for (const item of allItems) {
      const text = (await item.innerText().catch(() => "")).trim();
      if (text === "チェックボックス" || text === "Checkbox" || text === "Tick box") {
        await item.click();
        await page.waitForTimeout(2000);
        return true;
      }
    }

    // Close menu if checkbox item not found
    await page.keyboard.press("Escape");
    return false;
  } catch (_err) {
    await page.keyboard.press("Escape").catch(() => {});
    return false;
  }
}

async function tryDataValidationCheckbox_(page, rowCount) {
  try {
    // Re-select A2:A(lastRow) in case the selection was lost
    const nameBox = page.locator("input.waffle-name-box").first();
    await nameBox.click();
    await page.waitForTimeout(300);
    await nameBox.fill(`A2:A${rowCount + 1}`);
    await nameBox.press("Enter");
    await page.waitForTimeout(1000);

    // Click Data menu
    const dataMenu = page.locator("#docs-data-menu").first();
    if (await dataMenu.isVisible().catch(() => false)) {
      await dataMenu.click();
    } else {
      const menuBar = page.locator('.menu-button, [role="menuitem"]');
      const all = await menuBar.all();
      for (const el of all) {
        const text = (await el.innerText().catch(() => "")).trim();
        if (text === "データ" || text === "Data") {
          await el.click();
          break;
        }
      }
    }
    await page.waitForTimeout(800);

    // Click Data validation
    const menuItems = page.locator('[role="menuitem"], .goog-menuitem');
    const allItems = await menuItems.all();
    for (const item of allItems) {
      const text = (await item.innerText().catch(() => "")).trim();
      if (
        text.includes("データの入力規則") ||
        text.includes("Data validation") ||
        text.includes("データ検証")
      ) {
        await item.click();
        break;
      }
    }
    await page.waitForTimeout(2000);

    // In the sidebar, click "Add rule" / "ルールを追加"
    const addRuleBtn = page
      .locator('button, [role="button"]')
      .filter({ hasText: /ルールを追加|Add rule/i })
      .first();
    if (await addRuleBtn.isVisible().catch(() => false)) {
      await addRuleBtn.click();
      await page.waitForTimeout(1500);
    }

    // Select criteria dropdown and choose Checkbox
    const criteriaDropdown = page
      .locator('[data-value], select, [role="listbox"], [role="combobox"]')
      .first();
    if (await criteriaDropdown.isVisible().catch(() => false)) {
      await criteriaDropdown.click();
      await page.waitForTimeout(500);

      const options = page.locator('[role="option"], [role="menuitemradio"], .goog-menuitem');
      const allOptions = await options.all();
      for (const opt of allOptions) {
        const text = (await opt.innerText().catch(() => "")).trim();
        if (text === "チェックボックス" || text === "Checkbox" || text === "Tick box") {
          await opt.click();
          await page.waitForTimeout(500);
          break;
        }
      }
    }

    // Click Done / 完了
    const doneBtn = page
      .locator('button, [role="button"]')
      .filter({ hasText: /^完了$|^Done$|^Save$|^保存$/i })
      .first();
    if (await doneBtn.isVisible().catch(() => false)) {
      await doneBtn.click();
      await page.waitForTimeout(2000);
      return true;
    }

    return false;
  } catch (_err) {
    await page.keyboard.press("Escape").catch(() => {});
    return false;
  }
}

// ── Modal dismissal ──

async function dismissModals_(page) {
  // Dismiss any modal dialogs that might be blocking interaction
  for (let i = 0; i < 3; i++) {
    const modalBg = page.locator(".modal-dialog-bg").first();
    if (!(await modalBg.isVisible().catch(() => false))) break;

    // Try clicking OK / Got it / Close buttons in the dialog
    const dialogBtns = page.locator(
      '.modal-dialog button, .modal-dialog [role="button"], .modal-dialog-buttons button'
    );
    const allBtns = await dialogBtns.all().catch(() => []);
    if (allBtns.length > 0) {
      // Click the last button (usually OK/Close/Got it)
      await allBtns[allBtns.length - 1].click().catch(() => {});
      await page.waitForTimeout(1000);
      continue;
    }

    // Fallback: press Escape
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1000);
  }
}

// ── Paste helpers ──

async function focusGridCellA1_(page) {
  const nameBox = page.locator("input.waffle-name-box").first();
  await nameBox.waitFor({ state: "visible", timeout: 30000 });
  await nameBox.click();
  await nameBox.fill("A1");
  await nameBox.press("Enter");
  await page.waitForTimeout(800);

  // Try multiple grid container selectors
  const gridSelectors = [
    ".waffle-background-container",
    ".grid-container",
    "#waffle-grid-container",
    ".native-scrollbar"
  ];
  for (const selector of gridSelectors) {
    const grid = page.locator(selector).first();
    if (await grid.isVisible().catch(() => false)) {
      const box = await grid.boundingBox();
      if (box) {
        await page.mouse.click(box.x + 40, box.y + 20);
        await page.waitForTimeout(300);
        return;
      }
    }
  }

  // Fallback: click at a fixed offset from the name box area (below the toolbar)
  console.log("[info] Grid container not found, using coordinate fallback");
  await page.mouse.click(180, 250);
  await page.waitForTimeout(300);
}

async function pasteStructuredData_(page, { tsvText, htmlText }) {
  try {
    const headerLine = String(tsvText || "").split(/\r?\n/)[0] || "";
    const expectedMarker = String(headerLine.split("\t")[1] || "").trim(); // skip checkbox col
    const result = await page.evaluate(
      async ({ plain, html, expectedMarker }) => {
        const target = document.activeElement;
        if (!target) return { dispatched: false, hasHeader: false };
        const data = new DataTransfer();
        data.setData("text/plain", plain);
        if (html) data.setData("text/html", html);
        const evt = new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true
        });
        target.dispatchEvent(evt);
        await new Promise((r) => setTimeout(r, 1200));
        const bodyText = document.body?.innerText || "";
        return {
          dispatched: true,
          hasHeader: expectedMarker ? bodyText.includes(expectedMarker) : false
        };
      },
      { plain: tsvText, html: htmlText, expectedMarker }
    );
    return Boolean(result?.dispatched && result?.hasHeader);
  } catch (_e) {
    return false;
  }
}

async function copyHtmlTableToClipboard_(context, htmlText) {
  const page = await context.newPage();
  try {
    await page.setContent(htmlText, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);
    const copied = await page.evaluate(async () => {
      const table = document.querySelector("table");
      if (!table) return false;
      const selection = window.getSelection();
      selection?.removeAllRanges();
      const range = document.createRange();
      range.selectNode(table);
      selection?.addRange(range);
      try {
        document.execCommand("copy");
        return true;
      } catch (_e) {
        return false;
      }
    });
    return copied;
  } finally {
    await page.close().catch(() => {});
  }
}

async function copyTextToClipboard_(text) {
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

async function pasteIntoA1_(page) {
  const nameBox = page.locator("input.waffle-name-box").first();
  await nameBox.click();
  await nameBox.fill("A1");
  await nameBox.press("Enter");
  await page.waitForTimeout(500);
  await page.mouse.click(180, 190);
  await page.waitForTimeout(300);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
}

// ── Tab management helpers ──

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

async function findAddSheetButton_(page) {
  const candidates = [
    page.locator("[aria-label='シートを追加']").first(),
    page.locator("[aria-label='Add sheet']").first(),
    page.locator("div[role='button']:has-text('追加')").first()
  ];
  for (const loc of candidates) {
    if (await loc.isVisible().catch(() => false)) return loc;
  }
  return null;
}

async function waitForSheetCountIncrease_(page, beforeCount) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const count = await page.locator(".docs-sheet-tab").count().catch(() => 0);
    if (count > beforeCount) return;
    await page.waitForTimeout(500);
  }
  throw new Error("Timed out waiting for new sheet tab.");
}

async function renameActiveSheet_(page, name) {
  const activeTab = page.locator(".docs-sheet-active-tab").first();
  await activeTab.waitFor({ state: "visible", timeout: 30000 });
  await activeTab.dblclick();
  await page.waitForTimeout(500);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await page.keyboard.type(name);
  await page.keyboard.press("Enter");

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const current = await page
      .locator(".docs-sheet-active-tab .docs-sheet-tab-name")
      .first()
      .innerText()
      .catch(() => "");
    if (String(current || "").trim() === name) return;
    await page.waitForTimeout(300);
  }
  throw new Error(`Timed out renaming tab to: ${name}`);
}

// ── HTML builder ──

function buildHtmlWithCheckbox_(headers, records) {
  const allHeaders = ["", ...headers];
  const head = allHeaders.map((h) => `<th>${escapeHtml_(h)}</th>`).join("");
  const body = records
    .map((row) => {
      const dr1 = Number(row.DR1 ?? row.dr1 ?? Infinity);
      const dr2 = Number(row.DR2 ?? row.dr2 ?? Infinity);
      const dr3 = Number(row.DR3 ?? row.dr3 ?? Infinity);
      const shouldCheck = dr1 <= DR_THRESHOLD || dr2 <= DR_THRESHOLD || dr3 <= DR_THRESHOLD;
      const checkboxCell = `<td>${shouldCheck ? "TRUE" : "FALSE"}</td>`;

      const dataCells = headers.map((h) => {
        const raw = sanitize_(row[h]);
        const style = cellStyle_(h, raw);
        const rendered = /^url\d$/i.test(h)
          ? `<a href="${escapeAttr_(raw)}">${escapeHtml_(raw)}</a>`
          : escapeHtml_(raw);
        return `<td style="${style}">${rendered}</td>`;
      });
      return `<tr>${checkboxCell}${dataCells.join("")}</tr>`;
    })
    .join("");

  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <style>
      body { margin: 0; padding: 16px; font-family: Arial, sans-serif; background: #fff; }
      table { border-collapse: collapse; font-size: 14px; }
      th, td {
        border: 1px solid #d9d9d9;
        padding: 8px 10px;
        text-align: left;
        vertical-align: middle;
        white-space: nowrap;
      }
      th { background: #fff; font-weight: 700; }
      a { color: #1155cc; text-decoration: underline; }
    </style>
  </head>
  <body>
    <table>
      <thead><tr>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table>
  </body>
</html>`;
}

// ── Utilities ──

function sanitize_(value) {
  return String(value ?? "")
    .replace(/\t/g, " ")
    .replace(/\r?\n/g, " ")
    .trim();
}

function escapeHtml_(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr_(value) {
  return escapeHtml_(value).replace(/'/g, "&#39;");
}

function cellStyle_(header, value) {
  const base = ["border:1px solid #d9d9d9", "padding:8px 10px", "white-space:nowrap"];
  if (/^dr\d$/i.test(header)) {
    base.push(`background:${drColor_(value)}`);
    base.push("font-weight:700");
    base.push("text-align:right");
  }
  return base.join(";");
}

function drColor_(value) {
  const n = Number(String(value || "").trim());
  if (!Number.isFinite(n)) return "#ffffff";
  const clamped = Math.max(1, Math.min(100, n));
  const ratio = clamped / 100;
  const from = { r: 252, g: 243, b: 232 };
  const to = { r: 244, g: 177, b: 88 };
  const r = Math.round(from.r + (to.r - from.r) * ratio);
  const g = Math.round(from.g + (to.g - from.g) * ratio);
  const b = Math.round(from.b + (to.b - from.b) * ratio);
  return `rgb(${r}, ${g}, ${b})`;
}

async function bringBrowserToFront_() {
  const scripts = [
    'tell application "Google Chrome" to activate',
    'tell application "Google Chrome for Testing" to activate',
    'tell application "Chromium" to activate'
  ];
  for (const script of scripts) {
    try {
      await execFile("osascript", ["-e", script]);
      return;
    } catch (_e) {}
  }
}

function escapeRegex_(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function waitForEnter_(message) {
  const rl = readline.createInterface({ input, output });
  await rl.question(`${message}\n`);
  rl.close();
}
