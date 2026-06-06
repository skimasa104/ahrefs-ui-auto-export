import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { execFileSync, spawn, execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { stdin as input, stdout as output } from "node:process";
import { chromium } from "playwright";

const execFile = promisify(execFileCallback);
const ROOT_DIR = process.cwd();
const PROFILE_DIR = path.resolve(ROOT_DIR, process.env.GOOGLE_PROFILE_DIR || ".google-profile");
const DEFAULT_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/1YR6QRThkpiGUlC7WnrizyI_w2qyIGxPnYPZk3VmPlRs/edit?usp=sharing";

main().catch((error) => {
  console.error("[fatal]", error?.message || String(error));
  process.exit(1);
});

async function main() {
  const sheetUrl = String(process.argv[2] || process.env.GOOGLE_SHEET_URL || DEFAULT_SHEET_URL).trim();
  const tabName = String(process.argv[3] || "ダイエット１").trim();

  console.log(`[info] Tab: ${tabName}`);
  console.log("[info] Will re-paste B:I with DR coloring (same method as 包茎 sheet)");

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
    console.log("[step 1/6] Navigating to tab:", tabName);
    const tab = page
      .locator(".docs-sheet-tab-name")
      .filter({ hasText: new RegExp(`^${tabName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) })
      .first();
    if (await tab.isVisible().catch(() => false)) {
      await tab.click();
      await page.waitForTimeout(2000);
    }
    await dismissModals_(page);

    // Step 2: Copy ALL data (B1:I2001) from sheet
    console.log("[step 2/6] Copying all data (B1:I2001) from sheet...");
    const nameBox = page.locator("input.waffle-name-box").first();
    await nameBox.waitFor({ state: "visible", timeout: 30000 });
    await nameBox.click();
    await nameBox.fill("B1:I2001");
    await nameBox.press("Enter");
    await page.waitForTimeout(500);

    const mod = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${mod}+C`);
    await page.waitForTimeout(3000);

    const clipText = execFileSync("pbpaste", { encoding: "utf8" });
    const lines = clipText.split("\n").filter((l) => l.trim());
    console.log(`[info] Copied ${lines.length} rows (including header).`);
    if (lines.length < 2) throw new Error("Not enough data copied.");

    // Step 3: Build colored HTML table (same format as paste-top3-dr-to-google-sheet.mjs)
    console.log("[step 3/6] Building colored HTML for all columns...");
    const headerLine = lines[0];
    const headers = headerLine.split("\t");
    console.log("[info] Headers:", headers.join(", "));

    const dataLines = lines.slice(1);
    const headHtml = headers.map((h) => `<th>${escapeHtml_(h)}</th>`).join("");
    const bodyHtml = dataLines
      .map((line) => {
        const parts = line.split("\t");
        const cells = headers.map((header, idx) => {
          const raw = String(parts[idx] || "").trim();
          const style = cellStyle_(header, raw);
          const rendered = /^url\d$/i.test(header)
            ? `<a href="${escapeAttr_(raw)}">${escapeHtml_(raw)}</a>`
            : escapeHtml_(raw);
          return `<td style="${style}">${rendered}</td>`;
        });
        return `<tr>${cells.join("")}</tr>`;
      })
      .join("");

    const htmlTable = `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <style>
      body { margin: 0; padding: 16px; font-family: Arial, sans-serif; background: #fff; }
      table { border-collapse: collapse; font-size: 14px; }
      th, td { border: 1px solid #d9d9d9; padding: 8px 10px; text-align: left; vertical-align: middle; white-space: nowrap; }
      th { background: #fff; font-weight: 700; }
      a { color: #1155cc; text-decoration: underline; }
    </style>
  </head>
  <body>
    <table>
      <thead><tr>${headHtml}</tr></thead>
      <tbody>${bodyHtml}</tbody>
    </table>
  </body>
</html>`;

    // Step 4: Copy colored HTML to clipboard via helper page
    console.log("[step 4/6] Copying colored HTML via helper page...");
    const helperPage = await context.newPage();
    await helperPage.setContent(htmlTable, { waitUntil: "domcontentloaded" });
    await helperPage.waitForTimeout(1000);

    const copied = await helperPage.evaluate(async () => {
      const table = document.querySelector("table");
      if (!table) return false;
      const sel = window.getSelection();
      sel?.removeAllRanges();
      const range = document.createRange();
      range.selectNode(table);
      sel?.addRange(range);
      try {
        document.execCommand("copy");
        return true;
      } catch (_e) {
        return false;
      }
    });
    await helperPage.close();
    console.log(`[info] Helper page copy result: ${copied}`);

    if (!copied) {
      throw new Error("Failed to copy colored HTML from helper page.");
    }

    // Step 5: Paste into B1 of the sheet
    console.log("[step 5/6] Pasting colored HTML into B1...");
    await nameBox.click();
    await nameBox.fill("B1");
    await nameBox.press("Enter");
    await page.waitForTimeout(500);

    // Click on the grid to ensure focus
    const gridSelectors = [".waffle-background-container", ".grid-container", ".native-scrollbar"];
    for (const sel of gridSelectors) {
      const grid = page.locator(sel).first();
      if (await grid.isVisible().catch(() => false)) {
        const box = await grid.boundingBox();
        if (box) {
          // Click on cell B1 area (2nd column, 1st data area)
          await page.mouse.click(box.x + 120, box.y + 10);
          await page.waitForTimeout(300);
          break;
        }
      }
    }

    // Re-select B1
    await nameBox.click();
    await nameBox.fill("B1");
    await nameBox.press("Enter");
    await page.waitForTimeout(500);

    await page.keyboard.press(`${mod}+V`);
    console.log("[info] Paste sent, waiting for Google Sheets to process...");
    await page.waitForTimeout(10000);

    // Step 6: Verify by taking a screenshot
    console.log("[step 6/6] Verifying...");
    await page.screenshot({ path: "/tmp/diet1_after_repaste.png" });
    console.log("[info] Screenshot saved to /tmp/diet1_after_repaste.png");

    console.log(`Tab: ${tabName}`);
    console.log(`Rows: ${dataLines.length}`);
  } finally {
    await context.close();
  }
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
  const r = Math.round(252 + (244 - 252) * ratio);
  const g = Math.round(243 + (177 - 243) * ratio);
  const b = Math.round(232 + (88 - 232) * ratio);
  return `rgb(${r}, ${g}, ${b})`;
}

function escapeHtml_(v) {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeAttr_(v) {
  return escapeHtml_(v).replace(/'/g, "&#39;");
}

async function dismissModals_(page) {
  for (let i = 0; i < 3; i++) {
    const modal = page.locator(".modal-dialog-bg").first();
    if (!(await modal.isVisible().catch(() => false))) break;
    const btns = await page.locator(".modal-dialog button").all().catch(() => []);
    if (btns.length > 0) await btns[btns.length - 1].click().catch(() => {});
    else await page.keyboard.press("Escape");
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
