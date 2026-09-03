import { chromium, type Cookie, Request } from "playwright";
import fs from "fs/promises";
import path from "path";

const CAREERS_URL = process.env.CAREERS_URL;
const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY?.trim();
const MAILGUN_DOMAIN = process.env.MAILGUN_DOMAIN?.trim();
const MAILGUN_FROM = process.env.MAILGUN_FROM?.trim();
const MAILGUN_TO = process.env.MAILGUN_TO?.trim();
// Set to "eu" for accounts on the Mailgun EU region.
const MAILGUN_REGION = (process.env.MAILGUN_REGION?.trim() ?? "us").toLowerCase();

if (!CAREERS_URL) {
  throw new Error("CAREERS_URL environment variable is not set");
}

const DATA_DIR = path.resolve("data");
const SCREENSHOT_DIR = path.resolve("screenshots");

await fs.mkdir(DATA_DIR, { recursive: true });
await fs.mkdir(SCREENSHOT_DIR, { recursive: true });

type WidgetsJob = {
  jobId?: string;
  title?: string;
  applyUrl?: string;
  city?: string;
  country?: string;
  state?: string;
  descriptionTeaser?: string;
  [key: string]: unknown;
};

type WidgetsResponseBody = {
  refineSearch?: {
    hits?: number;
    totalHits?: number;
    data?: {
      jobs?: WidgetsJob[];
    };
  };
};

type Job = {
  title: string;
  url: string;
  applyUrl?: string;
  location?: string;
  description?: string;
};

const WIDGETS_URL =
  "https://careers.justeattakeaway.com/widgets";

/*
 * Canonical search body that returns Tech & Product jobs.
 * Captured from a real browser session (see request.txt).
 */
const SEARCH_BODY = {
  sortBy: "",
  subsearch: "",
  from: 0,
  jobs: true,
  counts: true,
  all_fields: ["category", "country", "city", "type"],
  pageName: "search-results",
  size: 50,
  clearAll: false,
  jdsource: "facets",
  isSliderEnable: false,
  pageId: "page775",
  siteType: "external",
  keywords: "",
  global: true,
  selected_fields: { category: ["Tech & Product"] },
  lang: "en_global",
  deviceType: "desktop",
  country: "global",
  refNum: "TAKEGLOBAL",
  ddoKey: "refineSearch",
};

function buildJobUrl(
  jobId: string,
  title: string,
  baseUrl: string
): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const origin = new URL(baseUrl).origin;

  return `${origin}/global/en/job/${jobId}/${slug}`;
}

function extractJobs(
  apiJobs: WidgetsJob[],
  baseUrl: string
): Job[] {
  const jobs: Job[] = [];

  for (const j of apiJobs) {
    if (!j.title || !j.jobId) {
      continue;
    }

    const job: Job = {
      title: j.title,
      url: buildJobUrl(j.jobId, j.title, baseUrl),
    };

    if (j.applyUrl) {
      job.applyUrl = j.applyUrl;
    }

    const locationParts = [j.city, j.state, j.country].filter(
      Boolean
    );

    if (locationParts.length > 0) {
      job.location = locationParts.join(", ");
    }

    if (j.descriptionTeaser) {
      job.description = j.descriptionTeaser;
    }

    jobs.push(job);
  }

  return jobs;
}

function dedupeJobs(jobs: Job[]): Job[] {
  const seen = new Set<string>();

  return jobs.filter((j) => {
    const key = j.url || j.title;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });
}

async function saveJson(
  filename: string,
  data: unknown
): Promise<void> {
  await fs.writeFile(
    filename,
    JSON.stringify(data, null, 2),
    "utf8"
  );
}

function jobsChanged(prev: Job[], next: Job[]): boolean {
  const prevUrls = new Set(prev.map((j) => j.url));
  const nextUrls = new Set(next.map((j) => j.url));

  if (prevUrls.size !== nextUrls.size) {
    return true;
  }

  for (const url of nextUrls) {
    if (!prevUrls.has(url)) {
      return true;
    }
  }

  return false;
}

