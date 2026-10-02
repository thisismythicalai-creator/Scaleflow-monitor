import { chromium } from 'playwright';
import fs from 'fs';

const URL = process.env.TARGET_URL || 'https://scale-flow12.vercel.app';
const MAX_ATTEMPTS = 2;

async function probe() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  const failedRequests = [];
  const pageErrors = [];

  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => pageErrors.push(String(e)));
  page.on('requestfailed', r => failedRequests.push(`${r.url()} ${r.failure()?.errorText}`));
  page.on('response', r => { if (r.status() >= 400) failedRequests.push(`${r.url()} HTTP ${r.status()}`); });

  const t0 = Date.now();
  const resp = await page.goto(URL, { waitUntil: 'networkidle', timeout: 45000 });
  const loadMs = Date.now() - t0;

  const title = await page.title();
  const rootChildren = await page.evaluate(() => document.querySelector('#root')?.children.length ?? -1);
  const bodyChars = await page.evaluate(() => document.body.innerText.length);
  const h1 = await page.locator('h1').first().textContent().catch(() => null);
  await page.screenshot({ path: 'screenshot.png', fullPage: true });
  await browser.close();

  const problems = [];
  if (!resp || resp.status() !== 200) problems.push(`HTTP status ${resp?.status()}`);
  if (rootChildren < 1) problems.push('#root missing or empty (app did not render)');
  if (bodyChars < 200) problems.push(`very little page text (${bodyChars} chars)`);
  if (!h1) problems.push('no H1 found');
  if (consoleErrors.length) problems.push(`${consoleErrors.length} console error(s)`);
  if (pageErrors.length) problems.push(`${pageErrors.length} runtime exception(s)`);
  if (failedRequests.length) problems.push(`${failedRequests.length} failed request(s)`);

  return {
    type: 'REAL', target: URL, time: new Date().toISOString(),
    status: problems.length ? 'FAILED' : 'HEALTHY',
    problems, loadMs, title, h1, bodyChars, rootChildren,
    consoleErrors, pageErrors, failedRequests,
  };
}

let report;
for (let i = 1; i <= MAX_ATTEMPTS; i++) {
  try { report = await probe(); } catch (e) {
    report = { type: 'REAL', target: URL, time: new Date().toISOString(), status: 'FAILED', problems: [`probe crashed: ${e.message}`] };
  }
  report.attempt = i;
  if (report.status === 'HEALTHY') break;
}

fs.writeFileSync('report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(report.status === 'HEALTHY' ? 0 : 1);
