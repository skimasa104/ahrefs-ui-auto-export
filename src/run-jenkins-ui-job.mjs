import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { chromium } from "playwright";
import { OUTPUT_AHREFS_KEYWORDS_TXT_DIR, resolveLatestFileInDir_ } from "./output-paths.mjs";

const ROOT = process.cwd();
const PROFILE_DIR = path.join(ROOT, ".jenkins-profile");

await loadDotEnv_(path.join(ROOT, ".env"));

const cfg = {
  baseUrl: requiredEnv_("JENKINS_BASE_URL"),
  jobName: requiredEnv_("JENKINS_JOB_NAME"),
  jobPath: String(process.env.JENKINS_JOB_PATH || "").trim(),
  loginUrl:
    process.env.JENKINS_LOGIN_URL || `${trimSlash_(requiredEnv_("JENKINS_BASE_URL"))}/login?from=%2F`,
  uiUser: normalizeUiCred_(process.env.JENKINS_UI_USER),
  uiPassword: normalizeUiCred_(process.env.JENKINS_UI_PASSWORD),
  keywordsFile: process.env.JENKINS_KEYWORDS_FILE || OUTPUT_AHREFS_KEYWORDS_TXT_DIR,
  keywordsParam: process.env.JENKINS_KEYWORDS_PARAM || "keywords",
  headless: process.env.JENKINS_UI_HEADLESS === "1"
};

main().catch((error) => {
  console.error("[fatal]", error?.message || String(error));
  process.exit(1);
});

async function main() {
  const keywordsPath = await resolveKeywordsFilePath_(cfg.keywordsFile);
  if (!existsSync(keywordsPath)) {
    throw new Error(`Keywords file not found: ${keywordsPath}`);
  }

  const keywordsText = (await fs.readFile(keywordsPath, "utf8")).trim();
  if (!keywordsText) {
    throw new Error("Keywords file is empty.");
  }

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: cfg.headless,
    viewport: { width: 1440, height: 1000 }
  });

  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(cfg.loginUrl, { waitUntil: "domcontentloaded", timeout: 120000 });

    await loginIfNeeded_(page);
    const { jobUrl, buildPageUrl } = await resolveBuildPageUrl_(page);
    await page.goto(buildPageUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
    await ensureAuthenticated_(page);

    await fillKeywordsParameter_(page, cfg.keywordsParam, keywordsText, keywordsPath);
    await clickBuildButton_(page);

    console.log("[ok] Jenkins UI build triggered.");
    console.log(`job: ${cfg.jobName}`);
    console.log(`page: ${page.url()}`);
  } finally {
    await context.close();
  }
}

async function resolveKeywordsFilePath_(configuredPath) {
  const fullPath = path.resolve(ROOT, configuredPath);
  if (existsSync(fullPath)) {
    const stat = await fs.stat(fullPath);
    if (stat.isDirectory()) {
      const latest = await resolveLatestFileInDir_(fullPath, /\.txt$/i);
      if (!latest) throw new Error(`No .txt file found in directory: ${fullPath}`);
      return latest;
    }
    return fullPath;
  }

  const fallback = await resolveLatestFileInDir_(OUTPUT_AHREFS_KEYWORDS_TXT_DIR, /\.txt$/i);
  if (fallback) return fallback;
  return fullPath;
}

async function loginIfNeeded_(page) {
  if (!isLoginPage_(page.url())) return;

  if (cfg.uiUser && cfg.uiPassword) {
    await fillLoginForm_(page, cfg.uiUser, cfg.uiPassword);
    await waitForPostLogin_(page);
    return;
  }

  console.log("Jenkins login is required.");
  console.log("No JENKINS_UI_USER/JENKINS_UI_PASSWORD in .env, waiting for manual login.");
  await waitForEnter_("Complete login in browser, then press Enter...");
  await ensureAuthenticated_(page);
}

async function ensureAuthenticated_(page) {
  if (isLoginPage_(page.url())) {
    throw new Error("Still on login page. Check Jenkins credentials.");
  }
}

function isLoginPage_(url) {
  const u = String(url || "").toLowerCase();
  return u.includes("/login") || u.includes("signin");
}

