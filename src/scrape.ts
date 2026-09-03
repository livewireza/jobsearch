import { chromium, Request, Response } from "playwright";
import fs from "fs/promises";
import path from "path";

const CAREERS_URL = process.env.CAREERS_URL;

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
    status?: number;
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

function isWidgetsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);

    return (
      parsed.hostname === "careers.justeattakeaway.com" &&
      parsed.pathname === "/widgets"
    );
  } catch {
    return false;
  }
}

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

    const locationParts = [j.city, j.state, j.country].filter(Boolean);

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

const browser = await chromium.launch({ headless: true });

const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});

const page = await context.newPage();

let capturedRequestBody: Record<string, unknown> = {};
let csrfToken: string | null = null;
let widgetsUrl: string | null = null;

const capturedJobs: WidgetsJob[] = [];
let totalHits = 0;

/*
 * Capture the /widgets POST request so we can replay it for pagination.
 */
page.on("request", (req: Request) => {
  if (!isWidgetsUrl(req.url())) {
    return;
  }

  widgetsUrl = req.url();
  csrfToken = req.headers()["x-csrf-token"] ?? null;

  try {
    const raw = req.postData();

    if (raw) {
      capturedRequestBody = JSON.parse(raw) as Record<
        string,
        unknown
      >;
    }
  } catch {
    // ignore parse errors
  }

  console.log(
    `\nWidgets request: ${req.url()}`
  );
  console.log(
    `CSRF token: ${csrfToken ? "present" : "missing"}`
  );
});

/*
 * Capture the /widgets POST response.
 */
page.on("response", async (res: Response) => {
  if (!isWidgetsUrl(res.url())) {
    return;
  }

  console.log(
    `\nWidgets response: HTTP ${res.status()}`
  );

  try {
    const json =
      (await res.json()) as WidgetsResponseBody;

    const apiJobs = json.refineSearch?.data?.jobs ?? [];

    totalHits = json.refineSearch?.totalHits ?? apiJobs.length;

    capturedJobs.push(...apiJobs);

    console.log(
      `  jobs in page: ${apiJobs.length}, totalHits: ${totalHits}`
    );
  } catch (err) {
    console.error(
      "Could not parse /widgets response:",
      err
    );
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

console.log("Waiting for job widget...");

await page.waitForTimeout(10_000);

await page.screenshot({
  path: path.join(SCREENSHOT_DIR, "02-after-js.png"),
  fullPage: true,
});

if (!widgetsUrl) {
  console.log(
    "No /widgets request seen yet. Waiting another 10 seconds..."
  );

  await page.waitForTimeout(10_000);
}

if (!widgetsUrl || Object.keys(capturedRequestBody).length === 0) {
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "99-no-widgets.png"),
    fullPage: true,
  });

  await fs.writeFile(
    path.join(SCREENSHOT_DIR, "page.html"),
    await page.content(),
    "utf8"
  );

  await browser.close();

  throw new Error(
    "No /widgets POST request was captured. " +
    "Check screenshots/ and page.html for diagnostics."
  );
}

/*
 * Paginate with direct requests until we have all jobs.
 */
while (capturedJobs.length < totalHits && csrfToken) {
  const from = capturedJobs.length;

  console.log(
    `\nFetching more jobs (from=${from}, have ${capturedJobs.length}/${totalHits})...`
  );

  const requestBody = {
    ...capturedRequestBody,
    from,
    size: 50,
  };

  const response = await page.request.post(widgetsUrl, {
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
      referer: CAREERS_URL,
    },
    data: requestBody,
  });

  console.log(`  HTTP ${response.status()}`);

  if (!response.ok()) {
    console.warn(
      `  Request failed: ${(await response.text()).slice(0, 500)}`
    );

    break;
  }

  const json =
    (await response.json()) as WidgetsResponseBody;

  const pageJobs = json.refineSearch?.data?.jobs ?? [];

  if (pageJobs.length === 0) {
    break;
  }

  capturedJobs.push(...pageJobs);

  console.log(
    `  Got ${pageJobs.length} more (total now: ${capturedJobs.length})`
  );
}

let jobs = dedupeJobs(
  extractJobs(capturedJobs, CAREERS_URL)
);

console.log(`\nUnique jobs extracted: ${jobs.length}`);

await saveJson(
  path.join(SCREENSHOT_DIR, "widgets-debug.json"),
  {
    careersUrl: CAREERS_URL,
    widgetsUrl,
    totalHits,
    capturedJobCount: capturedJobs.length,
    extractedJobs: jobs,
  }
);

const finalJobs = jobs.slice(0, 30);

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

await saveJson(
  path.join(DATA_DIR, "jobs.json"),
  finalJobs
);

await page.screenshot({
  path: path.join(SCREENSHOT_DIR, "99-finished.png"),
  fullPage: true,
});

console.log("");
console.log(`Found ${finalJobs.length} jobs.`);

if (finalJobs.length < 30) {
  console.warn(
    `WARNING: Expected 30 jobs but found ${finalJobs.length}.`
  );
}

if (finalJobs.length === 0) {
  await browser.close();

  throw new Error(
    "/widgets API responded but no job records were extracted. " +
    "Check screenshots/widgets-debug.json."
  );
}

await browser.close();

console.log("Scrape completed successfully.");
