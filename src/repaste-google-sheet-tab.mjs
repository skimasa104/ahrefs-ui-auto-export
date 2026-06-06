import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";
import { parse } from "csv-parse/sync";

const ROOT_DIR = process.cwd();
const DEFAULT_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/1YR6QRThkpiGUlC7WnrizyI_w2qyIGxPnYPZk3VmPlRs/edit?usp=sharing";
const PROFILE_DIR = path.resolve(ROOT_DIR, process.env.GOOGLE_PROFILE_DIR || ".google-profile");

main().catch((error) => {
  console.error("[fatal]", error?.message || String(error));
  process.exit(1);
});

async function main() {
  const sheetUrl = String(process.argv[2] || process.env.GOOGLE_SHEET_URL || DEFAULT_SHEET_URL).trim();
  const csvPath = path.resolve(ROOT_DIR, String(process.argv[3] || "").trim());
  const tabName = String(process.argv[4] || process.env.GOOGLE_SHEET_TAB_NAME || "").trim();
  if (!sheetUrl) throw new Error("Google Sheet URL is required.");
  if (!csvPath) throw new Error("CSV path is required.");
  if (!tabName) throw new Error("Tab name is required.");

  const { tsvText, htmlText } = await buildPayloads_(csvPath);
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1440, height: 1000 },
    args: ["--disable-blink-features=AutomationControlled"]
  });

  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(sheetUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForTimeout(5000);

    const tab = page.locator(".docs-sheet-tab-name", { hasText: tabName }).first();
    await tab.click();
    await page.waitForTimeout(1000);

    const nameBox = page.locator("input.waffle-name-box").first();
    await nameBox.click();
    await nameBox.fill("A1");
    await nameBox.press("Enter");
    await page.waitForTimeout(500);

    const grid = page.locator(".waffle-background-container").first();
    const box = await grid.boundingBox();
    if (!box) throw new Error("Google Sheets grid box not found.");
    await page.mouse.click(box.x + 40, box.y + 20);
    await page.waitForTimeout(300);

    const result = await page.evaluate(
      async ({ plain, html, expectedMarker }) => {
        const target = document.activeElement;
        if (!target) {
          return { ok: false, reason: "activeElement not found" };
        }
        const data = new DataTransfer();
        data.setData("text/plain", plain);
        data.setData("text/html", html);
        const evt = new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true
        });
        target.dispatchEvent(evt);
        await new Promise((resolve) => setTimeout(resolve, 4000));
        const bodyText = document.body?.innerText || "";
        return {
          ok: expectedMarker ? bodyText.includes(expectedMarker) : false,
          reason: expectedMarker
        };
      },
      { plain: tsvText, html: htmlText, expectedMarker: "keyword" }
    );

    if (!result?.ok) {
      throw new Error(`Repaste did not appear to land in sheet: ${result?.reason || "unknown"}`);
    }

    console.log("[ok] repasted sheet tab");
    console.log(`sheet_url: ${sheetUrl}`);
    console.log(`csv: ${csvPath}`);
    console.log(`sheet_tab: ${tabName}`);
  } finally {
    await context.close();
  }
}

async function buildPayloads_(csvPath) {
  const csvText = await fs.readFile(csvPath, "utf8");
  const rows = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    relax_quotes: true,
    relax_column_count: true
  });
  if (!rows.length) {
    throw new Error(`CSV is empty: ${csvPath}`);
  }

  const headers = Object.keys(rows[0]);
  const tsvText = [headers.join("\t")]
    .concat(
      rows.map((row) => headers.map((header) => sanitize_(row[header])).join("\t"))
    )
    .join("\n");

  const head = headers.map((header) => `<th>${escapeHtml_(header)}</th>`).join("");
  const body = rows
    .map((row) => {
      const cells = headers.map((header) => {
        const raw = sanitize_(row[header]);
        const rendered = /^URL\d$/i.test(header)
          ? `<a href="${escapeAttr_(raw)}">${escapeHtml_(raw)}</a>`
          : escapeHtml_(raw);
        return `<td style="${cellStyle_(header, raw)}">${rendered}</td>`;
      });
      return `<tr>${cells.join("")}</tr>`;
    })
    .join("");

  const htmlText = `<!doctype html>
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

  return { tsvText, htmlText };
}

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
  if (/^DR\d$/i.test(header)) {
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
