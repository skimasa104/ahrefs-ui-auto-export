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
  console.log("[info] Will color DR columns by copy → build colored HTML → paste back");

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
    await dismissModals_(page);

    // Step 2: Copy DR values from sheet
    console.log("[step 2/5] Copying DR values from sheet...");
    const nameBox = page.locator("input.waffle-name-box").first();
    await nameBox.waitFor({ state: "visible", timeout: 30000 });

    // First find the last row by selecting D1 and using Cmd+Down
    await nameBox.click();
    await nameBox.fill("D2");
    await nameBox.press("Enter");
    await page.waitForTimeout(500);

    // Select D2:F2001 (assume max 2000 data rows)
    await nameBox.click();
    await nameBox.fill("D2:F2001");
    await nameBox.press("Enter");
    await page.waitForTimeout(500);

    // Copy
    const mod = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${mod}+C`);
    await page.waitForTimeout(2000);

    // Read clipboard
    const clipText = execFileSync("pbpaste", { encoding: "utf8" });
    const lines = clipText.split("\n").filter((l) => l.trim());
    console.log(`[info] Copied ${lines.length} rows of DR data from sheet.`);

    if (lines.length === 0) {
      throw new Error("No DR data copied from sheet.");
    }

    // Step 3: Build colored HTML table
    console.log("[step 3/5] Building colored HTML...");
    const htmlRows = lines
      .map((line) => {
        const parts = line.split("\t");
        const cells = parts.map((val) => {
          const trimmed = String(val || "").trim();
          const color = drColor_(trimmed);
          return `<td style="background:${color};font-weight:bold;text-align:right;border:1px solid #d9d9d9;padding:4px 8px">${escapeHtml_(trimmed)}</td>`;
        });
        return `<tr>${cells.join("")}</tr>`;
      })
      .join("");

    const htmlTable = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  table { border-collapse: collapse; }
  td { white-space: nowrap; }
</style></head><body>
<table>${htmlRows}</table>
</body></html>`;

    // Step 4: Copy colored HTML to clipboard via helper page
    console.log("[step 4/5] Copying colored HTML to clipboard...");
    const helperPage = await context.newPage();
    await helperPage.setContent(htmlTable, { waitUntil: "domcontentloaded" });
    await helperPage.waitForTimeout(500);

    const copied = await helperPage.evaluate(async () => {
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
    await helperPage.close();

    if (!copied) {
      console.log("[warn] HTML copy failed, falling back to plain paste.");
    }

    // Step 5: Select D2 and paste colored HTML back
    console.log("[step 5/5] Pasting colored DR values back...");
    await nameBox.click();
    await nameBox.fill("D2");
    await nameBox.press("Enter");
    await page.waitForTimeout(500);

    // Click on the grid to focus
    const gridSelectors = [".waffle-background-container", ".grid-container", ".native-scrollbar"];
    for (const sel of gridSelectors) {
      const grid = page.locator(sel).first();
      if (await grid.isVisible().catch(() => false)) {
        const box = await grid.boundingBox();
        if (box) {
          await page.mouse.click(box.x + 200, box.y + 20);
          await page.waitForTimeout(300);
          break;
        }
      }
    }

    // Re-select D2 to make sure we're in the right cell
    await nameBox.click();
    await nameBox.fill("D2");
    await nameBox.press("Enter");
    await page.waitForTimeout(500);

    await page.keyboard.press(`${mod}+V`);
    console.log("[info] Paste command sent, waiting...");
    await page.waitForTimeout(8000);

    console.log("[ok] DR columns colored!");
    console.log(`Tab: ${tabName}`);
    console.log(`Rows: ${lines.length}`);
  } finally {
    await context.close();
  }
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

function escapeHtml_(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
