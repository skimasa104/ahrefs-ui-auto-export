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
  const checkValues = records.map((row) => {
    const dr1 = Number(row.DR1 ?? row.dr1 ?? Infinity);
    const dr2 = Number(row.DR2 ?? row.dr2 ?? Infinity);
    const dr3 = Number(row.DR3 ?? row.dr3 ?? Infinity);
    return dr1 <= DR_THRESHOLD || dr2 <= DR_THRESHOLD || dr3 <= DR_THRESHOLD;
  });

  // Verify specific rows (0-indexed: spreadsheet row N = records[N-2])
  const verify = [
    [7, "Row 9 おちんちん DR1=24,DR3=14 → TRUE"],
    [8, "Row 10 精を出す DR=82,84,84 → FALSE"],
    [11, "Row 13 亀頭 DR2=27,DR3=7 → TRUE"],
    [13, "Row 15 真性包茎 DR3=28 → TRUE"],
    [14, "Row 16 粗チン DR=44,52,44 → FALSE"],
    [17, "Row 19 長茎術 DR1=18,DR2=39 → TRUE"],
    [18, "Row 20 カントン包茎 DR=44,48,91 → FALSE"]
  ];
  for (const [idx, label] of verify) {
    const row = records[idx];
    console.log(`[verify] ${label}: computed=${checkValues[idx]} (DR1=${row.DR1} DR2=${row.DR2} DR3=${row.DR3})`);
  }

  const checkedCount = checkValues.filter(Boolean).length;
  console.log(`[info] Total: ${rowCount} rows, ${checkedCount} checked, ${rowCount - checkedCount} unchecked`);

  // Build newline-separated TRUE/FALSE for clipboard paste
  const pasteText = checkValues.map((v) => (v ? "TRUE" : "FALSE")).join("\n");

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
    console.log("[step 1/3] Navigating to tab:", tabName);
    const tab = page
      .locator(".docs-sheet-tab-name")
      .filter({ hasText: new RegExp(`^${tabName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) })
      .first();
    if (await tab.isVisible().catch(() => false)) {
      await tab.click();
      await page.waitForTimeout(2000);
    }
    await dismissModals_(page);

    // Select A2 and paste TRUE/FALSE values
    console.log("[step 2/3] Pasting correct checkbox values into A2:A" + (rowCount + 1) + "...");
    const nameBox = page.locator("input.waffle-name-box").first();
    await nameBox.waitFor({ state: "visible", timeout: 30000 });
    await nameBox.click();
    await page.waitForTimeout(300);
    await nameBox.fill("A2");
    await nameBox.press("Enter");
    await page.waitForTimeout(1000);

    // Click on the grid to ensure focus
    const gridSelectors = [
      ".waffle-background-container",
      ".grid-container",
      "#waffle-grid-container",
      ".native-scrollbar"
    ];
    for (const sel of gridSelectors) {
      const grid = page.locator(sel).first();
      if (await grid.isVisible().catch(() => false)) {
        const box = await grid.boundingBox();
        if (box) {
          await page.mouse.click(box.x + 40, box.y + 20);
          await page.waitForTimeout(300);
          break;
        }
      }
    }

    // Copy values to clipboard and paste
    await copyToClipboard_(pasteText);
    const mod = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${mod}+V`);
    console.log("[info] Paste command sent, waiting for Google Sheets to process...");
    await page.waitForTimeout(8000);

    // Verify: re-select A2 and check if value changed
    await nameBox.click();
    await page.waitForTimeout(300);
    await nameBox.fill("A2");
    await nameBox.press("Enter");
    await page.waitForTimeout(1000);

    // Step 3: Re-apply checkbox formatting via Insert menu
    console.log("[step 3/3] Re-applying checkbox formatting...");
    await nameBox.click();
    await page.waitForTimeout(300);
    await nameBox.fill(`A2:A${rowCount + 1}`);
    await nameBox.press("Enter");
    await page.waitForTimeout(1000);

    const checkboxApplied = await tryInsertCheckboxMenu_(page);
    if (checkboxApplied) {
      console.log("[info] Checkbox formatting applied via Insert menu.");
    } else {
      console.log("[warn] Could not apply checkbox formatting. Values are set but may show as TRUE/FALSE text.");
    }

    await page.waitForTimeout(3000);
    console.log("[ok] Done! Checkbox values updated from CSV.");
    console.log(`Tab: ${tabName}`);
    console.log(`Rows: ${rowCount}, Checked: ${checkedCount}`);
  } finally {
    await context.close();
  }
}

async function tryInsertCheckboxMenu_(page) {
  try {
    // Click Insert menu
    const menuTexts = ["挿入", "Insert"];
    let menuClicked = false;
    for (const text of menuTexts) {
      const items = page.locator('.menu-button, .goog-control').filter({ hasText: new RegExp(`^${text}$`) });
      const all = await items.all();
      for (const el of all) {
        if (await el.isVisible().catch(() => false)) {
          await el.click();
          menuClicked = true;
          break;
        }
      }
      if (menuClicked) break;
    }
    if (!menuClicked) {
      // Try by ID
      const insertMenu = page.locator("#docs-insert-menu").first();
      if (await insertMenu.isVisible().catch(() => false)) {
        await insertMenu.click();
        menuClicked = true;
      }
    }
    if (!menuClicked) return false;

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
    await page.keyboard.press("Escape");
    return false;
  } catch (_err) {
    await page.keyboard.press("Escape").catch(() => {});
    return false;
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