async function fillLoginForm_(page, user, password) {
  const userField = await firstVisible_([
    page.locator("input[name='j_username']").first(),
    page.locator("input#j_username").first(),
    page.locator("input[name='username']").first(),
    page.getByPlaceholder(/username|ユーザー/i).first()
  ]);
  const passField = await firstVisible_([
    page.locator("input[name='j_password']").first(),
    page.locator("input#j_password").first(),
    page.locator("input[name='password']").first(),
    page.getByPlaceholder(/password|パスワード/i).first()
  ]);

  if (!userField || !passField) {
    throw new Error("Jenkins login fields not found.");
  }

  await userField.fill(user);
  await passField.fill(password);

  const loginButton = await firstVisible_([
    page.getByRole("button", { name: /log in|sign in|ログイン|サインイン/i }).first(),
    page.locator("button[type='submit']").first(),
    page.locator("input[type='submit']").first()
  ]);

  if (!loginButton) {
    throw new Error("Login submit button not found.");
  }

  await Promise.all([
    page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {}),
    loginButton.click()
  ]);
}

async function waitForPostLogin_(page) {
  const timeoutMs = 45000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isLoginPage_(page.url())) return;
    await sleep_(500);
  }

  const message = await readLoginErrorMessage_(page);
  if (!cfg.headless) {
    console.log(
      `Auto login did not complete. url=${page.url()} title=${await page.title().catch(() => "")}`
    );
    if (message) {
      console.log(`login error hint: ${message}`);
    }
    await waitForEnter_("If login needs extra step (captcha/2FA), complete it in browser and press Enter...");
    if (!isLoginPage_(page.url())) return;
  }

  throw new Error(
    `Login did not complete. Check JENKINS_UI_USER/JENKINS_UI_PASSWORD.${message ? ` hint=${message}` : ""}`
  );
}

async function fillKeywordsParameter_(page, paramName, text, filePath) {
  const form = page.locator("form[name='parameters'], form[action*='/build'], form").first();
  const byName = form.locator(`[name='${cssEscape_(paramName)}']`).first();
  if (await byName.isVisible().catch(() => false)) {
    await fillFieldOrFile_(byName, text, filePath);
    return;
  }

  const byHiddenName = form.locator(
    `input[type='hidden'][name='name'][value='${cssEscape_(paramName)}']`
  );
  if ((await byHiddenName.count().catch(() => 0)) > 0) {
    const inRowFile = byHiddenName
      .locator("xpath=ancestor::*[self::tr or contains(@class,'jenkins-form-item')][1]//input[@type='file']")
      .first();
    if (await inRowFile.isVisible().catch(() => false)) {
      await inRowFile.setInputFiles(filePath);
      return;
    }

    const inRowText = byHiddenName
      .locator(
        "xpath=ancestor::*[self::tr or contains(@class,'jenkins-form-item')][1]//*[self::textarea or (self::input and (@type='text' or not(@type)))]"
      )
      .first();
    if (await inRowText.isVisible().catch(() => false)) {
      await fillFieldOrFile_(inRowText, text, filePath);
      return;
    }
  }

  const fallback = await firstVisible_([
    form.locator("textarea[name]").first(),
    form.locator("textarea").first(),
    form.locator("input[type='text'][name]").first(),
    form.locator("input[type='text']").first(),
    form.locator("input[type='file']").first()
  ]);

  if (!fallback) {
    throw new Error(
      `Parameter field '${paramName}' was not found. Set JENKINS_KEYWORDS_PARAM to your actual parameter name.`
    );
  }

  await fillFieldOrFile_(fallback, text, filePath);
}

async function fillFieldOrFile_(locator, text, filePath) {
  const tagName = await locator.evaluate((el) => el.tagName.toLowerCase()).catch(() => "");
  const type = await locator.evaluate((el) => el.getAttribute("type") || "").catch(() => "");
  if (tagName === "input" && String(type).toLowerCase() === "file") {
    await locator.setInputFiles(filePath);
    return;
  }
  if (tagName === "textarea" || tagName === "input") {
    await locator.fill(text);
    return;
  }
  await locator.click();
  await locator.fill(text);
}

