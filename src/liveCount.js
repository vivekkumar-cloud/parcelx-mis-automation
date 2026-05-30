const { chromium } = require('playwright');
const https = require('https');
require('dotenv').config();

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

const STATUSES = [
  'Manifested','Booked','Pickup Pending','Out For Pickup','Not Picked',
  'Delivered','RTS','In Transit','RTO-IT','Dispatched','RTO','NDR','Picked','LOST'
];

const COURIERS = [
  'Delhivery','Ekart-Px','Amazon','BlueDart Express','XPress Bees',
  'Shree Maruti','Shadowfax','XBS SO PX_1KG','PIKNDEL','TCI Express','INDIA POST'
];

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getLiveCount() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();

  try {
    // Login
    log('Logging in...');
    await page.goto(
      `https://${CONFIG.parcelx.basicUser}:${CONFIG.parcelx.basicPass}@panel.parcelx.in/`,
      { waitUntil: 'domcontentloaded', timeout: 30000 }
    );
    await sleep(2000);
    await page.fill('input[name="username"], input[type="text"]', CONFIG.parcelx.formUser);
    await page.fill('input[type="password"]', CONFIG.parcelx.formPass);
    await page.evaluate(() => document.querySelector('button[type="submit"]')?.click());
    await sleep(3000);
    await page.waitForLoadState('networkidle', { timeout: 20000 });
    log('Login ✅');

    // Go to MIS Report
    await page.goto('https://panel.parcelx.in/mis_report', {
      waitUntil: 'networkidle', timeout: 30000
    });
    await sleep(2000);

    // Select Statuses via jQuery chosen
    log(`Selecting ${STATUSES.length} statuses...`);
    await page.evaluate((statuses) => {
      const select = document.querySelector('select#user_status');
      if (!select) return;
      Array.from(select.options).forEach(o => {
        o.selected = statuses.some(s => s.toLowerCase() === o.text.trim().toLowerCase());
      });
      if (window.jQuery) jQuery(select).trigger('chosen:updated').trigger('change');
    }, STATUSES);
    await sleep(1000);

    // Select Couriers via jQuery chosen
    log(`Selecting ${COURIERS.length} couriers...`);
    await page.evaluate((couriers) => {
      const select = document.querySelector('select#fulfilled_by');
      if (!select) return;
      Array.from(select.options).forEach(o => {
        o.selected = couriers.some(c => c.toLowerCase() === o.text.trim().toLowerCase());
      });
      if (window.jQuery) jQuery(select).trigger('chosen:updated').trigger('change');
    }, COURIERS);
    await sleep(1000);

    // Click Search
    log('Searching...');
    await page.click('#searchbtn');
    await sleep(10000); // Wait for results

    // Grab total count from "Showing: X of Y orders"
    const count = await page.evaluate(() => {
      const text = document.body.innerText;
      const match = text.match(/Showing\s*:\s*[\d,]+\s+of\s+([\d,]+)\s+orders/i);
      return match ? parseInt(match[1].replace(/,/g, '')) : null;
    });

    log(`✅ Live Count: ${count}`);
    return count;

  } finally {
    await browser.close();
  }
}

function postCount(url, count) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      action: 'updateCount',
      count,
      timestamp: new Date().toISOString()
    });
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
        if ([301,302,303].includes(res.statusCode) && res.headers.location) {
          res.resume();
          makeRequest(res.headers.location, true);
          return;
        }
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({raw:data}); } });
      });
      req.on('error', reject);
      if (!isRedirect) req.write(body);
      req.end();
    };
    makeRequest(url);
  });
}

async function main() {
  const count = await getLiveCount();
  if (count !== null) {
    const result = await postCount(CONFIG.appsScript.url, count);
    log(`Posted: ${JSON.stringify(result)}`);
  } else {
    log('Could not get count!');
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
