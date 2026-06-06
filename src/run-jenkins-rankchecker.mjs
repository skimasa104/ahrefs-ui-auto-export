import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { stdin as input, stdout as output } from "node:process";
import { chromium } from "playwright";
import { pivotRankCheckFile_ } from "./pivot-rank-check.mjs";
import { summarizeDomainsFromWide_ } from "./summarize-rank-domains.mjs";
import {
  OUTPUT_AHREFS_KEYWORDS_TXT_DIR,
  ensureOutputStageDirs_,
  jenkinsLatestArtifactPath_,
  jenkinsVersionedArtifactPath_,
  resolveLatestFileInDir_,
  timestampToken_
} from "./output-paths.mjs";

const execFile = promisify(execFileCb);
const ROOT = process.cwd();
const PROFILE_DIR = path.resolve(ROOT, process.env.JENKINS_PROFILE_DIR || ".jenkins-profile");

await loadDotEnv_(path.join(ROOT, ".env"));

const cfg = {
  baseUrl: requiredEnv_("JENKINS_BASE_URL"),
  loginUrl:
    process.env.JENKINS_LOGIN_URL || `${trimSlash_(requiredEnv_("JENKINS_BASE_URL"))}/login?from=%2F`,
  jobPath: String(process.env.JENKINS_RANKCHECKER_JOB_PATH || "lincwell_grc").trim(),
  uiUser: normalizeUiCred_(process.env.JENKINS_UI_USER),
  uiPassword: normalizeUiCred_(process.env.JENKINS_UI_PASSWORD),
  keywordsFile: process.env.JENKINS_KEYWORDS_FILE || OUTPUT_AHREFS_KEYWORDS_TXT_DIR,
  keywordsParam: process.env.JENKINS_KEYWORDS_PARAM || "tmp/keywords.txt",
  artifactName: process.env.JENKINS_RANKCHECKER_ARTIFACT || "rank_check.csv",
  waitSeconds: Math.max(60, Number(process.env.JENKINS_RANKCHECKER_WAIT_SEC || 1800)),
  artifactPollSeconds: Math.max(10, Number(process.env.JENKINS_RANKCHECKER_POLL_SEC || 180)),
  resumeBuildNo: Math.max(0, Number(process.env.JENKINS_RANKCHECKER_BUILD_NO || 0)),
  browserChannel: String(process.env.JENKINS_UI_BROWSER_CHANNEL || "chrome").trim(),
  headless: process.env.JENKINS_UI_HEADLESS === "1"
};

main().catch((error) => {
  console.error("[fatal]", error?.message || String(error));
  process.exit(1);
});

