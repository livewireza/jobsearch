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

type Job = {
  title: string;
  url: string;
  sourceUrl?: string;
  description?: string;
};

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

const flocklerResponses: Array<{
  url: string;
  status: number;
  body: FlocklerResponse;
}> = [];

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
  if (!url) return false;

  return (
    /\/job\//i.test(url) ||
    /\/jobs\//i.test(url) ||
    /\/job\?/i.test(url) ||
    /jobId=/i.test(url) ||
    /jobid=/i.test(url)
  );
}

function normaliseUrl(url: string): string {
  if (!url) return "";

  try {
    return new URL(url, CAREERS_URL).href;
  } catch {
    return url;
  }
}

function extractJobs(posts: FlocklerPost[]): Job[] {
  const jobs: Job[] = [];

  for (const post of posts) {
    const title = typeof post.title === "string"
      ? post.title.trim()
      : "";

    if (!title) continue;

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

    jobs.push({
      title,
      url: jobUrl,
      ...(post.sourceUrl
        ? { sourceUrl: normaliseUrl(post.sourceUrl) }
        : {}),
      ...(post.textPlain
        ? { description: post.textPlain.trim() }
        : {}),
    });
  }

  return jobs;
}

function dedupeJobs(jobs: Job[]): Job[] {
  const seen = new Set<string>();
  const result: Job[] = [];

  for (const job of jobs) {
    const key = job.url || job.title;

    if (seen.has(key)) continue;

    seen.add(key);
    result.push(job);
  }

  return result;
}

async function saveJson(filePath: string, data: unknown): Promise<void> {
  await fs.writeFile(
    filePath,
    JSON.stringify(data, null, 2),
    "utf8"
  );
}

async function saveFlocklerResponse(
  index: number,
  url: string,
  status: number,
  body: FlocklerResponse
): Promise<void> {
  const filename = `response-${String(index).padStart(2, "0")}.json`;

  await saveJson(
    path.join(FLOCKLER_DIR, filename),
    {
      url,
      status,
      body,
    }
  );
}

async function inspectPage(page: Page): Promise<void> {
  console.log("\n=== PAGE STRUCTURE ===");

  const headings = await page.locator("h1,h2,h3,h4").allTextContents();

  console.log("Headings:");
  for (const heading of headings) {
    const text = heading.trim();
    if (text) {
      console.log(`  ${text}`);
    }
  }

  const buttons = await page.locator("button").evaluateAll((elements) =>
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
      `  text="${button.text}" aria="${button.ariaLabel}" type="${button.type}" disabled=${button.disabled}`
    );
  }

  const links = await page.locator("a").evaluateAll((elements) =>
    elements
      .map((element) => ({
        text: (element.textContent || "").trim(),
        href: element.getAttribute("href"),
      }))
      .filter((item) => item.text || item.href)
  );

  console.log("\nJob-looking links:");

  for (const link of links) {
    if (link.href && isLikelyJobUrl(normaliseUrl(link.href))) {
      console.log(`  ${link.text} -> ${link.href}`);
    }
  }

  console.log("========================\n");
}

async function requestWithCount(
  page: Page,
  originalUrl: string,
  count: number
): Promise<FlocklerResponse | null> {
  try {
    const url = new URL(originalUrl);

    url.searchParams.set("count", String(count));

    console.log(`\nRequesting Flockler with count=${count}`);
    console.log(url.href);

    const response = await page.request.get(url.href, {
      headers: {
        accept: "application/json, text/plain, */*",
      },
    });

    console.log(
      `Flockler count=${count}: HTTP ${response.status()}`
    );

    if (!response.ok()) {
      const text = await response.text();

      console.log(
        `Flockler count=${count} failed response: ${text.slice(0, 1000)}`
      );

      return null;
    }

    const json = (await response.json()) as FlocklerResponse;

    await saveJson(
      path.join(FLOCKLER_DIR, `count-${count}.json`),
      {
        requestedUrl: url.href,
        status: response.status(),
        body: json,
      }
    );

    return json;
  } catch (error) {
    console.error(
      `Error requesting Flockler with count=${count}:`,
      error
    );

    return null;
  }
}

