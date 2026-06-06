import path from "node:path";
import process from "node:process";
import { execFileSync, spawn, execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "playwright";

const execFile = promisify(execFileCallback);
const PROFILE_DIR = path.resolve(process.cwd(), process.env.GOOGLE_PROFILE_DIR || ".google-profile");
const SHEET_URL = "https://docs.google.com/spreadsheets/d/1YR6QRThkpiGUlC7WnrizyI_w2qyIGxPnYPZk3VmPlRs/edit";
const DR_THRESHOLD = 40;
const mod = process.platform === "darwin" ? "Meta" : "Control";

main().catch(e => { console.error("[fatal]", e?.message || e); process.exit(1); });

async function main() {
  const srcTab = process.argv[2] || "ダイエット１";
  const newTab = process.argv[3] || "ダイエット1_colored";

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false, viewport: { width: 1440, height: 1000 },
    args: ["--disable-blink-features=AutomationControlled"]
  });

  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(SHEET_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForTimeout(5000);
    await killDialogs_(page);
    await bringFront_();

    const nb = page.locator("input.waffle-name-box").first();

    // ── 1. コピー元タブのデータ取得 ──
    console.log(`[1/5] ${srcTab} からデータコピー...`);
    await clickTab_(page, srcTab);
    await killDialogs_(page);
    await nb.click(); await nb.fill("B1:I2001"); await nb.press("Enter");
    await page.waitForTimeout(500);
    await page.keyboard.press(`${mod}+C`);
    await page.waitForTimeout(3000);
    const raw = execFileSync("pbpaste", { encoding: "utf8" });
    const lines = raw.split("\n").filter(l => l.trim());
    if (lines.length < 2) throw new Error("データ不足");
    const headers = lines[0].split("\t");
    const rows = lines.slice(1).map(l => l.split("\t"));
    console.log(`[info] ${rows.length} 行, ヘッダー: ${headers.join(", ")}`);

    // ── 2. 新タブ作成 ──
    console.log(`[2/5] 新タブ "${newTab}" 作成...`);
    await killDialogs_(page);
    const addBtn = page.locator("[aria-label='シートを追加'],[aria-label='Add sheet']").first();
    await addBtn.click();
    await page.waitForTimeout(2000);
    await killDialogs_(page);

    // リネーム
    const at = page.locator(".docs-sheet-active-tab").first();
    await at.dblclick(); await page.waitForTimeout(500);
    await page.keyboard.press(`${mod}+A`);
    await page.keyboard.type(newTab);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2000);
    await killDialogs_(page);

    // ── 3. 色付き HTML 構築 ──
    console.log("[3/5] HTML構築...");
    const drI = { DR1: headers.indexOf("DR1"), DR2: headers.indexOf("DR2"), DR3: headers.indexOf("DR3") };
    const allH = ["", ...headers];
    const headH = allH.map(h => `<th>${esc_(h)}</th>`).join("");
    const bodyH = rows.map(parts => {
      const d1 = Number(parts[drI.DR1]||Infinity), d2 = Number(parts[drI.DR2]||Infinity), d3 = Number(parts[drI.DR3]||Infinity);
      const chk = d1<=DR_THRESHOLD||d2<=DR_THRESHOLD||d3<=DR_THRESHOLD;
      const cc = `<td>${chk?"TRUE":"FALSE"}</td>`;
      const dc = headers.map((h,i) => {
        const v = String(parts[i]||"").trim();
        const st = /^dr\d$/i.test(h) ? `background:${drCol_(v)};font-weight:700;text-align:right;` : "";
        const inner = /^url\d$/i.test(h) ? `<a href="${esc_(v)}">${esc_(v)}</a>` : esc_(v);
        return `<td style="${st}border:1px solid #d9d9d9;padding:8px 10px;white-space:nowrap">${inner}</td>`;
      }).join("");
      return `<tr>${cc}${dc}</tr>`;
    }).join("");

    const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<style>body{margin:0;padding:16px;font-family:Arial,sans-serif;background:#fff}
table{border-collapse:collapse;font-size:14px}
th,td{border:1px solid #d9d9d9;padding:8px 10px;white-space:nowrap}
th{background:#fff;font-weight:700}a{color:#1155cc;text-decoration:underline}</style>
</head><body><table><thead><tr>${headH}</tr></thead><tbody>${bodyH}</tbody></table></body></html>`;

    // ── 4. ヘルパーページ経由でコピー → ペースト ──
    console.log("[4/5] ペースト...");
    const hp = await ctx.newPage();
    await hp.setContent(html, { waitUntil: "domcontentloaded" });
    await hp.waitForTimeout(1000);
    await hp.evaluate(() => {
      const t = document.querySelector("table"); if(!t) return;
      const s = window.getSelection(); s?.removeAllRanges();
      const r = document.createRange(); r.selectNode(t); s?.addRange(r);
      document.execCommand("copy");
    });
    await hp.close();

    await killDialogs_(page);
    await nb.click(); await nb.fill("A1"); await nb.press("Enter");
    await page.waitForTimeout(500);
    // グリッドクリック
    for (const sel of [".waffle-background-container",".grid-container"]) {
      const g = page.locator(sel).first();
      if (await g.isVisible().catch(()=>false)) {
        const b = await g.boundingBox();
        if (b) { await page.mouse.click(b.x+40, b.y+20); break; }
      }
    }
    await page.waitForTimeout(300);
    await page.keyboard.press(`${mod}+V`);
    console.log("[info] ペースト待ち...");
    await page.waitForTimeout(8000);

    // ── 5. チェックボックス ──
    console.log("[5/5] チェックボックス...");
    await killDialogs_(page);
    await nb.click(); await nb.fill(`A2:A${rows.length+1}`); await nb.press("Enter");
    await page.waitForTimeout(1000);
    // 挿入 → チェックボックス
    const insertMenu = page.locator('#docs-insert-menu').first();
    await insertMenu.click();
    await page.waitForTimeout(800);
    for (const item of await page.locator('[role="menuitem"]').all()) {
      const t = (await item.innerText().catch(()=>"")).trim();
      if (t==="チェックボックス"||t==="Checkbox") { await item.click(); break; }
    }
    await page.waitForTimeout(2000);

    // スクショ
    await nb.click(); await nb.fill("A1"); await nb.press("Enter");
    await page.waitForTimeout(1000);
    await page.screenshot({ path: "/tmp/diet1_colored_final.png" });
    console.log("[screenshot] /tmp/diet1_colored_final.png");
    console.log("[done]");
  } finally {
    await ctx.close();
  }
}

async function clickTab_(page, name) {
  const t = page.locator(".docs-sheet-tab-name").filter({hasText:new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}$`)}).first();
  if (await t.isVisible().catch(()=>false)) { await t.click(); await page.waitForTimeout(2000); }
}

async function killDialogs_(page) {
  for (let i = 0; i < 5; i++) {
    const bg = page.locator(".modal-dialog-bg").first();
    if (!(await bg.isVisible().catch(() => false))) return;
    // OKボタン、はい、閉じる等を探す
    for (const txt of ["OK", "はい", "閉じる", "Close", "Got it"]) {
      const btn = page.locator(`button:has-text("${txt}")`).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(1000);
        break;
      }
    }
    // フォールバック: ダイアログ内の最後のボタン
    const btns = await page.locator('.modal-dialog button, .modal-dialog-buttons button').all().catch(() => []);
    for (const b of btns) { await b.click().catch(() => {}); }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  }
}

function drCol_(v) {
  const n = Number(String(v||"").trim());
  if (!Number.isFinite(n)) return "#ffffff";
  const c = Math.max(1,Math.min(100,n)), r = c/100;
  return `rgb(${Math.round(252-8*r)},${Math.round(243-66*r)},${Math.round(232-144*r)})`;
}
function esc_(v){return String(v??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
async function bringFront_(){
  for(const a of["Google Chrome","Google Chrome for Testing","Chromium"])
    try{await execFile("osascript",["-e",`tell application "${a}" to activate`]);return;}catch(_){}
}