async function clickBuildButton_(page) {
  const button = await firstVisible_([
    page.getByRole("button", { name: /^Build$|^ビルド$|^実行$|^Run$/i }).first(),
    page.locator("button[type='submit']").first(),
    page.locator("input[type='submit']").first(),
    page.locator("button:has-text('Build')").first(),
    page.locator("button:has-text('ビルド')").first()
  ]);

  if (!button) {
    throw new Error("Build button not found on Jenkins build page.");
  }

  await Promise.all([
    page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {}),
    button.click()
  ]);
}

async function readLoginErrorMessage_(page) {
  const locators = [
    page.locator(".alert-danger").first(),
    page.locator(".error").first(),
    page.locator("[role='alert']").first(),
    page.locator("text=Invalid username").first(),
    page.locator("text=Invalid password").first(),
    page.locator("text=認証").first()
  ];
  for (const l of locators) {
    if (await l.isVisible().catch(() => false)) {
      const text = await l.innerText().catch(() => "");
      if (text && text.trim()) return truncate_(text, 160);
    }
  }
  return "";
}

async function firstVisible_(locators) {
  for (const locator of locators) {
    if (await locator.isVisible().catch(() => false)) {
      return locator;
    }
  }
  return null;
}

function buildJobUrl_(baseUrl, jobName) {
  const root = trimSlash_(baseUrl);
  const segments = String(jobName)
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `job/${encodeURIComponent(s)}`);
  return `${root}/${segments.join("/")}`;
}

async function resolveBuildPageUrl_(page) {
  const defaultJobId = cfg.jobPath || cfg.jobName;
  let jobUrl = buildJobUrl_(cfg.baseUrl, defaultJobId);
  let buildPageUrl = `${jobUrl}/build?delay=0sec`;

  await page.goto(buildPageUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
  if (!(await isNotFoundPage_(page))) {
    return { jobUrl, buildPageUrl };
  }

  const discoveredJobUrl = await discoverJobUrlFromDashboard_(page, cfg.baseUrl, cfg.jobName);
  if (!discoveredJobUrl) {
    throw new Error(
      `Jenkins job page not found for '${cfg.jobName}'. Set JENKINS_JOB_PATH (example: lincwell_imp).`
    );
  }

  jobUrl = discoveredJobUrl;
  buildPageUrl = `${jobUrl}/build?delay=0sec`;
  return { jobUrl, buildPageUrl };
}

async function isNotFoundPage_(page) {
  const url = String(page.url() || "");
  const title = await page.title().catch(() => "");
  const bodyText = await page.locator("body").innerText().catch(() => "");
  return /404|not found/i.test(url) || /404|not found/i.test(title) || /404|not found/i.test(bodyText);
}

async function discoverJobUrlFromDashboard_(page, baseUrl, displayName) {
  const root = `${trimSlash_(baseUrl)}/`;
  await page.goto(root, { waitUntil: "domcontentloaded", timeout: 120000 });
  await ensureAuthenticated_(page);

  const foundHref = await page.evaluate((targetName) => {
    const norm = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]/g, "");
    const target = norm(targetName);
    const anchors = Array.from(document.querySelectorAll("a[href]"));
    let fallback = "";

    for (const a of anchors) {
      const href = String(a.getAttribute("href") || "");
      if (!href || !/\/?job\//i.test(href)) continue;
      const text = String(a.textContent || a.getAttribute("aria-label") || "").trim();
      if (!fallback) fallback = href;
      if (target && (norm(text).includes(target) || norm(href).includes(target))) {
        return href;
      }
    }
    return fallback;
  }, displayName);

  if (!foundHref) return "";
  return new URL(foundHref, root).toString().replace(/\/+$/, "");
}

function trimSlash_(value) {
  return String(value || "").replace(/\/+$/, "");
}

function requiredEnv_(key) {
  const v = process.env[key];
  if (!v || !String(v).trim()) {
    throw new Error(`Missing env: ${key}`);
  }
  return String(v).trim();
}

async function loadDotEnv_(filePath) {
  if (!existsSync(filePath)) return;
  const content = await fs.readFile(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function cssEscape_(value) {
  return String(value).replace(/['"\\]/g, "\\$&");
}

async function waitForEnter_(message) {
  const rl = readline.createInterface({ input, output });
  await new Promise((resolve) => {
    rl.question(`${message}\n`, () => resolve());
  });
  rl.close();
}

function sleep_(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate_(text, maxLen) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "...";
}

function normalizeUiCred_(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  if (s.startsWith("your-")) return "";
  return s;
}