async function main() {
  await ensureOutputStageDirs_();
  const keywordsPath = await resolveKeywordsFilePath_(cfg.keywordsFile);
  if (!existsSync(keywordsPath)) {
    throw new Error(`Keywords file not found: ${keywordsPath}`);
  }

  const context = await launchContext_();

  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(cfg.loginUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
    await bringBrowserToFront_();
    await loginIfNeeded_(page);

    const jobUrl = buildJobUrl_(cfg.baseUrl, cfg.jobPath);
    await page.goto(jobUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
    await ensureAuthenticated_(page);

    let startedBuildNo = cfg.resumeBuildNo;
    if (startedBuildNo > 0) {
      console.log(`[info] Resume mode: using build #${startedBuildNo}`);
    } else {
      const prevBuildNo = await getLatestBuildNumber_(page);
      await openParamBuildPage_(page, jobUrl);
      await uploadKeywordsFile_(page, keywordsPath, cfg.keywordsParam);
      await clickBuildButton_(page);
      startedBuildNo = await waitForNewBuild_(page, jobUrl, prevBuildNo);
    }

    const buildUrl = `${jobUrl}/${startedBuildNo}/`;
    console.log(`[info] Build started: #${startedBuildNo}`);

    const artifactUrl = await waitForArtifactUrl_(page, buildUrl, cfg.artifactName, cfg.waitSeconds);
    const saved = await downloadArtifact_(context, artifactUrl, startedBuildNo, cfg.artifactName);

    console.log(`[ok] ${cfg.artifactName} downloaded.`);
    console.log(`build: #${startedBuildNo}`);
    console.log(`artifact: ${artifactUrl}`);
    console.log(`saved: ${saved.latest}`);
    console.log(`saved_copy: ${saved.versioned}`);

    const pivoted = await pivotRankCheckFile_({ inputPath: saved.latest });
    console.log(`saved_pivot: ${pivoted.output}`);
    const domains = await summarizeDomainsFromWide_({ inputPath: pivoted.output });
    console.log(`saved_domains: ${domains.output}`);
    console.log(`saved_media_clusters: ${domains.clusterOutput}`);
  } finally {
    await context.close();
  }
}

async function loginIfNeeded_(page) {
  if (!isLoginPage_(page.url())) return;
  console.log("Jenkins login is required.");
  if (cfg.uiUser && cfg.uiPassword) {
    await fillLoginForm_(page, cfg.uiUser, cfg.uiPassword);
    await waitForPostLogin_(page);
    return;
  }
  await waitForManualLogin_(page);
}

async function ensureAuthenticated_(page) {
  if (isLoginPage_(page.url())) {
    throw new Error("Still on login page.");
  }
}

function isLoginPage_(url) {
  const u = String(url || "").toLowerCase();
  return u.includes("/login") || u.includes("signin");
}

async function openParamBuildPage_(page, jobUrl) {
  const menuLink = await firstVisible_([
    page.getByRole("link", { name: /パラメータ付きビルド|build with parameters/i }).first(),
    page.locator("a:has-text('パラメータ付きビルド')").first(),
    page.locator("a:has-text('Build with Parameters')").first()
  ]);

  if (menuLink) {
    await Promise.all([
      page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {}),
      menuLink.click()
    ]);
  } else {
    await page.goto(`${jobUrl}/build?delay=0sec`, { waitUntil: "domcontentloaded", timeout: 120000 });
  }

  const fileInput = await waitForAnyFileInput_(page, 20000);
  if (!fileInput) {
    throw new Error("File input not found on parameter build page.");
  }
}

async function uploadKeywordsFile_(page, filePath, paramName) {
  const form = page.locator("form[name='parameters'], form[action*='/build'], form").first();
  const byHiddenName = form.locator(
    `input[type='hidden'][name='name'][value='${cssEscape_(paramName)}']`
  );

  const hiddenCount = await byHiddenName.count().catch(() => 0);
  if (hiddenCount > 0) {
    const inRowFile = byHiddenName
      .locator("xpath=ancestor::*[self::tr or contains(@class,'jenkins-form-item')][1]//input[@type='file']")
      .first();
    if ((await inRowFile.count().catch(() => 0)) > 0) {
      await inRowFile.setInputFiles(filePath);
      return;
    }
  }

  const fileInput = await waitForAnyFileInput_(page, 5000);
  if (!fileInput) {
    throw new Error("File input not found.");
  }
  await fileInput.setInputFiles(filePath);
}

async function clickBuildButton_(page) {
  const button = await firstVisible_([
    page.getByRole("button", { name: /^Build$|^ビルド$|^Run$|^実行$/i }).first(),
    page.locator("button:has-text('ビルド')").first(),
    page.locator("button:has-text('Build')").first(),
    page.locator("input[type='submit']").first()
  ]);
  if (!button) throw new Error("Build button not found.");

  await Promise.all([
    page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {}),
    button.click()
  ]);
}

async function getLatestBuildNumber_(page) {
  const nums = await page.evaluate(() => {
    const out = [];
    for (const a of Array.from(document.querySelectorAll("a[href]"))) {
      const href = String(a.getAttribute("href") || "");
      const m = href.match(/\/(\d+)\/?$/);
      if (!m) continue;
      const n = Number(m[1]);
      if (Number.isFinite(n)) out.push(n);
    }
    return out;
  });
  return nums.length ? Math.max(...nums) : 0;
}

async function waitForNewBuild_(page, jobUrl, prevBuildNo) {
  const timeoutMs = 5 * 60 * 1000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await page.goto(jobUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
    const latest = await getLatestBuildNumber_(page);
    if (latest > prevBuildNo) return latest;
    await sleep_(2000);
  }
  throw new Error("Timed out waiting for new build number.");
}

