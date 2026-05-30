const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { parse } = require('csv-parse/sync');
require('dotenv').config();

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG = {
  parcelx: {
    basicUser: process.env.PARCELX_BASIC_USER,
    basicPass: process.env.PARCELX_BASIC_PASS,
    formUser:  process.env.PARCELX_FORM_USER,
    formPass:  process.env.PARCELX_FORM_PASS,
  },
  appsScript: {
    url: 'https://script.google.com/macros/s/AKfycbx5srAWp28mP8d6LvCoo_3osOedKVjAOddeWq-ML7x0V4NvRAdOwOhGUrwqplGn4Njd/exec',
  },
};

const DOWNLOAD_DIR = path.join(__dirname, '..', 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getToday() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${d.getFullYear()}`;
}

// ─── STEP 1: LOGIN ────────────────────────────────────────────────────────────
async function loginParcelX(page) {
  log('Logging into ParcelX...');
  await page.goto(
    `https://${CONFIG.parcelx.basicUser}:${CONFIG.parcelx.basicPass}@panel.parcelx.in/`,
    { waitUntil: 'domcontentloaded', timeout: 30000 }
  );
  await sleep(2000);
  await page.fill(
    'input[name="username"], input[placeholder*="Username" i], input[type="text"]',
    CONFIG.parcelx.formUser
  );
  await page.fill('input[type="password"]', CONFIG.parcelx.formPass);
  await page.evaluate(() => {
    const btn = document.querySelector('button[type="submit"], input[type="submit"]');
    if (btn) btn.click();
  });
  await sleep(3000);
  await page.waitForLoadState('networkidle', { timeout: 20000 });
  log('Login successful ✅');
}

// ─── STEP 2: DOWNLOAD MIS ─────────────────────────────────────────────────────
async function downloadMIS(page, context) {
  log('Navigating to MIS Report page...');
  await page.goto('https://panel.parcelx.in/mis_report', {
    waitUntil: 'networkidle', timeout: 30000
  });
  await sleep(2000);

  log('Expanding Non Mandatory Fields...');
  await page.evaluate(() => document.querySelector('h4.dropdown_mis_el')?.click());
  await sleep(1500);

  log('Checking Select All...');
  const selectAll = await page.$('#selectAll');
  if (selectAll && !(await selectAll.isChecked())) await selectAll.click();
  await sleep(500);

  log('Checking NDR checkbox...');
  const ndrBox = await page.$('#box8');
  if (ndrBox && !(await ndrBox.isChecked())) await ndrBox.click();
  await sleep(500);

  const today = getToday();
  log(`Setting date: ${today}`);
  await page.evaluate((date) => {
    const from = document.querySelector('#from_date');
    const to   = document.querySelector('#to_date');
    if (from) { from.value = date; from.dispatchEvent(new Event('change')); }
    if (to)   { to.value   = date; to.dispatchEvent(new Event('change')); }
  }, today);
  await sleep(500);

  log('Clicking Search...');
  await page.evaluate(() => document.querySelector('#searchbtn')?.click());

  log('Waiting for results to load...');
  await page.waitForFunction(() => {
    const loader = document.querySelector('#loader');
    return !loader || loader.style.display === 'none';
  }, { timeout: 90000 });
  await sleep(3000);

  log('Clicking Export...');
  const [download] = await Promise.all([
    context.waitForEvent('download', { timeout: 90000 }),
    page.evaluate(() => document.querySelector('#btn_exportexcel')?.click())
  ]);

  const savePath = path.join(DOWNLOAD_DIR, download.suggestedFilename() || `mis_${Date.now()}.csv`);
  await download.saveAs(savePath);
  log(`MIS downloaded ✅ → ${savePath}`);
  return savePath;
}

// ─── STEP 3: POST TO APPS SCRIPT (handles redirects manually) ─────────────────
function postToAppsScript(url, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);

    const makeRequest = (requestUrl) => {
      const u = new URL(requestUrl);
      const options = {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = https.request(options, (res) => {
        // Follow redirects while preserving POST + body
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          log(`Redirecting → ${res.headers.location.substring(0, 70)}...`);
          res.resume(); // discard response body
          makeRequest(res.headers.location);
          return;
        }

        let responseData = '';
        res.on('data', chunk => responseData += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(responseData)); }
          catch { resolve({ raw: responseData }); }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    };

    makeRequest(url);
  });
}

// ─── STEP 3: UPLOAD TO GOOGLE SHEETS ──────────────────────────────────────────
async function uploadToGoogleSheets(csvFilePath) {
  log('Parsing CSV...');
  const rawCsv = fs.readFileSync(csvFilePath, 'utf8');
  const records = parse(rawCsv, {
    columns: false,
    skip_empty_lines: true,
    bom: true,
  });

  log(`Uploading ${records.length} rows → Google Sheets via Apps Script...`);
  const result = await postToAppsScript(CONFIG.appsScript.url, { rows: records });

  if (result.status === 'success') {
    log(`✅ Uploaded ${result.rows} rows to "Daily Dump" successfully!`);
  } else {
    throw new Error(`Apps Script error: ${result.message || JSON.stringify(result)}`);
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  log('=== ParcelX MIS Automation Started ===');

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
    const misFile = await downloadMIS(page, context);
    await uploadToGoogleSheets(misFile);
    log('=== All Done! ✅ ===');
  } catch (err) {
    log(`Fatal error: ${err.message}`);
    console.error(err);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
