const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

async function main() {
  const browser = await chromium.launch({ headless: true, channel: process.env.PHOTO_DESK_BROWSER || 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:4317');
  await page.waitForFunction(() => document.getElementById('output').value.length > 0);
  await page.locator('#examples').click(); assert.ok((await page.locator('#names').inputValue()).includes('دومتي'));
  await page.locator('#file').setInputFiles(path.join(__dirname, '..', 'امثلة.txt'));
  await page.waitForFunction(() => document.getElementById('file-label').textContent.includes('.txt'));
  assert.equal((await page.locator('#names').inputValue()).split('\n').length, 3);
  await fs.mkdir(path.join(__dirname, '..', 'test-output'), { recursive: true });
  await page.screenshot({ path: path.join(__dirname, '..', 'test-output', 'ui-desktop.png'), fullPage: true });
  const live = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'test-output', 'live-results.json'), 'utf8'));
  await page.locator('#history').selectOption(live.id);
  await page.locator('.product-card').first().waitFor();
  assert.equal(await page.locator('.product-card').count(), 7);
  assert.equal(await page.locator('#count-downloaded').textContent(), '6');
  await page.locator('#filter-text').fill('Samsung');
  assert.equal(await page.locator('.product-card').count(), 1);
  await page.locator('button[data-action="review"]').click();
  assert.equal(await page.locator('#candidates .candidate').count(), 8);
  await page.locator('#close-dialog').click();
  await page.locator('#filter-text').fill('');
  await page.screenshot({ path: path.join(__dirname, '..', 'test-output', 'ui-results.png'), fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.locator('#history').selectOption('');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false, 'Mobile layout must not scroll horizontally');
  await page.screenshot({ path: path.join(__dirname, '..', 'test-output', 'ui-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  await browser.close();
  console.log('UI PASS: TXT import, examples, saved jobs, counters, filtering, alternatives, 1440px and 375px, no JS errors.');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