async function waitForArtifactUrl_(page, buildUrl, artifactName, waitSeconds) {
  const deadline = Date.now() + waitSeconds * 1000;
  const artifactPattern = new RegExp(escapeRegExp_(artifactName), "i");
  let nextLogAt = Date.now();
  while (Date.now() < deadline) {
    await page.goto(buildUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
    if (isLoginPage_(page.url())) {
      console.log("[warn] Session expired on build page. Login is required again.");
      await waitForManualLogin_(page);
      continue;
    }

    const href = await page.evaluate((patternText) => {
      const re = new RegExp(patternText, "i");
      for (const a of Array.from(document.querySelectorAll("a[href]"))) {
        const href = String(a.getAttribute("href") || "");
        const text = String(a.textContent || "");
        if (re.test(href) || re.test(text)) return href;
      }
      return "";
    }, artifactPattern.source);

    if (href) {
      return new URL(href, buildUrl).toString();
    }
    if (Date.now() >= nextLogAt) {
      console.log(`[wait] artifact not ready yet: ${buildUrl}`);
      nextLogAt = Date.now() + cfg.artifactPollSeconds * 1000;
    }
    await sleep_(cfg.artifactPollSeconds * 1000);
  }
  throw new Error(`Timed out waiting for artifact '${artifactName}'.`);
}

async function waitForManualLogin_(page) {
  const maxTries = 8;
  for (let i = 1; i <= maxTries; i += 1) {
    await waitForEnter_(`Complete login in browser, then press Enter... (${i}/${maxTries})`);
    await sleep_(500);
    if (!isLoginPage_(page.url())) return;
    await page.reload({ waitUntil: "domcontentloaded", timeout: 120000 }).catch(() => {});
    if (!isLoginPage_(page.url())) return;
    await page.goto(trimSlash_(cfg.baseUrl) + "/", {
      waitUntil: "domcontentloaded",
      timeout: 120000
    }).catch(() => {});
    if (!isLoginPage_(page.url())) return;
    console.log(`[wait] still on login page: ${page.url()}`);
  }
  throw new Error("Still on login page after multiple retries.");
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

async function downloadArtifact_(context, artifactUrl, buildNo, artifactName) {
  const response = await context.request.get(artifactUrl, { timeout: 120000 });
  if (!response.ok()) {
    throw new Error(`Artifact download failed: ${response.status()} ${response.statusText()}`);
  }
  const bytes = await response.body();
  const stamp = timestampToken_();
  const latest = jenkinsLatestArtifactPath_(artifactName, stamp);
  const versioned = jenkinsVersionedArtifactPath_(buildNo, artifactName, stamp);
  await fs.writeFile(latest, bytes);
  await fs.writeFile(versioned, bytes);
  return { latest, versioned };
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

function buildJobUrl_(baseUrl, jobPath) {
  const root = trimSlash_(baseUrl);
  const segments = String(jobPath)
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `job/${encodeURIComponent(s)}`);
  return `${root}/${segments.join("/")}`;
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

async function firstVisible_(locators) {
  for (const locator of locators) {
    if (await locator.isVisible().catch(() => false)) return locator;
  }
  return null;
}

async function findVisibleInLocator_(locator) {
  const count = await locator.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const item = locator.nth(i);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return null;
}

async function waitForAnyFileInput_(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const inputs = page.locator("input[type='file']");
    const count = await inputs.count().catch(() => 0);
    if (count > 0) {
      return inputs.first();
    }
    await sleep_(500);
  }
  return null;
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

function escapeRegExp_(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cssEscape_(value) {
  return String(value).replace(/['"\\]/g, "\\$&");
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

function normalizeUiCred_(value) {
  const v = String(value || "").trim();
  if (!v || v.startsWith("your-")) return "";
  return v;
}

function truncate_(text, maxLen) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "...";
}

async function launchContext_() {
  const base = {
    headless: cfg.headless,
    viewport: { width: 1440, height: 1000 }
  };
  if (cfg.headless || !cfg.browserChannel) {
    return chromium.launchPersistentContext(PROFILE_DIR, base);
  }

  try {
    return await chromium.launchPersistentContext(PROFILE_DIR, {
      ...base,
      channel: cfg.browserChannel
    });
  } catch (error) {
    console.warn(
      `[warn] Failed to launch with channel='${cfg.browserChannel}', fallback to bundled Chromium.`
    );
    return chromium.launchPersistentContext(PROFILE_DIR, base);
  }
}

async function bringBrowserToFront_() {
  if (cfg.headless) return;
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
      // try next candidate
    }
  }
}
