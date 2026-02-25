import { Hono } from "hono";
import puppeteer from "@cloudflare/puppeteer";

interface Env {
  BROWSER: Fetcher;
  SCREENSHOT_BUCKET: R2Bucket;
  // A public custom domain attached to the R2 bucket for easy viewing
  PUBLIC_CDN_URL: string; 
}

interface AuditRequest {
  url: string;
  viewport?: { width: number; height: number };
  waitForSelector?: string;
  fullPage?: boolean;
}

const app = new Hono<{ Bindings: Env }>();

app.post("/api/audit", async (c) => {
  const reqData = await c.req.json<AuditRequest>();
  const targetUrl = reqData.url;

  if (!targetUrl) {
    return c.json({ success: false, error: "Missing 'url' parameter" }, 400);
  }

  let browser;
  try {
    // 1. Launch Headless Chromium via Cloudflare's Browser Rendering API
    browser = await puppeteer.launch(c.env.BROWSER);
    const page = await browser.newPage();

    // Configure viewport (default to Desktop 1080p)
    await page.setViewport(reqData.viewport || { width: 1920, height: 1080 });

    const consoleLogs: string[] = [];
    const pageErrors: string[] = [];
    const networkErrors: string[] = [];

    // 2. Attach Event Listeners to catch hidden SPA bugs
    page.on("console", (msg) => {
      if (msg.type() === "error" || msg.type() === "warning") {
        consoleLogs.push(`[${msg.type().toUpperCase()}] ${msg.text()}`);
      }
    });
    
    page.on("pageerror", (err) => {
      pageErrors.push(err.message);
    });

    page.on("requestfailed", (request) => {
      networkErrors.push(`${request.url()} - ${request.failure()?.errorText}`);
    });

    // 3. Navigate to the page and wait for the network to idle (SPA hydration)
    const startTime = Date.now();
    const response = await page.goto(targetUrl, { 
      waitUntil: "networkidle0",
      timeout: 30000 
    });
    const loadTimeMs = Date.now() - startTime;

    if (reqData.waitForSelector) {
      await page.waitForSelector(reqData.waitForSelector, { timeout: 5000 });
    }

    // 4. Extract basic SEO & Accessibility Metadata
    const title = await page.title();
    const metaDescription = await page.$eval(
      'meta[name="description"]', 
      (el) => el.getAttribute("content") || ""
    ).catch(() => null);

    // 5. Take the Screenshot
    const screenshotBuffer = await page.screenshot({ 
      fullPage: reqData.fullPage ?? true,
      type: "webp",
      quality: 80
    });

    // 6. Save the screenshot to R2 Object Storage
    const fileKey = `audits/${crypto.randomUUID()}.webp`;
    await c.env.SCREENSHOT_BUCKET.put(fileKey, screenshotBuffer, {
      httpMetadata: { contentType: "image/webp" }
    });

    // 7. Return the comprehensive report
    return c.json({
      success: true,
      data: {
        url: targetUrl,
        httpStatus: response?.status() || 200,
        loadTimeMs,
        seo: {
          title,
          metaDescription
        },
        diagnostics: {
          consoleWarningsAndErrors: consoleLogs,
          uncaughtPageErrors: pageErrors,
          failedNetworkRequests: networkErrors
        },
        screenshotUrl: `${c.env.PUBLIC_CDN_URL}/${fileKey}`
      }
    });

  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : "Browser execution failed";
    return c.json({ success: false, error: errMsg }, 500);
  } finally {
    // CRITICAL: Always close the browser to free up the session binding
    if (browser) {
      await browser.close();
    }
  }
});

export default app;
