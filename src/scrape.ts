import { chromium, Page } from "playwright";
import fs from "fs/promises";
import path from "path";

const CAREERS_URL = process.env.CAREERS_URL;

if (!CAREERS_URL) {
  throw new Error("CAREERS_URL environment variable is not set");
}

const TARGET_JOBS = 30;

interface Job {
  title: string;
  location: string;
  url: string;
}

async function saveScreenshot(
  page: Page,
  filename: string
): Promise<void> {
  await fs.mkdir("screenshots", { recursive: true });

  await page.screenshot({
    path: path.join("screenshots", filename),
    fullPage: true,
  });

  console.log(`Screenshot saved: screenshots/${filename}`);
}

async function main(): Promise<void> {
  console.log("Starting scraper...");
  console.log(`Target URL: ${CAREERS_URL}`);
  console.log(`Target jobs: ${TARGET_JOBS}`);

  const browser = await chromium.launch({
    headless: true,
  });

  const context = await browser.newContext({
    viewport: {
      width: 1440,
      height: 1200,
    },

    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();

  /*
   * Capture useful network requests.
   *
   * Phenom sites commonly load jobs dynamically through XHR/fetch.
   * We don't depend on this for extraction yet, but logging these
   * requests makes debugging much easier.
   */
  page.on("response", async (response) => {
    const url = response.url();

    const looksInteresting =
      /job|jobs|search|api|phenom/i.test(url);

    if (!looksInteresting) {
      return;
    }

    const contentType =
      response.headers()["content-type"] || "";

    if (
      contentType.includes("application/json") ||
      contentType.includes("text/json")
    ) {
      console.log(
        `[JSON] ${response.status()} ${url}`
      );
    }
  });

  /*
   * Log browser errors.
   */
  page.on("console", (message) => {
    if (message.type() === "error") {
      console.log(`[PAGE ERROR] ${message.text()}`);
    }
  });

  page.on("pageerror", (error) => {
    console.log(`[PAGE EXCEPTION] ${error.message}`);
  });

  try {
    /*
     * ------------------------------------------------------------
     * 1. Open careers page
     * ------------------------------------------------------------
     */

    console.log("Opening careers page...");

    await page.goto(CAREERS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 120_000,
    });

    console.log(`Loaded: ${await page.title()}`);

    await saveScreenshot(page, "01-home.png");

    /*
     * Give the JavaScript application time to initialize.
     */
    await page.waitForTimeout(5_000);

    await saveScreenshot(page, "02-after-js.png");

    /*
     * ------------------------------------------------------------
     * 2. Try to handle cookie consent
     * ------------------------------------------------------------
     */

    console.log("Checking for cookie consent...");

    const cookieSelectors = [
      'button:has-text("Accept")',
      'button:has-text("Accept All")',
      'button:has-text("Accept all")',
      'button:has-text("I Agree")',
      'button:has-text("Agree")',
      '[id*="accept"]',
      '[class*="accept"]',
    ];

    for (const selector of cookieSelectors) {
      try {
        const button = page.locator(selector).first();

        if (await button.isVisible({ timeout: 1_000 })) {
          console.log(
            `Cookie button found: ${selector}`
          );

          await button.click();

          await page.waitForTimeout(1_000);

          break;
        }
      } catch {
        // Selector not present; continue.
      }
    }

    /*
     * ------------------------------------------------------------
     * 3. Look for Product & Tech
     * ------------------------------------------------------------
     */

    console.log(
      "Looking for Product & Tech filter..."
    );

    const productTechPatterns = [
      /Product\s*&\s*Tech/i,
      /Product\s+and\s+Tech/i,
      /Product.*Tech/i,
    ];

    let filterClicked = false;

    for (const pattern of productTechPatterns) {
      try {
        const candidates = page.getByText(pattern);

        const count = await candidates.count();

        console.log(
          `Found ${count} candidates for ${pattern}`
        );

        for (let i = 0; i < count; i++) {
          const candidate = candidates.nth(i);

          if (
            await candidate.isVisible({
              timeout: 1_000,
            })
          ) {
            console.log(
              "Clicking Product & Tech filter..."
            );

            await candidate.scrollIntoViewIfNeeded();

            await candidate.click();

            filterClicked = true;

            break;
          }
        }

        if (filterClicked) {
          break;
        }
      } catch {
        // Try next pattern.
      }
    }

    if (!filterClicked) {
      console.log(
        "WARNING: Could not find Product & Tech filter."
      );

      /*
       * Save useful debugging information.
       */
      await fs.writeFile(
        "screenshots/page.html",
        await page.content(),
        "utf-8"
      );

      console.log(
        "Saved current HTML to screenshots/page.html"
      );
    }

    /*
     * Give the Phenom widget time to update.
     */
    await page.waitForTimeout(5_000);

    await saveScreenshot(
      page,
      "03-after-product-tech.png"
    );

    /*
     * ------------------------------------------------------------
     * 4. Wait for jobs
     * ------------------------------------------------------------
     */

    console.log("Waiting for job listings...");

    await page.waitForTimeout(5_000);

    /*
     * ------------------------------------------------------------
     * 5. Discover possible job links
     * ------------------------------------------------------------
     */

    async function getJobLinks(): Promise<Job[]> {
      const links = await page.locator("a").evaluateAll(
        (anchors) => {
          return anchors.map((anchor) => {
            const element =
              anchor as HTMLAnchorElement;

            return {
              text:
                element.innerText?.trim() || "",
              href:
                element.href || "",
            };
          });
        }
      );

      const results: Job[] = [];
      const seen = new Set<string>();

      for (const link of links) {
        if (!link.href) {
          continue;
        }

        /*
         * Look for likely job URLs.
         *
         * This intentionally accepts several patterns because
         * Phenom deployments can use different URL structures.
         */
        const looksLikeJob =
          /\/job\//i.test(link.href) ||
          /\/jobs\//i.test(link.href) ||
          /\/job\?/i.test(link.href) ||
          /jobId=/i.test(link.href);

        if (!looksLikeJob) {
          continue;
        }

        if (seen.has(link.href)) {
          continue;
        }

        seen.add(link.href);

        results.push({
          title: link.text,
          location: "",
          url: link.href,
        });
      }

      return results;
    }

    let jobs = await getJobLinks();

    console.log(
      `Found ${jobs.length} possible job links.`
    );

    /*
     * ------------------------------------------------------------
     * 6. Load more jobs
     * ------------------------------------------------------------
     */

    let loadMoreAttempts = 0;
    const MAX_LOAD_MORE_ATTEMPTS = 20;

    while (
      jobs.length < TARGET_JOBS &&
      loadMoreAttempts < MAX_LOAD_MORE_ATTEMPTS
    ) {
      loadMoreAttempts++;

      console.log(
        `Load-more attempt ${loadMoreAttempts}. ` +
        `Currently have ${jobs.length} jobs.`
      );

      const loadMorePatterns = [
        /Load\s+More/i,
        /Show\s+More/i,
        /More\s+Jobs/i,
        /View\s+More/i,
      ];

      let clicked = false;

      for (const pattern of loadMorePatterns) {
        try {
          const buttons = page.getByRole(
            "button",
            { name: pattern }
          );

          const count = await buttons.count();

          for (let i = 0; i < count; i++) {
            const button = buttons.nth(i);

            if (
              await button.isVisible({
                timeout: 1_000,
              })
            ) {
              console.log(
                `Clicking load-more button: ${pattern}`
              );

              await button.scrollIntoViewIfNeeded();

              await button.click();

              clicked = true;

              break;
            }
          }

          if (clicked) {
            break;
          }
        } catch {
          // Try next pattern.
        }
      }

      if (!clicked) {
        console.log(
          "No Load More button found."
        );

        /*
         * Try scrolling. Some Phenom implementations use
         * infinite scrolling instead of a button.
         */
        await page.evaluate(() => {
          window.scrollTo(
            0,
            document.body.scrollHeight
          );
        });

        await page.waitForTimeout(3_000);

        const newJobs = await getJobLinks();

        if (newJobs.length === jobs.length) {
          console.log(
            "Scrolling did not reveal additional jobs."
          );
          break;
        }

        jobs = newJobs;
        continue;
      }

      /*
       * Wait for the network/widget to update.
       */
      await page.waitForTimeout(3_000);

      try {
        await page.waitForLoadState(
          "networkidle",
          { timeout: 15_000 }
        );
      } catch {
        // networkidle may never happen on a SPA.
      }

      jobs = await getJobLinks();

      console.log(
        `Now have ${jobs.length} possible jobs.`
      );

      await saveScreenshot(
        page,
        `load-more-${loadMoreAttempts}.png`
      );
    }

    /*
     * ------------------------------------------------------------
     * 7. Final extraction
     * ------------------------------------------------------------
     */

    jobs = await getJobLinks();

    console.log(
      `Final discovered job count: ${jobs.length}`
    );

    /*
     * Remove obvious non-job entries.
     */
    jobs = jobs.filter(
      (job) =>
        job.title &&
        job.title.length > 2 &&
        job.url
    );

    /*
     * Deduplicate.
     */
    const uniqueJobs: Job[] = [];
    const seenUrls = new Set<string>();

    for (const job of jobs) {
      if (seenUrls.has(job.url)) {
        continue;
      }

      seenUrls.add(job.url);
      uniqueJobs.push(job);
    }

    /*
     * Take exactly 30.
     */
    const finalJobs = uniqueJobs.slice(
      0,
      TARGET_JOBS
    );

    /*
     * ------------------------------------------------------------
     * 8. Save results
     * ------------------------------------------------------------
     */

    await fs.mkdir("data", {
      recursive: true,
    });

    const output = {
      scrapedAt: new Date().toISOString(),
      source: CAREERS_URL,
      category: "Product & Tech",
      requested: TARGET_JOBS,
      returned: finalJobs.length,
      jobs: finalJobs,
    };

    await fs.writeFile(
      "data/jobs.json",
      JSON.stringify(
        output,
        null,
        2
      ),
      "utf-8"
    );

    console.log(
      `Saved ${finalJobs.length} jobs to data/jobs.json`
    );

    /*
     * ------------------------------------------------------------
     * 9. Final screenshot
     * ------------------------------------------------------------
     */

    await saveScreenshot(
      page,
      "99-finished.png"
    );

    /*
     * ------------------------------------------------------------
     * 10. Fail the workflow if we didn't get 30
     * ------------------------------------------------------------
     *
     * This is intentional. It prevents GitHub Actions from
     * silently committing an incomplete result if the site
     * changes or Cloudflare interferes.
     */

    if (finalJobs.length < TARGET_JOBS) {
      console.error(
        `ERROR: Expected ${TARGET_JOBS} jobs, ` +
        `but only found ${finalJobs.length}.`
      );

      process.exitCode = 1;
    }
  } finally {
    /*
     * IMPORTANT:
     * This closes the Chromium browser.
     */
    await browser.close();

    console.log("Browser closed.");
  }
}

main().catch((error) => {
  console.error(
    "Scraper failed:",
    error
  );

  process.exit(1);
});
