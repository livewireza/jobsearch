import { test, expect } from "@playwright/test";
import fs from "fs/promises";

const CAREERS_URL = process.env.CAREERS_URL!;

test("Scrape 30 Product & Tech jobs", async ({ page }) => {
  const jobs: any[] = [];

  await fs.mkdir("screenshots", { recursive: true });
  await fs.mkdir("data", { recursive: true });

  // Capture the JSON requests Phenom makes
  page.on("response", async (response) => {
    const url = response.url();

    if (!url.includes("search") && !url.includes("job"))
      return;

    try {
      const json = await response.json();

      const possibleJobs =
        json.jobs ||
        json.data?.jobs ||
        json.jobResults ||
        [];

      for (const job of possibleJobs) {
        jobs.push({
          title: job.title,
          location: job.location,
          url: job.url || job.jobUrl
        });
      }
    } catch {}
  });

  await page.goto(CAREERS_URL, {
    waitUntil: "domcontentloaded"
  });

  await page.waitForLoadState("networkidle");

  await page.screenshot({
    path: "screenshots/01-home.png",
    fullPage: true
  });

  // Accept cookies if present
  const cookieButton = page.getByRole("button", {
    name: /accept|agree/i
  });

  if (await cookieButton.isVisible().catch(() => false))
    await cookieButton.click();

  // Product & Tech filter
  await page
    .getByText(/Product\s*&\s*Tech/i)
    .first()
    .click();

  await page.waitForLoadState("networkidle");

  await page.screenshot({
    path: "screenshots/02-filtered.png",
    fullPage: true
  });

  // Keep loading until we have 30 visible cards
  while (true) {
    const cards = page.locator("a[href*='/job/'], a[href*='/jobs/']");

    const count = await cards.count();

    if (count >= 30)
      break;

    const loadMore = page.getByRole("button", {
      name: /load more/i
    });

    if (!(await loadMore.isVisible().catch(() => false)))
      break;

    await loadMore.click();

    await page.waitForLoadState("networkidle");

    await page.screenshot({
      path: `screenshots/load-${count}.png`,
      fullPage: true
    });
  }

  // DOM extraction (more reliable than network)
  const extracted = await page
    .locator("a[href*='/job/'], a[href*='/jobs/']")
    .evaluateAll((links) => {
      const seen = new Set();

      return links
        .map((link) => {
          const card = link.closest("div");

          const title =
            card?.querySelector("h2,h3,h4")?.textContent?.trim() || "";

          const text = card?.textContent || "";

          return {
            title,
            location: text,
            url: (link as HTMLAnchorElement).href
          };
        })
        .filter((j) => {
          if (!j.url || seen.has(j.url))
            return false;
          seen.add(j.url);
          return j.title;
        });
    });

  const finalJobs = extracted.slice(0, 30);

  expect(finalJobs.length).toBeGreaterThan(0);

  await fs.writeFile(
    "data/jobs.json",
    JSON.stringify(
      {
        scrapedAt: new Date().toISOString(),
        total: finalJobs.length,
        jobs: finalJobs
      },
      null,
      2
    )
  );

  await page.screenshot({
    path: "screenshots/99-finished.png",
    fullPage: true
  });
});
