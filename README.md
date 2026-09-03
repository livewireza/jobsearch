Initially I thought this isn't possible to retrieve listings from a page that uses Phenom. 

Rather than serving a clean HTML with job posts, Phenom operates as a decoupled SPA driven almost entirely by client-side JavaScript, client-side tracking, 
and dynamic API fetches.

There's heavy framework rendering happening. 
Pages load an initial shell containing minimal markup; job content is injected dynamically via asynchronous REST requests to Phenom’s microservices.


Traditional Scraping (Fails)
Client  ───► Request Page ───► Server Returns Empty HTML Shell (No Jobs)

Phenom Scraping Challenge
Client  ───► Page Shell ───► JS Bundle Runs ───► POST Payload (Session, Token, Filters) ───► Gateway API ───► Rendered UI


1. Payload & Endpoint Obfuscation
Phenom does not rely on simple, predictable URLs (e.g., /jobs?page=2). Instead, job data is retrieved via POST requests sent to internal, domain-specific
endpoints (often routes like phApp/ph-api/v1/... or /refine_search on the employer's domain).

3. Session Context and Cryptographic Tokens
Requests to Phenom’s underlying search endpoints usually require context headers, CSRF tokens, dynamic device/fingerprint IDs, or localized session tokens generated at runtime by
their frontend JavaScript bundles (phApp.js). Replaying raw GET or POST requests without these headers results in 403 Forbidden or 401 Unauthorized responses.

4. Client-Side Rendering (DOM Hydration)
If you attempt to scrape the site using raw HTTP clients (like Python’s requests or BeautifulSoup), you will only capture empty template containers.
The job list does not exist in the DOM until the client bundle executes, initializes state, and resolves its internal network calls.

5. WAF & Bot Detection
Phenom career sites are frequently wrapped in enterprise WAFs (such as Cloudflare, Akamai, or Imperva) that detect automated headless browser instances (Puppeteer/Playwright defaults)
via canvas fingerprinting, TLS fingerprinting, and behavioral analysis.

| Approach | Reliability | Speed | Maintenance |
| :--- | :--- | :--- | :--- |
| **Direct REST API Calls** | High | Fast (~100ms/req) | Moderate (breaks if payload structure changes) |
| **Network Interception (Playwright/Puppeteer)** | High | Moderate (requires browser execution) | Low (resilient to DOM/CSS class changes) |
| **JSON-LD / Window State Extraction** | High (for single postings) | Fast | Low (uses standardized schema.org format) |
| **DOM Scraping (HTML Parsing)** | Very Low | Slow | High (extremely brittle against UI updates) |

Solution:
Direct REST API Calls — the working version POSTs directly to Job Site /widgets with a hardcoded JSON payload, then paginates via the from offset. 
Playwright is only kept in the loop to acquire the CSRF token (captured from any /widgets request the page fires, with a fallback to parsing it from the PLAY_SESSION JWT cookie). 
Once the token is in hand the browser closes and everything else is pure fetch. :)

