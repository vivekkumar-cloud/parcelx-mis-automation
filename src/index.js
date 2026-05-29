const { chromium } = require('playwright');
require('dotenv').config();

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
    parcelx: {
          basicUser: process.env.PARCELX_BASIC_USER,
          basicPass: process.env.PARCELX_BASIC_PASS,
          formUser:  process.env.PARCELX_FORM_USER,
          formPass:  process.env.PARCELX_FORM_PASS,
    },
};

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── PARCELX LOGIN ────────────────────────────────────────────────────────────
async function loginParcelX(page) {
    log('Logging into ParcelX...');

  // Step 1: Basic Auth via URL + navigate
  await page.goto(
        `https://${CONFIG.parcelx.basicUser}:${CONFIG.parcelx.basicPass}@panel.parcelx.in/`,
    { waitUntil: 'domcontentloaded', timeout: 30000 }
      );
    await sleep(2000);

  // Step 2: Fill login form
  await page.fill(
        'input[name="username"], input[placeholder*="Username" i], input[type="text"]',
        CONFIG.parcelx.formUser
      );
    await page.fill('input[type="password"]', CONFIG.parcelx.formPass);

  // Step 3: Submit
  await page.evaluate(() => {
        const btn = document.querySelector('button[type="submit"], input[type="submit"]');
        if (btn) btn.click();
  });

  await sleep(3000);
    await page.waitForLoadState('networkidle', { timeout: 20000 });
    log('Logged into ParcelX ✅');
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
    log('Starting ParcelX MIS Automation...');

  const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        acceptDownloads: true,
  });

  const page = await context.newPage();

  try {
        await loginParcelX(page);
        log('Login successful! Ready for next step ✅');
        // NEXT STEPS WILL GO HERE
  } catch (err) {
        log(`Error: ${err.message}`);
        process.exit(1);
  } finally {
        await browser.close();
  }
}

main();