function formatEmailBody(
  current: Job[],
  previous: Job[]
): string {
  const prevUrls = new Set(previous.map((j) => j.url));
  const nextUrls = new Set(current.map((j) => j.url));

  const added = current.filter((j) => !prevUrls.has(j.url));
  const removed = previous.filter(
    (j) => !nextUrls.has(j.url)
  );

  const lines: string[] = [];

  if (added.length > 0) {
    lines.push(`NEW (${added.length}):`);

    for (const j of added) {
      lines.push(`  + ${j.title}`);
      lines.push(`    ${j.url}`);

      if (j.location) {
        lines.push(`    ${j.location}`);
      }
    }

    lines.push("");
  }

  if (removed.length > 0) {
    lines.push(`REMOVED (${removed.length}):`);

    for (const j of removed) {
      lines.push(`  - ${j.title}`);
      lines.push(`    ${j.url}`);
    }

    lines.push("");
  }

  lines.push(`ALL CURRENT LISTINGS (${current.length}):`);
  lines.push("");

  for (const [i, j] of current.entries()) {
    lines.push(`${i + 1}. ${j.title}`);
    lines.push(`   ${j.url}`);

    if (j.location) {
      lines.push(`   ${j.location}`);
    }

    if (j.description) {
      lines.push(`   ${j.description}`);
    }

    lines.push("");
  }

  return lines.join("\n");
}

