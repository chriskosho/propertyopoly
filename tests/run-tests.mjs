// Opens index.html in headless Chrome and:
//  1. runs the in-page rule tests (runTests),
//  2. plays several real turns through the interface, with animations on,
//  3. checks TV mode and keyboard shortcuts.
// Fails on any failed test, uncaught error or console error.
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const file = 'file://' + path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html');
const executablePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
const problems = [];
const watch = page => {
  page.on('console', m => { if (m.type() === 'error') problems.push('console error: ' + m.text()); });
  page.on('pageerror', e => problems.push('page error: ' + e.message));
};

// 1. Rule tests
{
  const page = await browser.newPage(); watch(page);
  await page.goto(file);
  const result = await page.evaluate(() => runTests());
  for (const r of result.results) if (!r.pass) problems.push(`FAILED ${r.test}: ${r.error}`);
  console.log(`Rule tests: ${result.passed} passed, ${result.failed} failed`);
  await page.close();
}

// 2. Interface smoke test: 4 players, a few turns with animations
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } }); watch(page);
  await page.goto(file);
  await page.click('input[name=count][value="4"]', { force: true });
  await page.click('button[type=submit]');
  let turnsEnded = 0, guard = 0;
  while (turnsEnded < 6 && guard++ < 200) {
    const st = await page.evaluate(() => { const s = __mono.state; return { pend: s.pending && s.pending.type, debts: s.debts.length }; });
    if (await page.locator('#modal[open] [data-ui=handoffOk]').count()) { await page.click('#modal[open] [data-ui=handoffOk]'); continue; }
    if (st.pend === 'buy') { await page.click('#modal[open] [data-fid=buy]:not([disabled]), #modal[open] [data-fid=decl]'); await page.waitForTimeout(2200); continue; }
    if (st.pend || st.debts) { await page.evaluate(() => __mono.autoplay(1)); continue; }
    const btn = page.locator('#center .acts .btn.primary').first();
    const label = await btn.innerText();
    if (label === 'End turn') { await page.keyboard.press('Enter'); turnsEnded++; }
    else { await page.keyboard.press('Space'); }
    await page.waitForTimeout(2600);
  }
  if (turnsEnded < 6) problems.push('interface test: could not finish 6 turns through the UI');
  console.log(`Interface test: ${turnsEnded} turns played through the UI`);

  // 3. TV mode toggle (shortcuts are off while a dialog is open, so close it first)
  if (await page.locator('#modal[open] [data-ui=handoffOk]').count()) await page.click('#modal[open] [data-ui=handoffOk]');
  await page.keyboard.press('v');
  if (!(await page.evaluate(() => document.body.classList.contains('tv')))) problems.push('TV mode did not turn on');
  await page.keyboard.press('v');
  if (await page.evaluate(() => document.body.classList.contains('tv'))) problems.push('TV mode did not turn off');
  await page.close();
}

await browser.close();
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log('All checks passed.');
