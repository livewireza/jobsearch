import os
import json
import asyncio
from pathlib import Path

from pydantic import BaseModel
from playwright.async_api import async_playwright
from browser_use import Agent
from browser_use.browser.profile import BrowserProfile
from langchain_google_genai import ChatGoogleGenerativeAI


class Job(BaseModel):
    title: str
    location: str
    url: str


class JobList(BaseModel):
    jobs: list[Job]


CAREERS_URL = os.environ["CAREERS_URL"]

TASK = f"""
Open the careers website at:

{CAREERS_URL}

Instructions:
1. Wait until the page is fully loaded.
2. Filter to ONLY the 'Product & Tech' category.
3. If only 10 jobs are visible, press 'Load more' repeatedly.
4. Continue until at least 30 Product & Tech jobs are available.
5. Extract exactly 30 unique jobs.

Return ONLY JSON matching this schema:
{{
  "jobs":[
    {{
      "title":"",
      "location":"",
      "url":""
    }}
  ]
}}
"""

CDP_PORT = 9222


async def main():
    llm = ChatGoogleGenerativeAI(
        model="gemini-2.5-flash",
        google_api_key=os.environ["GEMINI_API_KEY"],
        temperature=0,
    )

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                f"--remote-debugging-port={CDP_PORT}",
            ],
        )

        browser_profile = BrowserProfile(
            cdp_url=f"http://localhost:{CDP_PORT}",
        )

        agent = Agent(
            task=TASK,
            llm=llm,
            output_model_schema=JobList,
            browser_profile=browser_profile,
        )

        result = await agent.run()

        await browser.close()

    output_dir = Path("data")
    output_dir.mkdir(exist_ok=True)

    output_file = output_dir / "jobs.json"

    with output_file.open("w", encoding="utf-8") as f:
        json.dump(
            result.model_dump(),
            f,
            indent=2,
            ensure_ascii=False,
        )

    print(f"Saved {len(result.jobs)} jobs to {output_file}")


if __name__ == "__main__":
    asyncio.run(main())