async function sendEmail(
  subject: string,
  text: string
): Promise<void> {
  if (
    !MAILGUN_API_KEY ||
    !MAILGUN_DOMAIN ||
    !MAILGUN_FROM ||
    !MAILGUN_TO
  ) {
    console.log(
      "Mailgun env vars not set — skipping email."
    );

    return;
  }

  const host =
    MAILGUN_REGION === "eu"
      ? "api.eu.mailgun.net"
      : "api.mailgun.net";

  const url = `https://${host}/v3/${MAILGUN_DOMAIN}/messages`;

  console.log(`  Mailgun endpoint: ${url}`);

  const body = new URLSearchParams({
    from: MAILGUN_FROM,
    to: MAILGUN_TO,
    subject,
    text,
  });

  const credentials = btoa(
    `api:${MAILGUN_API_KEY}`
  );

  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Basic ${credentials}`,
      "content-type":
        "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const detail = await response.text();

    throw new Error(
      `Mailgun request failed: HTTP ${response.status} — ${detail}`
    );
  }

  console.log(
    `Email sent to ${MAILGUN_TO} (subject: "${subject}").`
  );
}

/*
 * Extract the CSRF token from the PLAY_SESSION cookie.
 * The cookie value is a signed JWT; the payload contains csrfToken.
 */
function extractCsrfFromSession(
  sessionCookieValue: string
): string | null {
  try {
    const parts = sessionCookieValue.split(".");

    if (parts.length < 2) {
      return null;
    }

    const b64 = parts[1]
      .replace(/-/g, "+")
      .replace(/_/g, "/");

    const payload = JSON.parse(atob(b64)) as {
      data?: { csrfToken?: string };
    };

    return payload?.data?.csrfToken ?? null;
  } catch {
    return null;
  }
}

async function fetchJobs(
  csrfToken: string,
  from: number
): Promise<WidgetsResponseBody> {
  const response = await fetch(WIDGETS_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
      referer: CAREERS_URL ?? "",
    },
    body: JSON.stringify({ ...SEARCH_BODY, from }),
  });

  if (!response.ok) {
    throw new Error(
      `POST /widgets failed: HTTP ${response.status}`
    );
  }

  return (await response.json()) as WidgetsResponseBody;
}

// ===

const browser = await chromium.launch({ headless: true });

const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});

const page = await context.newPage();

let csrfToken: string | null = null;

/*
 * Grab the CSRF token the moment any /widgets request fires.
 */
page.on("request", (req: Request) => {
  if (
    csrfToken ||
    !req.url().startsWith(WIDGETS_URL)
  ) {
    return;
  }

  csrfToken =
    req.headers()["x-csrf-token"] ?? null;

  if (csrfToken) {
    console.log("CSRF token captured from /widgets request.");
  }
});

console.log("========================================");
console.log("JET TECH & PRODUCT SCRAPER");
console.log("========================================");
console.log(`URL: ${CAREERS_URL}`);
console.log("");

console.log("Opening careers page...");

await page.goto(CAREERS_URL, {
  waitUntil: "domcontentloaded",
  timeout: 90_000,
});

console.log(`Title: ${await page.title()}`);

await page.screenshot({
  path: path.join(SCREENSHOT_DIR, "01-home.png"),
  fullPage: true,
});

console.log("Waiting for CSRF token...");

await page.waitForTimeout(10_000);

/*
 * Fallback: parse the token from the session cookie directly.
 */
if (!csrfToken) {
  console.log(
    "No /widgets request seen. Extracting CSRF token from session cookie..."
  );

  const cookies = await context.cookies();
  const session = cookies.find(
    (c: Cookie) => c.name === "PLAY_SESSION"
  );

  if (session) {
    csrfToken = extractCsrfFromSession(session.value);
  }
}

if (!csrfToken) {
  await page.screenshot({
    path: path.join(
      SCREENSHOT_DIR,
      "99-no-csrf.png"
    ),
    fullPage: true,
  });

  await fs.writeFile(
    path.join(SCREENSHOT_DIR, "page.html"),
    await page.content(),
    "utf8"
  );

  await browser.close();

  throw new Error(
    "Could not obtain a CSRF token. Check screenshots/ and page.html."
  );
}

await browser.close();

/*
 * Fetch all Tech & Product jobs via direct API calls.
 */
console.log(
  "\nFetching Tech & Product jobs from /widgets..."
);

let allJobs: Job[] = [];
let totalHits = 0;
let from = 0;

do {
  if (from > 0) {
    console.log(
      `  Fetching next page (from=${from}, have ${allJobs.length}/${totalHits})...`
    );
  }

  const body = await fetchJobs(csrfToken, from);

  const pageJobs = body.refineSearch?.data?.jobs ?? [];

  totalHits = body.refineSearch?.totalHits ?? 0;

  console.log(
    `  Page from=${from}: ${pageJobs.length} jobs (totalHits=${totalHits})`
  );

  if (pageJobs.length === 0) {
    break;
  }

  allJobs = dedupeJobs([
    ...allJobs,
    ...extractJobs(pageJobs, CAREERS_URL),
  ]);

  from += pageJobs.length;
} while (allJobs.length < totalHits);

await saveJson(
  path.join(SCREENSHOT_DIR, "widgets-debug.json"),
  {
    careersUrl: CAREERS_URL,
    totalHits,
    extractedJobs: allJobs,
  }
);

const finalJobs = allJobs.slice(0, 30);

console.log("\n========================================");
console.log("FINAL RESULTS");
console.log("========================================");

for (const [index, job] of finalJobs.entries()) {
  console.log(`${index + 1}. ${job.title}`);
  console.log(`   ${job.url}`);

  if (job.location) {
    console.log(`   ${job.location}`);
  }
}

console.log("");
console.log(`Found ${finalJobs.length} jobs.`);

if (finalJobs.length === 0) {
  throw new Error(
    "/widgets returned no job records. " +
    "Check screenshots/widgets-debug.json."
  );
}

/*
 * Load previous results to detect changes before overwriting.
 */
let previousJobs: Job[] = [];

try {
  const raw = await fs.readFile(
    path.join(DATA_DIR, "jobs.json"),
    "utf8"
  );

  previousJobs = JSON.parse(raw) as Job[];
} catch {
  // First run or file missing — treat everything as new.
}

await saveJson(
  path.join(DATA_DIR, "jobs.json"),
  finalJobs
);

if (finalJobs.length < 30) {
  console.warn(
    `WARNING: Expected 30 jobs but found ${finalJobs.length}.`
  );
}

/*
 * Email on changes only.
 */
if (jobsChanged(previousJobs, finalJobs)) {
  console.log(
    "\nChanges detected. Sending email..."
  );

  const emailBody = formatEmailBody(
    finalJobs,
    previousJobs
  );

  await sendEmail("Job listings", emailBody);
} else {
  console.log(
    "\nNo changes since last run. Email not sent."
  );
}

console.log("Scrape completed successfully.");
