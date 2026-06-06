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
const DR_THRESHOLD = 40;

main().catch((e) => { console.error("[fatal]", e?.message || e); process.exit(1); });

async function main() {
  const sheetUrl = String(process.argv[2] || DEFAULT_SHEET_URL).trim();
  const tabName = String(process.argv[3] || "ダイエット１").trim();
  const mod = process.platform === "darwin" ? "Meta" : "Control";

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false, viewport: { width: 1440, height: 1000 },
    args: ["--disable-blink-features=AutomationControlled"]
  });

  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(sheetUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForTimeout(5000);
    await dismissModals_(page);
    await bringBrowserToFront_();

    const nameBox = page.locator("input.waffle-name-box").first();

    // ── 1. 既存タブのデータをコピー ──
    console.log("[1/6] 既存タブからデータをコピー...");
    const tab = page.locator(".docs-sheet-tab-name").filter({ hasText: new RegExp(`^${esc_(tabName)}$`) }).first();
    if (await tab.isVisible().catch(() => false)) await tab.click();
    await page.waitForTimeout(2000);
    await dismissModals_(page);

    await nameBox.click(); await nameBox.fill("A1:I2001"); await nameBox.press("Enter");
    await page.waitForTimeout(500);
    await page.keyboard.press(`${mod}+C`);
    await page.waitForTimeout(3000);
    const raw = execFileSync("pbpaste", { encoding: "utf8" });
    const allLines = raw.split("\n").filter(l => l.trim());
    console.log(`[info] ${allLines.length} 行コピー済み`);
    if (allLines.length < 2) throw new Error("データが足りない");

    // ヘッダーとデータを分離 (A列のチェックボックスは空文字 or TRUE/FALSE)
    const headerParts = allLines[0].split("\t");
    const dataRows = allLines.slice(1).map(l => l.split("\t"));
    // B列以降のヘッダー (keyword, volume, DR1, DR2, DR3, URL1, URL2, URL3)
    const dataHeaders = headerParts.slice(1);
    console.log(`[info] ヘッダー: ${dataHeaders.join(", ")}`);

    // ── 2. 既存タブを削除 ──
    console.log("[2/6] 既存タブを削除...");
    const activeTab = page.locator(".docs-sheet-active-tab").first();
    await activeTab.click({ button: "right" });
    await page.waitForTimeout(800);
    const deleteItem = page.locator('[role="menuitem"]').filter({ hasText: /削除|Delete/ }).first();
    if (await deleteItem.isVisible().catch(() => false)) {
      await deleteItem.click();
      await page.waitForTimeout(1000);
      // 確認ダイアログ
      const okBtn = page.locator('button').filter({ hasText: /OK|はい/ }).first();
      if (await okBtn.isVisible().catch(() => false)) await okBtn.click();
      await page.waitForTimeout(2000);
    }

    // ── 3. 新しいタブを作成してリネーム ──
    console.log("[3/6] 新しいタブ作成:", tabName);
    const beforeCount = await page.locator(".docs-sheet-tab").count().catch(() => 0);
    const addBtn = page.locator("[aria-label='シートを追加'], [aria-label='Add sheet']").first();
    await addBtn.click();
    await page.waitForTimeout(2000);

    // リネーム
    const newTab = page.locator(".docs-sheet-active-tab").first();
    await newTab.dblclick();
    await page.waitForTimeout(500);
    await page.keyboard.press(`${mod}+A`);
    await page.keyboard.type(tabName);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1500);

    await dismissModals_(page);

    // ── 4. 色付きHTMLを構築 (チェックボックス列含む) ──
    console.log("[4/6] 色付きHTML構築...");
    const allHeaders = ["", ...dataHeaders];
    const headHtml = allHeaders.map(h => `<th>${escHtml_(h)}</th>`).join("");
    const bodyHtml = dataRows.map(parts => {
      // A列: チェックボックス値を計算
      const drIdx = { DR1: dataHeaders.indexOf("DR1"), DR2: dataHeaders.indexOf("DR2"), DR3: dataHeaders.indexOf("DR3") };
      const dr1 = Number(parts[1 + drIdx.DR1] || Infinity);
      const dr2 = Number(parts[1 + drIdx.DR2] || Infinity);
      const dr3 = Number(parts[1 + drIdx.DR3] || Infinity);
      const checked = dr1 <= DR_THRESHOLD || dr2 <= DR_THRESHOLD || dr3 <= DR_THRESHOLD;
      const checkCell = `<td>${checked ? "TRUE" : "FALSE"}</td>`;

      const dataCells = dataHeaders.map((h, i) => {
        const v = String(parts[1 + i] || "").trim();
        const style = cellStyle_(h, v);
        const rendered = /^url\d$/i.test(h)
          ? `<a href="${escAttr_(v)}">${escHtml_(v)}</a>`
          : escHtml_(v);
        return `<td style="${style}">${rendered}</td>`;
      });
      return `<tr>${checkCell}${dataCells.join("")}</tr>`;
    }).join("");

    const htmlDoc = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><style>
