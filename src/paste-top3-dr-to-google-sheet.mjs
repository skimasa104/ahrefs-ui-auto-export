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
import {
  OUTPUT_AHREFS_BATCH_FINAL_DIR,
  resolveLatestFileInDir_
} from "./output-paths.mjs";

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
  const csvArg = String(process.argv[3] || "").trim();
  const requestedSheetName = String(process.env.GOOGLE_SHEET_TAB_NAME || "").trim();
  const csvPath = await resolveCsvPath_(csvArg);
  if (!sheetUrl) {
    throw new Error("Google Sheet URL is required.");
  }
  if (!csvPath || !existsSync(csvPath)) {
    throw new Error(`Final CSV not found: ${csvArg || OUTPUT_AHREFS_BATCH_FINAL_DIR}`);
  }

  const { tsvText, htmlText } = await buildPastePayloads_(csvPath);
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

    const beforeCount = await page.locator(".docs-sheet-tab").count().catch(() => 0);
    const addSheetButton = await findAddSheetButton_(page);
    if (!addSheetButton) {
      throw new Error("Google Sheets add-sheet button not found.");
    }
    await addSheetButton.click();
    await waitForSheetCountIncrease_(page, beforeCount);
    await page.waitForTimeout(1500);

    if (requestedSheetName) {
      await renameActiveSheet_(page, requestedSheetName);
      await page.waitForTimeout(1000);
    }

    const activeSheetName = await page
      .locator(".docs-sheet-active-tab .docs-sheet-tab-name")
      .first()
      .innerText()
      .catch(() => "");
    const pastedViaEvent = await pasteStructuredDataIntoA1_(page, { tsvText, htmlText });
    let pasteMode = "structured_event";
    if (!pastedViaEvent) {
      const richCopied = await copyHtmlTableToClipboard_(context, htmlText);
      if (!richCopied) {
        await copyTextToClipboard_(tsvText);
      }
      await pasteIntoA1_(page);
      pasteMode = richCopied ? "rich_html" : "plain_tsv";
    }
    await page.waitForTimeout(3000);

    console.log("[ok] pasted final CSV into Google Sheet");
    console.log(`sheet_url: ${sheetUrl}`);
    console.log(`csv: ${csvPath}`);
    console.log(`sheet_tab: ${String(activeSheetName || "").trim() || "(new sheet)"}`);
    console.log(`paste_mode: ${pasteMode}`);
  } finally {
    await context.close();
  }
}

async function resolveCsvPath_(configuredPath) {
  if (configuredPath) {
    return path.resolve(ROOT_DIR, configuredPath);
  }
  return (
    (await resolveLatestFileInDir_(OUTPUT_AHREFS_BATCH_FINAL_DIR, /^rank_check_top3_dr_\d{8}_\d{6}\.csv$/i)) ||
    (await resolveLatestFileInDir_(OUTPUT_AHREFS_BATCH_FINAL_DIR, /rank_check_top3_dr.*\.csv$/i))
  );
}

async function buildPastePayloads_(csvPath) {
  const text = await fs.readFile(csvPath, "utf8");
  const records = parse(text, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    relax_quotes: true,
    relax_column_count: true
  });
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error(`CSV is empty: ${csvPath}`);
  }
  const headers = Object.keys(records[0]);
  const lines = [
    headers.join("\t"),
    ...records.map((row) =>
      headers.map((header) => sanitizeCell_(row[header])).join("\t")
    )
  ];
  return {
    tsvText: lines.join("\n"),
    htmlText: buildHtmlTable_(headers, records)
  };
}

function sanitizeCell_(value) {
  return String(value ?? "")
    .replace(/\t/g, " ")
    .replace(/\r?\n/g, " ")
    .trim();
}

