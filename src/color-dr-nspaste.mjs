import fs from "node:fs/promises";
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
  console.log("[info] Using macOS NSPasteboard for HTML clipboard");

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

    // Step 2: Copy DR values (D2:F2001) from sheet
    console.log("[step 2/5] Copying DR data from sheet...");
    const nameBox = page.locator("input.waffle-name-box").first();
    await nameBox.waitFor({ state: "visible", timeout: 30000 });
    await nameBox.click();
    await nameBox.fill("D2:F2001");
    await nameBox.press("Enter");
    await page.waitForTimeout(500);

    const mod = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${mod}+C`);
    await page.waitForTimeout(2000);

    const clipText = execFileSync("pbpaste", { encoding: "utf8" });
    const lines = clipText.split("\n").filter((l) => l.trim());
    console.log(`[info] Copied ${lines.length} rows of DR data.`);
    if (!lines.length) throw new Error("No data copied.");

    // Step 3: Build colored HTML
    console.log("[step 3/5] Building colored HTML...");
    const htmlRows = lines.map((line) => {
      const parts = line.split("\t");
      const cells = parts.map((val) => {
        const v = String(val || "").trim();
        return `<td style="background:${drColor_(v)};font-weight:700;text-align:right;border:1px solid #d9d9d9;padding:8px 10px;white-space:nowrap">${escapeHtml_(v)}</td>`;
      });
      return `<tr>${cells.join("")}</tr>`;
    }).join("");

    const htmlDoc = `<!doctype html><html><head><meta charset="utf-8">
<style>body{margin:0;padding:16px;font-family:Arial,sans-serif;background:#fff}table{border-collapse:collapse;font-size:14px}th,td{border:1px solid #d9d9d9;padding:8px 10px;white-space:nowrap}</style>
</head><body><table><thead><tr><th>DR1</th><th>DR2</th><th>DR3</th></tr></thead><tbody>${htmlRows}</tbody></table></body></html>`;

    const tsvLines = ["DR1\tDR2\tDR3", ...lines.map((l) => l.split("\t").map((v) => v.trim()).join("\t"))];
    const tsvText = tsvLines.join("\n");

    // Step 4: Write to macOS system clipboard via NSPasteboard (JXA)
    console.log("[step 4/5] Writing HTML to macOS system clipboard...");
    const htmlPath = "/tmp/dr_colored.html";
    const tsvPath = "/tmp/dr_colored.tsv";
    await fs.writeFile(htmlPath, htmlDoc, "utf8");
    await fs.writeFile(tsvPath, tsvText, "utf8");

    const jxaScript = `
      ObjC.import('AppKit');
      ObjC.import('Foundation');
      var htmlData = $.NSData.dataWithContentsOfFile('${htmlPath}');
      var tsvData = $.NSData.dataWithContentsOfFile('${tsvPath}');
      var pb = $.NSPasteboard.generalPasteboard;
      pb.clearContents;
      pb.setDataForType(htmlData, 'public.html');
      pb.setDataForType(tsvData, 'public.utf8-plain-text');
      var types = pb.types.js.map(function(t){return t.js});
      types.join(',');
    `;
    const jxaResult = execFileSync("osascript", ["-l", "JavaScript", "-e", jxaScript], { encoding: "utf8" });
    console.log(`[info] NSPasteboard types: ${jxaResult.trim()}`);

    // Step 5: Paste into D1 of the sheet
    console.log("[step 5/5] Pasting from D1...");
    await nameBox.click();
    await nameBox.fill("D1");
    await nameBox.press("Enter");
    await page.waitForTimeout(500);

    // Bring browser to front (important for system clipboard access)
    await bringBrowserToFront_();
    await page.waitForTimeout(500);

    await page.keyboard.press(`${mod}+V`);
    console.log("[info] Paste sent, waiting...");
    await page.waitForTimeout(10000);

    // Verify with screenshot
    await page.screenshot({ path: "/tmp/diet1_nspaste.png" });
    console.log("[info] Screenshot saved to /tmp/diet1_nspaste.png");

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
  const r = Math.round(252 + (244 - 252) * ratio);
  const g = Math.round(243 + (177 - 243) * ratio);
  const b = Math.round(232 + (88 - 232) * ratio);
  return `rgb(${r}, ${g}, ${b})`;
}

function escapeHtml_(v) {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