body{margin:0;padding:16px;font-family:Arial,sans-serif;background:#fff}
table{border-collapse:collapse;font-size:14px}
th,td{border:1px solid #d9d9d9;padding:8px 10px;text-align:left;vertical-align:middle;white-space:nowrap}
th{background:#fff;font-weight:700}
a{color:#1155cc;text-decoration:underline}
</style></head><body>
<table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>
</body></html>`;

    // TSVも構築
    const tsvLines = [allHeaders.join("\t")];
    for (const parts of dataRows) {
      const drIdx = { DR1: dataHeaders.indexOf("DR1"), DR2: dataHeaders.indexOf("DR2"), DR3: dataHeaders.indexOf("DR3") };
      const dr1 = Number(parts[1 + drIdx.DR1] || Infinity);
      const dr2 = Number(parts[1 + drIdx.DR2] || Infinity);
      const dr3 = Number(parts[1 + drIdx.DR3] || Infinity);
      const checked = dr1 <= DR_THRESHOLD || dr2 <= DR_THRESHOLD || dr3 <= DR_THRESHOLD;
      tsvLines.push([checked ? "TRUE" : "FALSE", ...parts.slice(1).map(v => String(v||"").trim())].join("\t"));
    }
    const tsvText = tsvLines.join("\n");

    // ── 5. ヘルパーページからコピー → 新タブにペースト ──
    console.log("[5/6] 色付きHTMLをペースト...");
    const helper = await context.newPage();
    await helper.setContent(htmlDoc, { waitUntil: "domcontentloaded" });
    await helper.waitForTimeout(1000);
    const copied = await helper.evaluate(() => {
      const t = document.querySelector("table");
      if (!t) return false;
      const s = window.getSelection(); s?.removeAllRanges();
      const r = document.createRange(); r.selectNode(t); s?.addRange(r);
      try { document.execCommand("copy"); return true; } catch(_){return false;}
    });
    await helper.close();

    if (!copied) {
      // フォールバック: pbcopyでTSV
      console.log("[warn] HTMLコピー失敗、TSVフォールバック");
      await pbcopy_(tsvText);
    }

    // A1にフォーカスしてペースト
    await nameBox.click(); await nameBox.fill("A1"); await nameBox.press("Enter");
    await page.waitForTimeout(500);
    // グリッドクリック
    for (const sel of [".waffle-background-container",".grid-container",".native-scrollbar"]) {
      const g = page.locator(sel).first();
      if (await g.isVisible().catch(()=>false)) {
        const b = await g.boundingBox();
        if (b) { await page.mouse.click(b.x+40,b.y+20); break; }
      }
    }
    await page.waitForTimeout(300);
    await page.keyboard.press(`${mod}+V`);
    console.log("[info] ペースト送信、処理待ち...");
    await page.waitForTimeout(8000);

    // ── 6. チェックボックス適用 ──
    console.log("[6/6] チェックボックス適用...");
    await dismissModals_(page);
    await nameBox.click(); await nameBox.fill(`A2:A${dataRows.length+1}`); await nameBox.press("Enter");
    await page.waitForTimeout(1000);
    await tryInsertCheckbox_(page);
    await page.waitForTimeout(2000);

    // 検証スクリーンショット
    await nameBox.click(); await nameBox.fill("A1"); await nameBox.press("Enter");
    await page.waitForTimeout(1000);
    await page.screenshot({ path: "/tmp/diet1_recreated.png" });
    console.log("[screenshot] /tmp/diet1_recreated.png");
  } finally {
    await context.close();
  }
}

async function tryInsertCheckbox_(page) {
  for (const text of ["挿入","Insert"]) {
    const m = page.locator('.menu-button,.goog-control').filter({hasText:new RegExp(`^${text}$`)});
    for (const el of await m.all()) {
      if (await el.isVisible().catch(()=>false)) { await el.click(); break; }
    }
  }
  await page.waitForTimeout(800);
  for (const item of await page.locator('[role="menuitem"],.goog-menuitem').all()) {
    const t = (await item.innerText().catch(()=>"")).trim();
    if (t==="チェックボックス"||t==="Checkbox") { await item.click(); return true; }
  }
  await page.keyboard.press("Escape");
  return false;
}

function cellStyle_(header, value) {
  const b = ["border:1px solid #d9d9d9","padding:8px 10px","white-space:nowrap"];
  if (/^dr\d$/i.test(header)) {
    b.push(`background:${drColor_(value)}`, "font-weight:700", "text-align:right");
  }
  return b.join(";");
}
function drColor_(v) {
  const n = Number(String(v||"").trim());
  if (!Number.isFinite(n)) return "#ffffff";
  const c = Math.max(1,Math.min(100,n)), r = c/100;
  return `rgb(${Math.round(252-8*r)}, ${Math.round(243-66*r)}, ${Math.round(232-144*r)})`;
}
function escHtml_(v){return String(v??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function escAttr_(v){return escHtml_(v).replace(/'/g,"&#39;");}
function esc_(s){return s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");}
async function dismissModals_(p) {
  for(let i=0;i<3;i++){
    if(!(await p.locator(".modal-dialog-bg").first().isVisible().catch(()=>false)))break;
    const b=await p.locator('.modal-dialog button').all().catch(()=>[]);
    if(b.length)await b[b.length-1].click().catch(()=>{});else await p.keyboard.press("Escape");
    await p.waitForTimeout(1000);
  }
}
async function bringBrowserToFront_(){
  for(const a of["Google Chrome","Google Chrome for Testing","Chromium"])
    try{await execFile("osascript",["-e",`tell application "${a}" to activate`]);return;}catch(_){}
}
async function pbcopy_(text){
  await new Promise((ok,ng)=>{const c=spawn("pbcopy");c.on("error",ng);c.on("close",x=>x===0?ok():ng());c.stdin.end(text,"utf8");});
}