async function ensureGoogleAuthenticated_(page) {
  const url = String(page.url() || "").toLowerCase();
  const hasLoginFields =
    (await page.locator("input[type='email'], input[type='password']").count().catch(() => 0)) > 0;
  const needsLogin = url.includes("accounts.google.com") || hasLoginFields;
  if (!needsLogin) return;

  console.log("Google login is required. Complete it in the browser.");
  await waitForEnter_("Press Enter after Google login is complete...");
  await page.waitForLoadState("domcontentloaded", { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(3000);
}

async function findAddSheetButton_(page) {
  const candidates = [
    page.locator("[aria-label='シートを追加']").first(),
    page.locator("[aria-label='Add sheet']").first(),
    page.locator("div[role='button']:has-text('追加')").first()
  ];
  for (const locator of candidates) {
    if (await locator.isVisible().catch(() => false)) {
      return locator;
    }
  }
  return null;
}

async function waitForSheetCountIncrease_(page, beforeCount) {
  const timeoutMs = 30000;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const count = await page.locator(".docs-sheet-tab").count().catch(() => 0);
    if (count > beforeCount) return;
    await page.waitForTimeout(500);
  }
  throw new Error("Timed out waiting for new sheet tab.");
}

async function renameActiveSheet_(page, requestedName) {
  const activeTab = page.locator(".docs-sheet-active-tab").first();
  await activeTab.waitFor({ state: "visible", timeout: 30000 });
  await activeTab.dblclick();
  await page.waitForTimeout(500);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await page.keyboard.type(requestedName);
  await page.keyboard.press("Enter");

  const timeoutMs = 15000;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const currentName = await page
      .locator(".docs-sheet-active-tab .docs-sheet-tab-name")
      .first()
      .innerText()
      .catch(() => "");
    if (String(currentName || "").trim() === requestedName) {
      return;
    }
    await page.waitForTimeout(300);
  }

  throw new Error(`Timed out renaming active Google Sheet tab to: ${requestedName}`);
}

async function selectA1_(page) {
  const nameBox = page.locator("input.waffle-name-box").first();
  await nameBox.waitFor({ state: "visible", timeout: 30000 });
  await nameBox.click();
  await nameBox.fill("A1");
  await nameBox.press("Enter");
  await page.waitForTimeout(800);
}

async function focusGridCellA1_(page) {
  await selectA1_(page);
  const grid = page.locator(".waffle-background-container").first();
  await grid.waitFor({ state: "visible", timeout: 30000 });
  const box = await grid.boundingBox();
  if (!box) {
    throw new Error("Google Sheets grid area not found.");
  }
  await page.mouse.click(box.x + 40, box.y + 20);
  await page.waitForTimeout(300);
}

async function pasteStructuredDataIntoA1_(page, { tsvText, htmlText }) {
  try {
    await focusGridCellA1_(page);
    const headerLine = String(tsvText || "").split(/\r?\n/)[0] || "";
    const expectedMarker = String(headerLine.split("\t")[0] || "").trim();
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
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const bodyText = document.body?.innerText || "";
        return {
          dispatched: true,
          hasHeader: expectedMarker ? bodyText.includes(expectedMarker) : false
        };
      },
      { plain: tsvText, html: htmlText, expectedMarker }
    );
    return Boolean(result?.dispatched && result?.hasHeader);
  } catch (_error) {
    return false;
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

async function pasteIntoA1_(page) {
  await selectA1_(page);
  await page.mouse.click(180, 190);
  await page.waitForTimeout(300);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
}

function buildHtmlTable_(headers, records) {
  const head = headers
    .map((header) => `<th>${escapeHtml_(header)}</th>`)
    .join("");
  const body = records
    .map((row) => {
      const cells = headers.map((header) => {
        const rawValue = sanitizeCell_(row[header]);
        const cellStyle = cellStyleFor_(header, rawValue);
        const rendered = /^url\d$/i.test(header)
          ? `<a href="${escapeAttribute_(rawValue)}">${escapeHtml_(rawValue)}</a>`
          : escapeHtml_(rawValue);
        return `<td style="${cellStyle}">${rendered}</td>`;
      });
      return `<tr>${cells.join("")}</tr>`;
    })
    .join("");

  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <style>
      body {
        margin: 0;
        padding: 16px;
        font-family: Arial, sans-serif;
        background: #ffffff;
      }
      table {
        border-collapse: collapse;
        font-size: 14px;
      }
      th, td {
        border: 1px solid #d9d9d9;
        padding: 8px 10px;
        text-align: left;
        vertical-align: middle;
        white-space: nowrap;
      }
      th {
        background: #ffffff;
        font-weight: 700;
      }
      a {
        color: #1155cc;
        text-decoration: underline;
      }
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

function cellStyleFor_(header, value) {
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

function escapeHtml_(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttribute_(value) {
  return escapeHtml_(value).replace(/'/g, "&#39;");
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
    } catch (_e) {
      // try next browser
    }
  }
}

async function waitForEnter_(message) {
  const rl = readline.createInterface({ input, output });
  await rl.question(`${message}\n`);
  rl.close();
}
