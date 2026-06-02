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

// Today in dd-mm-yyyy format (ParcelX format)
function getToday() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2,'0')}-${String(d.getMonth()+1).padStart(2,'0')}-${d.getFullYear()}`;
}

// N days back in dd-mm-yyyy format
function getFromDate(daysBack) {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  return `${String(d.getDate()).padStart(2,'0')}-${String(d.getMonth()+1).padStart(2,'0')}-${d.getFullYear()}`;
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

// ─── STEP 2: DOWNLOAD MIS (5 days back to today) ──────────────────────────────
async function downloadMIS(page, context) {
  log('Navigating to MIS Report page...');
  await page.goto('https://panel.parcelx.in/mis_report', {
    waitUntil: 'networkidle', timeout: 30000
  });
  await sleep(2000);

  log('Expanding Non Mandatory Fields...');
  await page.evaluate(() => document.querySelector('h4.dropdown_mis_el')?.click());
  await sleep(2000);

  log('Checking Select All...');
  const selectAll = await page.$('#selectAll');
  if (selectAll && !(await selectAll.isChecked())) await selectAll.click();
  await sleep(500);

  log('Checking NDR checkbox...');
  const ndrBox = await page.$('#box8');
  if (ndrBox && !(await ndrBox.isChecked())) await ndrBox.click();
  await sleep(500);

  // ← KEY CHANGE: From = 5 days back, To = today
  const fromDate = getFromDate(5);
  const today    = getToday();
  log(`Setting date range: ${fromDate} → ${today}`);

  await page.evaluate((from, to) => {
    const fromEl = document.querySelector('#from_date');
    const toEl   = document.querySelector('#to_date');
    if (fromEl) { fromEl.value = from; fromEl.dispatchEvent(new Event('change')); }
    if (toEl)   { toEl.value   = to;   toEl.dispatchEvent(new Event('change')); }
  }, fromDate, today);
  await sleep(500);

  log('Clicking Search...');
  await page.click('#searchbtn');

  log('Waiting for search to start...');
  try {
    await page.waitForFunction(() => {
      const loader = document.querySelector('#searchbtn_loader');
      return loader && loader.style.display !== 'none';
    }, { timeout: 8000 });
    log('Search in progress...');
  } catch (e) {
    log('Loader not detected, continuing...');
  }

  log('Waiting for search to complete...');
  await page.waitForFunction(() => {
    const loader = document.querySelector('#searchbtn_loader');
    return !loader || loader.style.display === 'none';
  }, { timeout: 120000 });
  await sleep(5000);
  log('Results loaded ✅');

  log('Clicking Export...');
  const [download] = await Promise.all([
    context.waitForEvent('download', { timeout: 120000 }),
    page.click('#btn_exportexcel'),
  ]);

  log('Waiting for file to generate...');
  try {
    await page.waitForFunction(() => {
      const expLoader = document.querySelector('#btn_exportexcel_loader');
      return !expLoader || expLoader.style.display === 'none';
    }, { timeout: 60000 });
  } catch(e) { /* ignore */ }

  const savePath = path.join(DOWNLOAD_DIR, download.suggestedFilename() || `mis_${Date.now()}.csv`);
  await download.saveAs(savePath);
  log(`MIS downloaded ✅ → ${savePath}`);
  return savePath;
}

// ─── STEP 3: POST TO APPS SCRIPT (with redirect handling) ─────────────────────
function postChunkToAppsScript(url, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);

    const makeRequest = (requestUrl, isRedirect = false) => {
      const u = new URL(requestUrl);
      const method = isRedirect ? 'GET' : 'POST';
      const options = {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method,
        headers: isRedirect ? {} : {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = https.request(options, (res) => {
        if ([301, 302, 303].includes(res.statusCode) && res.headers.location) {
          log(`  ↪ Redirect → fetching response...`);
          res.resume();
          makeRequest(res.headers.location, true);
          return;
        }
        let responseData = '';
        res.on('data', chunk => responseData += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(responseData)); }
          catch { resolve({ raw: responseData.substring(0, 200) }); }
        });
      });

      req.on('error', reject);
      if (!isRedirect) req.write(body);
      req.end();
    };

    makeRequest(url);
  });
}

// ─── STEP 3: UPLOAD IN CHUNKS ─────────────────────────────────────────────────
async function uploadToGoogleSheets(csvFilePath) {
  log('Parsing CSV...');
  const rawCsv = fs.readFileSync(csvFilePath, 'utf8');
  const records = parse(rawCsv, {
    columns: false,
    skip_empty_lines: true,
    bom: true,
  });

  const CHUNK_SIZE  = 1000;
  const totalChunks = Math.ceil(records.length / CHUNK_SIZE);
  log(`Uploading ${records.length} rows in ${totalChunks} chunks of ${CHUNK_SIZE}...`);

  for (let i = 0; i < records.length; i += CHUNK_SIZE) {
    const chunkIndex = Math.floor(i / CHUNK_SIZE);
    const chunk      = records.slice(i, i + CHUNK_SIZE);

    log(`Sending chunk ${chunkIndex + 1}/${totalChunks} (${chunk.length} rows)...`);
    const result = await postChunkToAppsScript(CONFIG.appsScript.url, {
      rows: chunk,
      chunk: chunkIndex,
      totalChunks,
    });

    if (result.status !== 'success') {
      throw new Error(`Chunk ${chunkIndex + 1} failed: ${result.message || JSON.stringify(result)}`);
    }
    log(`  Chunk ${chunkIndex + 1} uploaded ✅`);

    if (i + CHUNK_SIZE < records.length) await sleep(1500);
  }

  log(`✅ All ${records.length} rows uploaded to "Daily Dump"!`);
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
