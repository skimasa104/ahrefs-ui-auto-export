import path from "node:path";
import { chromium } from "playwright";

const ROOT = process.cwd();
const PROFILE_DIR = path.join(ROOT, ".jenkins-profile");
const base = process.env.JENKINS_BASE_URL || "https://jenkins2.elastic-seo.work";
const jobName = process.env.JENKINS_JOB_NAME || "KW-imp取得";
const jobUrl = `${String(base).replace(/\/+$/, "")}/job/${encodeURIComponent(jobName)}`;
const buildUrl = `${jobUrl}/build?delay=0sec`;

const context = await chromium.launchPersistentContext(PROFILE_DIR, { headless: true });
const page = context.pages()[0] || (await context.newPage());

try {
  await page.goto(buildUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForTimeout(2000);
  console.log("URL:", page.url());
  console.log("TITLE:", await page.title());

  const fields = await page.evaluate(() => {
    const results = [];
    const push = (el, tag) => {
      const style = window.getComputedStyle(el);
      const visible =
        style.display !== "none" && style.visibility !== "hidden" && el.getClientRects().length > 0;
      const label = el.id
        ? document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim() || ""
        : "";
      results.push({
        tag,
        type: el.getAttribute("type") || "",
        name: el.getAttribute("name") || "",
        id: el.id || "",
        placeholder: el.getAttribute("placeholder") || "",
        ariaLabel: el.getAttribute("aria-label") || "",
        label,
        visible
      });
    };

    for (const el of Array.from(document.querySelectorAll("textarea"))) push(el, "textarea");
    for (const el of Array.from(document.querySelectorAll("input"))) push(el, "input");
    for (const el of Array.from(document.querySelectorAll("select"))) push(el, "select");
    return results;
  });

  const buttons = await page.evaluate(() =>
    Array.from(document.querySelectorAll("button,input[type='submit']")).map((el) => {
      const style = window.getComputedStyle(el);
      const visible =
        style.display !== "none" && style.visibility !== "hidden" && el.getClientRects().length > 0;
      return {
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") || "",
        name: el.getAttribute("name") || "",
        text: (el.textContent || el.getAttribute("value") || "").trim(),
        visible
      };
    })
  );

  console.log("FIELDS:");
  console.log(JSON.stringify(fields, null, 2));
  console.log("BUTTONS:");
  console.log(JSON.stringify(buttons, null, 2));
} finally {
  await context.close();
}
