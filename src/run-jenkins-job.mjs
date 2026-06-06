import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { OUTPUT_AHREFS_KEYWORDS_TXT_DIR, resolveLatestFileInDir_ } from "./output-paths.mjs";

const ROOT = process.cwd();

await loadDotEnv_(path.join(ROOT, ".env"));

const cfg = {
  baseUrl: requiredEnv_("JENKINS_BASE_URL"),
  jobName: requiredEnv_("JENKINS_JOB_NAME"),
  user: requiredEnv_("JENKINS_USER"),
  token: requiredEnv_("JENKINS_API_TOKEN"),
  keywordsFile: process.env.JENKINS_KEYWORDS_FILE || OUTPUT_AHREFS_KEYWORDS_TXT_DIR,
  keywordsParam: process.env.JENKINS_KEYWORDS_PARAM || "keywords"
};

main().catch((error) => {
  console.error("[fatal]", error?.message || String(error));
  process.exit(1);
});

async function main() {
  const filePath = await resolveKeywordsFilePath_(cfg.keywordsFile);
  if (!existsSync(filePath)) {
    throw new Error(`Keywords file not found: ${filePath}`);
  }

  const keywordsText = await fs.readFile(filePath, "utf8");
  if (!keywordsText.trim()) {
    throw new Error("Keywords file is empty.");
  }

  const authHeader = "Basic " + Buffer.from(`${cfg.user}:${cfg.token}`).toString("base64");
  const jobUrl = buildJobUrl_(cfg.baseUrl, cfg.jobName);

  await assertJobReachable_(jobUrl, authHeader);
  const crumb = await fetchCrumb_(cfg.baseUrl, authHeader);
  const queueLocation = await triggerBuild_({
    jobUrl,
    authHeader,
    crumb,
    paramName: cfg.keywordsParam,
    keywordsText
  });

  console.log("[ok] Jenkins job triggered.");
  console.log(`job: ${cfg.jobName}`);
  if (queueLocation) {
    console.log(`queue: ${queueLocation}`);
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

async function assertJobReachable_(jobUrl, authHeader) {
  const res = await fetch(`${jobUrl}/api/json`, {
    method: "GET",
    headers: {
      Authorization: authHeader
    }
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error("Jenkins auth failed. Check JENKINS_USER / JENKINS_API_TOKEN.");
  }
  if (res.status === 404) {
    throw new Error(`Jenkins job not found: ${jobUrl}`);
  }
  if (!res.ok) {
    throw new Error(`Failed to access Jenkins job (${res.status}).`);
  }
}

async function fetchCrumb_(baseUrl, authHeader) {
  const res = await fetch(`${trimSlash_(baseUrl)}/crumbIssuer/api/json`, {
    method: "GET",
    headers: {
      Authorization: authHeader
    }
  });

  if (!res.ok) {
    return null;
  }

  const data = await res.json().catch(() => null);
  if (!data?.crumbRequestField || !data?.crumb) {
    return null;
  }
  return data;
}

async function triggerBuild_({ jobUrl, authHeader, crumb, paramName, keywordsText }) {
  const body = new URLSearchParams();
  body.set(paramName, keywordsText);

  const headers = {
    Authorization: authHeader,
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
  };
  if (crumb) {
    headers[crumb.crumbRequestField] = crumb.crumb;
  }

  const res = await fetch(`${jobUrl}/buildWithParameters`, {
    method: "POST",
    headers,
    body: body.toString()
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error("Build trigger rejected (auth or CSRF).");
  }
  if (res.status === 404) {
    throw new Error("buildWithParameters endpoint not found. Check job type/permissions.");
  }
  if (![200, 201, 202].includes(res.status)) {
    const text = await res.text().catch(() => "");
    throw new Error(`Build trigger failed (${res.status}): ${truncate_(text, 220)}`);
  }

  return res.headers.get("location");
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

function truncate_(text, maxLen) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "...";
}