async function requestCursor(
  page: Page,
  originalUrl: string,
  cursor: string
): Promise<FlocklerResponse | null> {
  try {
    const url = new URL(originalUrl);

    url.searchParams.set("olderThanCursor", cursor);
    url.searchParams.set("count", "30");

    console.log("\nRequesting older Flockler page:");
    console.log(url.href);

    const response = await page.request.get(url.href, {
      headers: {
        accept: "application/json, text/plain, */*",
      },
    });

    console.log(
      `Flockler cursor request: HTTP ${response.status()}`
    );

    if (!response.ok()) {
      console.log(
        `Cursor request failed: ${(await response.text()).slice(0, 1000)}`
      );

      return null;
    }

    const json = (await response.json()) as FlocklerResponse;

    const index = flocklerResponses.length + 1;

    await saveFlocklerResponse(
      index,
      url.href,
      response.status(),
      json
    );

    return json;
  } catch (error) {
    console.error("Error requesting Flockler cursor:", error);
    return null;
  }
}

console.log("========================================");
console.log("JET Tech & Product scraper");
console.log("========================================");
console.log(`CAREERS_URL: ${CAREERS_URL}`);
console.log("");

const browser = await chromium.launch({
  headless: true,
});

const context = await browser.newContext({
  viewport: {
    width: 1440,
    height: 1000,
  },
  userAgent:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
});

const page = await context.newPage();

/*
 * Capture the actual Flockler widget response.
 *
 * This is the important part of the scraper. We are deliberately
 * not clicking "Product & Tech", because the URL itself is already
 * the Tech & Product jobs page.
 */
let firstFlocklerUrl: string | null = null;
let flocklerResponsePromise: Promise<void> | null = null;

page.on("response", async (response: Response) => {
  const url = response.url();

  if (!isFlocklerPostsUrl(url)) {
    return;
  }

  console.log("\n========================================");
  console.log("FLOCKLER RESPONSE");
  console.log("========================================");
  console.log(`Status: ${response.status()}`);
  console.log(`URL: ${url}`);

  if (!firstFlocklerUrl) {
    firstFlocklerUrl = url;
  }

  try {
    const json = (await response.json()) as FlocklerResponse;

    flocklerResponses.push({
      url,
      status: response.status(),
      body: json,
    });

    const index = flocklerResponses.length;

    await saveFlocklerResponse(
      index,
      url,
      response.status(),
      json
    );

    const posts = Array.isArray(json.posts)
      ? json.posts
      : [];

    console.log(`Posts returned: ${posts.length}`);

    if (json.pagination) {
      console.log(
        `Pagination older: ${json.pagination.older ?? "none"}`
      );

      console.log(
        `Pagination newer: ${json.pagination.newer ?? "none"}`
      );
    }

    console.log("Post titles:");

    for (const post of posts) {
      console.log(
        `  - ${typeof post.title === "string" ? post.title : "(no title)"}`
      );
    }

    console.log("========================================\n");
  } catch (error) {
    console.error("Could not parse Flockler response:", error);
  }
});

console.log("Opening careers page...");

await page.goto(CAREERS_URL, {
  waitUntil: "domcontentloaded",
  timeout: 90_000,
});

console.log(`Page title: ${await page.title()}`);

await page.screenshot({
  path: path.join(SCREENSHOT_DIR, "01-home.png"),
  fullPage: true,
});

console.log("Waiting for JavaScript/widget...");

/*
 * Give Phenom/Flockler enough time to initialise.
 */
await page.waitForTimeout(10_000);

await page.screenshot({
  path: path.join(SCREENSHOT_DIR, "02-after-js.png"),
  fullPage: true,
});

/*
 * Save the rendered DOM. This is useful if the site changes its
 * widget implementation later.
 */
await fs.writeFile(
  path.join(SCREENSHOT_DIR, "page.html"),
  await page.content(),
  "utf8"
);

await inspectPage(page);

/*
 * Wait a little longer in case the widget loads after the initial
 * 10-second delay.
 */
if (!firstFlocklerUrl) {
  console.log("No Flockler response yet; waiting another 10 seconds...");
  await page.waitForTimeout(10_000);
}

/*
 * At this point we should have the actual widget request URL.
 */
if (!firstFlocklerUrl) {
  console.error("No Flockler /posts response was captured.");

  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "99-no-flockler.png"),
    fullPage: true,
  });

  await browser.close();

  throw new Error(
    "Could not find the Flockler job-widget response."
  );
}

