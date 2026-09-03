```ts
import { chromium, Page, Response } from "playwright";
import fs from "fs/promises";
import path from "path";

const CAREERS_URL = process.env.CAREERS_URL;

if (!CAREERS_URL) {
  throw new Error("CAREERS_URL environment variable is not set");
}

const DATA_DIR = path.resolve("data");
const SCREENSHOT_DIR = path.resolve("screenshots");
const FLOCKLER_DIR = path.join(SCREENSHOT_DIR, "flockler-responses");

await fs.mkdir(DATA_DIR, { recursive: true });
await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
await fs.mkdir(FLOCKLER_DIR, { recursive: true });

type FlocklerPost = {
  id?: string | number;
  title?: string;
  text?: string;
  textPlain?: string;
  sourceUrl?: string;
  ctaLink?: {
    url?: string;
    title?: string;
  };
  [key: string]: unknown;
};

type FlocklerResponse = {
  posts?: FlocklerPost[];
  pagination?: {
    newer?: string | null;
    older?: string | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

type Job = {
  title: string;
  url: string;
  sourceUrl?: string;
  description?: string;
};

function isFlocklerPostsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);

    return (
      parsed.hostname === "api.flockler.app" &&
      parsed.pathname.includes("/v2/") &&
      parsed.pathname.endsWith("/posts")
    );
  } catch {
    return false;
  }
}

function isLikelyJobUrl(url: string): boolean {
  return (
    /\/job\//i.test(url) ||
    /\/jobs\//i.test(url) ||
    /\/job\?/i.test(url) ||
    /jobId=/i.test(url) ||
    /jobid=/i.test(url)
  );
}

function normaliseUrl(url: string): string {
  try {
    return new URL(url, CAREERS_URL).href;
  } catch {
    return url;
  }
}

function extractJobs(posts: FlocklerPost[]): Job[] {
  const jobs: Job[] = [];

  for (const post of posts) {
    const title =
      typeof post.title === "string"
        ? post.title.trim()
        : "";

    if (!title) {
      continue;
    }

    const possibleUrls = [
      typeof post.ctaLink?.url === "string"
        ? post.ctaLink.url
        : "",
      typeof post.sourceUrl === "string"
        ? post.sourceUrl
        : "",
    ]
      .filter(Boolean)
      .map(normaliseUrl);

    const jobUrl = possibleUrls.find(isLikelyJobUrl);

    if (!jobUrl) {
      continue;
    }

    const job: Job = {
      title,
      url: jobUrl,
    };

    if (post.sourceUrl) {
      job.sourceUrl = normaliseUrl(post.sourceUrl);
    }

    if (post.textPlain) {
      job.description = post.textPlain.trim();
    }

    jobs.push(job);
  }

  return jobs;
}

function dedupeJobs(jobs: Job[]): Job[] {
  const seen = new Set<string>();
  const result: Job[] = [];

  for (const job of jobs) {
    const key = job.url || job.title;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(job);
  }

  return result;
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

async function inspectPage(page: Page): Promise<void> {
  console.log("\n=== PAGE INSPECTION ===");

  const headings = await page
    .locator("h1,h2,h3,h4")
    .allTextContents();

  console.log("Headings:");

  for (const heading of headings) {
    const text = heading.trim();

    if (text) {
      console.log(`  ${text}`);
    }
  }

  const buttons = await page
    .locator("button")
    .evaluateAll((elements) =>
      elements.map((element) => ({
        text: (element.textContent || "").trim(),
        ariaLabel: element.getAttribute("aria-label"),
        type: element.getAttribute("type"),
        disabled: (element as HTMLButtonElement).disabled,
      }))
    );

  console.log("\nButtons:");

  for (const button of buttons) {
    console.log(
      `  text="${button.text}" aria="${button.ariaLabel}" disabled=${button.disabled}`
    );
  }

  const links = await page
    .locator("a")
    .evaluateAll((elements) =>
      elements.map((element) => ({
        text: (element.textContent || "").trim(),
        href: element.getAttribute("href"),
      }))
    );

  console.log("\nJob-looking links:");

  for (const link of links) {
    if (!link.href) {
      continue;
    }

    const url = normaliseUrl(link.href);

    if (isLikelyJobUrl(url)) {
      console.log(`  ${link.text} -> ${url}`);
    }
  }

  console.log("========================\n");
}

async function requestFlockler(
  page: Page,
  originalUrl: string,
  count: number
): Promise<FlocklerResponse | null> {
  try {
    const url = new URL(originalUrl);

    url.searchParams.set("count", String(count));

    console.log("\n=== FLOCKLER DIRECT REQUEST ===");
    console.log(url.href);

    const response = await page.request.get(url.href, {
      headers: {
        accept: "application/json, text/plain, */*",
      },
    });

    console.log(`HTTP ${response.status()}`);

    if (!response.ok()) {
      console.log(
        `Request failed: ${(await response.text()).slice(0, 1000)}`
      );

      return null;
    }

    const json = (await response.json()) as FlocklerResponse;

    await saveJson(
      path.join(
        FLOCKLER_DIR,
        `count-${count}.json`
      ),
      {
        url: url.href,
        status: response.status(),
        body: json,
      }
    );

    return json;
  } catch (error) {
    console.error(
      "Flockler direct request failed:",
      error
    );

    return null;
  }
}

async function requestOlderPage(
  page: Page,
  originalUrl: string,
  cursor: string
): Promise<FlocklerResponse | null> {
  try {
    const url = new URL(originalUrl);

    url.searchParams.set(
      "olderThanCursor",
      cursor
    );

    url.searchParams.set("count", "30");

    console.log("\n=== FLOCKLER OLDER PAGE ===");
    console.log(url.href);

    const response = await page.request.get(url.href, {
      headers: {
        accept: "application/json, text/plain, */*",
      },
    });

    console.log(`HTTP ${response.status()}`);

    if (!response.ok()) {
      console.log(
        `Request failed: ${(await response.text()).slice(0, 1000)}`
      );

      return null;
    }

    const json = (await response.json()) as FlocklerResponse;

    return json;
  } catch (error) {
    console.error(
      "Flockler older-page request failed:",
      error
    );

    return null;
  }
}

const browser = await chromium.launch({
  headless: true,
});

const context = await browser.newContext({
  viewport: {
    width: 1440,
    height: 1000,
  },
});

const page = await context.newPage();

let firstFlocklerUrl: string | null = null;

const capturedResponses: Array<{
  url: string;
  status: number;
  body: FlocklerResponse;
}> = [];

/*
 * Capture the actual Flockler job-widget response.
 */
page.on(
  "response",
  async (response: Response) => {
    const url = response.url();

    if (!isFlocklerPostsUrl(url)) {
      return;
    }

    console.log("\n================================");
    console.log("FLOCKLER RESPONSE CAPTURED");
    console.log("================================");
    console.log(`Status: ${response.status()}`);
    console.log(`URL: ${url}`);

    if (!firstFlocklerUrl) {
      firstFlocklerUrl = url;
    }

    try {
      const json =
        (await response.json()) as FlocklerResponse;

      capturedResponses.push({
        url,
        status: response.status(),
        body: json,
      });

      const index = capturedResponses.length;

      await saveJson(
        path.join(
          FLOCKLER_DIR,
          `response-${String(index).padStart(2, "0")}.json`
        ),
        {
          url,
          status: response.status(),
          body: json,
        }
      );

      const posts = Array.isArray(json.posts)
        ? json.posts
        : [];

      console.log(`Posts: ${posts.length}`);

      if (json.pagination) {
        console.log(
          `Older cursor: ${json.pagination.older ?? "none"}`
        );

        console.log(
          `Newer cursor: ${json.pagination.newer ?? "none"}`
        );
      }

      for (const post of posts) {
        console.log(
          `  ${post.title ?? "(no title)"}`
        );
      }
    } catch (error) {
      console.error(
        "Could not parse Flockler JSON:",
        error
      );
    }
  }
);

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
  path: path.join(
    SCREENSHOT_DIR,
    "01-home.png"
  ),
  fullPage: true,
});

console.log("Waiting for job widget...");

await page.waitForTimeout(10_000);

await page.screenshot({
  path: path.join(
    SCREENSHOT_DIR,
    "02-after-js.png"
  ),
  fullPage: true,
});

await fs.writeFile(
  path.join(SCREENSHOT_DIR, "page.html"),
  await page.content(),
  "utf8"
);

await inspectPage(page);

/*
 * Give the widget another chance to load.
 */
if (!firstFlocklerUrl) {
  console.log(
    "Flockler request not seen yet. Waiting another 10 seconds..."
  );

  await page.waitForTimeout(10_000);
}

if (!firstFlocklerUrl) {
  await page.screenshot({
    path: path.join(
      SCREENSHOT_DIR,
      "99-no-flockler.png"
    ),
    fullPage: true,
  });

  await browser.close();

  throw new Error(
    "No Flockler /posts request was captured."
  );
}

console.log("\n========================================");
console.log("INITIAL FLOCKLER URL");
console.log("========================================");
console.log(firstFlocklerUrl);

/*
 * Extract jobs from the normal browser response.
 */
let jobs: Job[] = [];

for (const captured of capturedResponses) {
  if (!Array.isArray(captured.body.posts)) {
    continue;
  }

  jobs.push(
    ...extractJobs(captured.body.posts)
  );
}

jobs = dedupeJobs(jobs);

console.log(
  `\nJobs from browser response: ${jobs.length}`
);

/*
 * Try the same request with count=30.
 */
const count30 = await requestFlockler(
  page,
  firstFlocklerUrl,
  30
);

if (count30 && Array.isArray(count30.posts)) {
  console.log(
    `count=30 returned ${count30.posts.length} posts`
  );

  jobs = dedupeJobs([
    ...jobs,
    ...extractJobs(count30.posts),
  ]);

  console.log(
    `Unique jobs after count=30: ${jobs.length}`
  );
}

/*
 * Follow older cursor if necessary.
 */
let cursor =
  count30?.pagination?.older ?? null;

let cursorPages = 0;

while (
  jobs.length < 30 &&
  cursor &&
  cursorPages < 10
) {
  cursorPages++;

  console.log(
    `Following older cursor (${cursorPages})...`
  );

  const older = await requestOlderPage(
    page,
    firstFlocklerUrl,
    cursor
  );

  if (!older) {
    break;
  }

  if (Array.isArray(older.posts)) {
    jobs = dedupeJobs([
      ...jobs,
      ...extractJobs(older.posts),
    ]);
  }

  console.log(
    `Jobs after cursor page: ${jobs.length}`
  );

  cursor =
    older.pagination?.older ?? null;
}

/*
 * Save raw diagnostic data.
 */
await saveJson(
  path.join(
    SCREENSHOT_DIR,
    "flockler-debug.json"
  ),
  {
    careersUrl: CAREERS_URL,
    firstFlocklerUrl,
    capturedResponses,
    extractedJobs: jobs,
  }
);

const finalJobs = jobs.slice(0, 30);

console.log("\n========================================");
console.log("FINAL RESULTS");
console.log("========================================");

for (const [index, job] of finalJobs.entries()) {
  console.log(
    `${index + 1}. ${job.title}`
  );
  console.log(`   ${job.url}`);
}

await saveJson(
  path.join(DATA_DIR, "jobs.json"),
  finalJobs
);

await page.screenshot({
  path: path.join(
    SCREENSHOT_DIR,
    "99-finished.png"
  ),
  fullPage: true,
});

console.log("");
console.log(
  `Found ${finalJobs.length} jobs.`
);

if (finalJobs.length < 30) {
  console.warn(
    `WARNING: Expected 30 jobs but found ${finalJobs.length}.`
  );
}

if (finalJobs.length === 0) {
  await browser.close();

  throw new Error(
    "Flockler responded, but no recognisable job records were found. " +
    "Check screenshots/flockler-responses/ and flockler-debug.json."
  );
}

await browser.close();

console.log("Scrape completed successfully.");
```
