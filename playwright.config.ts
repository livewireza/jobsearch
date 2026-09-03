import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./src",
  timeout: 180000,
  use: {
    headless: true,
    viewport: { width: 1440, height: 1200 },
    screenshot: "off",
    trace: "on-first-retry"
  }
});
