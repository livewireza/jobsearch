import os
import json
import asyncio
from pathlib import Path
from dotenv import load_dotenv
from pydantic import BaseModel
from browser_use import Agent, ChatGoogle

load_dotenv()

CAREERS_URL = os.environ["CAREERS_URL"]

class Job(BaseModel):
    title: str
    location: str
    url: str

class Jobs(BaseModel):
    jobs: list[Job]

TASK = f"""
Open this careers website:

{CAREERS_URL}

1. Filter by the 'Product & Tech' category.
2. If only 10 jobs are visible, click 'Load more' until at least 30 are visible.
3. Extract exactly 30 unique jobs.
4. Return ONLY JSON matching the schema.

Fields:
- title
- location
- url
"""

async def main():
    agent = Agent(
        task=TASK,
        llm=ChatGoogle(model="gemini-2.5-flash"),
        output_model_schema=Jobs,
        use_vision=True,
    )

    result: Jobs = await agent.run()

    output = {
        "source": "career-site",
        "count": len(result.jobs),
        "jobs": [j.model_dump() for j in result.jobs]
    }

    Path("jobs.json").write_text(
        json.dumps(output, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    print(f"Saved {len(result.jobs)} jobs to jobs.json")

if __name__ == "__main__":
    asyncio.run(main())
