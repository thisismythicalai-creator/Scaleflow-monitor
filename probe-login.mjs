import { chromium } from 'playwright';
import fs from 'fs';

const BASE = process.env.TARGET_URL || 'https://scale-flow12.vercel.app';
const EMAIL = process.env.PROBE_EMAIL;
const PASSWORD = process.env.PROBE_PASSWORD;
const LOGIN_PATHS = process.env.LOGIN_PATH ? [process.env.LOGIN_PATH] : ['/login', '/signin', '/auth', '/'];
const PAGES = (process.env.PAGES || 'Dashboard,Leads,Conversations,Settings').split(',').map(s => s.trim());

const report = { type: 'REAL', target: BASE, time: new Date().toISOString(), steps: [], status: '' };
const step = (name, result, detail = '') => { report.steps.push({ name, result, detail }); console.log(result, name, detail); };
const finish = (status, code) => {
  report.status = status;
  fs.writeFileSync('login-report.json', JSON.stringify(report, null, 2));
  console.log('FINAL:', status);
  process.exit(code);
};

if (!EMAIL || !PASSWORD) { step('credentials', 'BLOCKED', 'PROBE_EMAIL / PROBE_PASSWORD not set'); finish('BLOCKED_AUTH_CREDENTIALS_NOT_CONFIGURED', 0); }

const browser = await chromium.launch();
const page = await browser.newPage();
let errs = [], fails = [];
page.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
page.on('response', r => { if (r.status() >= 400) fails.push(`${r.status()} ${r.url().split('?')[0]}`); });

const pwField = () => page.locator('input[type="password"]:visible').first();

try {
  // 1. find the login form
  let found = false;
  for (const p of LOGIN_PATHS) {
    await page.goto(BASE + p, { waitUntil: 'networkidle', timeout: 45000 });
    if (await pwField().count()) { found = true; step('find login form', 'PASS', p); break; }
    const opener = page.getByRole('link', { name: /log ?in|sign ?in/i }).or(page.getByRole('button', { name: /log ?in|sign ?in/i })).first();
    if (await opener.count()) {
      await opener.click(); await page.waitForTimeout(1500);
      if (await pwField().count()) { found = true; step('find login form', 'PASS', `${p} then login button`); break; }
    }
  }
  if (!found) { step('find login form', 'FAILED', 'no password field found'); await page.screenshot({ path: 'login-fail.png' }); finish('FAILED', 1); }

  // 2. log in
  await page.locator('input[type="email"], input[name="email"]').first().fill(EMAIL);
  await pwField().fill(PASSWORD);
  const submit = page.locator('button[type="submit"]').or(page.getByRole('button', { name: /log ?in|sign ?in/i })).first();
  await submit.click();
  const ok = await page.waitForFunction(() => !document.querySelector('input[type="password"]'), null, { timeout: 20000 }).then(() => true).catch(() => false);
  if (!ok) {
    const alert = await page.locator('[role="alert"]').first().textContent().catch(() => '');
    step('login', 'FAILED', `still on login form. Visible message: ${alert || 'none'}`);
    await page.screenshot({ path: 'login-fail.png' }); finish('FAILED', 1);
  }
  step('login', 'PASS', `landed on ${new URL(page.url()).pathname}`);

  // 3. session survives refresh (historical bug check)
  await page.reload({ waitUntil: 'networkidle' });
  const lost = await pwField().count();
  step('session after refresh', lost ? 'FAILED' : 'PASS', lost ? 'login form shown again after reload' : 'still signed in');

  // 4. visit each menu page
  for (const name of PAGES) {
    errs = []; fails = [];
    const nav = page.getByRole('link', { name: new RegExp(name, 'i') }).or(page.getByRole('button', { name: new RegExp(name, 'i') })).first();
    if (!(await nav.count())) { step(`page: ${name}`, 'NOT_VERIFIED', 'menu item not found'); continue; }
    await nav.click();
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1000);
    const chars = await page.evaluate(() => document.body.innerText.length);
    await page.screenshot({ path: `page-${name}.png`, fullPage: true });
    const bad = [];
    if (chars < 100) bad.push(`little content (${chars} chars)`);
    if (await pwField().count()) bad.push('kicked back to login');
    if (errs.length) bad.push(`console errors: ${errs.slice(0, 2).join(' | ')}`);
    if (fails.length) bad.push(`failed requests: ${fails.slice(0, 3).join(' | ')}`);
    step(`page: ${name}`, bad.length ? 'FAILED' : 'PASS', bad.join('; ') || `${new URL(page.url()).pathname}, ${chars} chars`);
  }
} catch (e) {
  step('probe crashed', 'FAILED', e.message);
}
await browser.close();

const failed = report.steps.some(s => s.result === 'FAILED');
const unverified = report.steps.some(s => s.result === 'NOT_VERIFIED');
finish(failed ? 'FAILED' : unverified ? 'INCOMPLETE_NOT_VERIFIED' : 'HEALTHY', failed ? 1 : 0);