console.log("\n========================================");
console.log("INITIAL FLOCKLER REQUEST");
console.log("========================================");
console.log(firstFlocklerUrl);

/*
 * Extract jobs from the normal browser response first.
 */
let allJobs: Job[] = [];

for (const item of flocklerResponses) {
  const posts = Array.isArray(item.body.posts)
    ? item.body.posts
    : [];

  allJobs.push(...extractJobs(posts));
}

allJobs = dedupeJobs(allJobs);

console.log(`\nJobs from browser response: ${allJobs.length}`);

/*
 * IMPORTANT:
 *
 * The browser's request showed count=12.
 *
 * Flockler's API supports larger counts, so first try the exact
 * same widget URL with count=30 using Playwright's request context.
 *
 * This keeps us inside the same browser/session rather than
 * inventing a separate scraper endpoint.
 */
const count30Response = await requestWithCount(
  page,
  firstFlocklerUrl,
  30
);

if (count30Response) {
  const posts = Array.isArray(count30Response.posts)
    ? count30Response.posts
    : [];

  console.log(
    `\nPosts returned from count=30 request: ${posts.length}`
  );

  allJobs = dedupeJobs([
    ...allJobs,
    ...extractJobs(posts),
  ]);

  console.log(
    `Unique jobs after count=30 request: ${allJobs.length}`
  );
}

/*
 * If count=30 didn't give us enough jobs, follow the Flockler
 * "older" cursor if one exists.
 */
let cursor: string | null =
  count30Response?.pagination?.older ?? null;

const maxCursorPages = 10;
let cursorPage = 0;

while (allJobs.length < 30 && cursor && cursorPage < maxCursorPages) {
  cursorPage++;

  console.log(
    `\nFollowing Flockler older cursor page ${cursorPage}...`
  );

  const olderResponse = await requestCursor(
    page,
    firstFlocklerUrl,
    cursor
  );

  if (!olderResponse) {
    break;
  }

  const posts = Array.isArray(olderResponse.posts)
    ? olderResponse.posts
    : [];

  const olderJobs = extractJobs(posts);

  console.log(
    `Jobs from cursor page: ${olderJobs.length}`
  );

  allJobs = dedupeJobs([
    ...allJobs,
    ...olderJobs,
  ]);

  console.log(
    `Total unique jobs: ${allJobs.length}`
  );

  cursor =
    olderResponse.pagination?.older ?? null;
}

/*
 * Save the complete raw debugging information.
 */
await saveJson(
  path.join(SCREENSHOT_DIR, "flockler-debug.json"),
  {
    careersUrl: CAREERS_URL,
    firstFlocklerUrl,
    responseCount: flocklerResponses.length,
    responses: flocklerResponses,
    extractedJobs: allJobs,
  }
);

/*
 * Keep only the first 30 if more than 30 were returned.
 */
const finalJobs = allJobs.slice(0, 30);

console.log("\n========================================");
console.log("FINAL JOBS");
console.log("========================================");

for (const [index, job] of finalJobs.entries()) {
  console.log(
    `${index + 1}. ${job.title}\n   ${job.url}`
  );
}

console.log(
  `\nTotal unique jobs found: ${allJobs.length}`
);
console.log(
  `Jobs written to data/jobs.json: ${finalJobs.length}`
);

await saveJson(
  path.join(DATA_DIR, "jobs.json"),
  finalJobs
);

await page.screenshot({
  path: path.join(SCREENSHOT_DIR, "99-finished.png"),
  fullPage: true,
});

/*
 * We only consider the scrape unsuccessful if the actual widget
 * produced no job records at all.
 */
if (finalJobs.length === 0) {
  await browser.close();

  throw new Error(
    "Flockler responded, but no job posts with recognisable job URLs were found. " +
    "Inspect screenshots/flockler-responses/ and screenshots/flockler-debug.json."
  );
}

if (finalJobs.length < 30) {
  console.warn(
    `WARNING: Only ${finalJobs.length} jobs were found; expected 30.`
  );

  console.warn(
    "The scraper succeeded technically, but Flockler did not expose 30 jobs."
  );

  console.warn(
    "Inspect screenshots/flockler-responses/ to determine the pagination schema."
  );
}

await browser.close();

console.log("\nScrape completed.");
```
