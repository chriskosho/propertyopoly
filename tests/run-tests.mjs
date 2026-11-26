// Serves the site locally, opens it in headless Chrome and:
//  1. runs the in-page rule tests (runTests),
//  2. plays several real turns through the interface, with animations on,
//  3. checks TV mode and keyboard shortcuts,
//  4. plays a person against computer players, with house rules on,
//  5. checks the installable app: manifest, service worker and offline reload.
// Fails on any failed test, uncaught error or console error.
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(root, p);
  if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const executablePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
const problems = [];
const watch = page => {
  page.on('console', m => { if (m.type() === 'error') problems.push('console error: ' + m.text()); });
  page.on('pageerror', e => problems.push('page error: ' + e.message));
};
const fresh = async (opts = {}) => { const ctx = await browser.newContext(opts); const page = await ctx.newPage(); watch(page); return { ctx, page }; };

// 1. Rule tests
{
  const { ctx, page } = await fresh();
  await page.goto(url);
  const result = await page.evaluate(() => runTests());
  for (const r of result.results) if (!r.pass) problems.push(`FAILED ${r.test}: ${r.error}`);
  console.log(`Rule tests: ${result.passed} passed, ${result.failed} failed`);
  await ctx.close();
}

// 2. Interface smoke test: 4 people, a few turns with animations
{
  const { ctx, page } = await fresh({ viewport: { width: 1280, height: 820 } });
  await page.goto(url);
  await page.click('input[name=count][value="4"]', { force: true });
  await page.uncheck('#spinfirst');
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
  await ctx.close();
}

// 4. One person against three computer players, with the spinner and house rules
{
  const { ctx, page } = await fresh({ viewport: { width: 1280, height: 820 } });
  await page.goto(url);
  await page.click('input[name=count][value="4"]', { force: true });
  for (const i of [1, 2, 3]) await page.click(`input[name=kind${i}][value=bot]`, { force: true });
  await page.check('#r-parking'); await page.check('#r-doublego'); await page.selectOption('#r-end', 'rounds:20');
  await page.click('button[type=submit]');
  await page.click('#modal[open] [data-ui=spinOk]:not([disabled])', { timeout: 15000 });
  let humanTurns = 0, guard = 0;
  const startTurn = await page.evaluate(() => __mono.state.turnNo);
  while (humanTurns < 3 && guard++ < 400) {
    await page.waitForTimeout(400);
    const st = await page.evaluate(() => { const s = __mono.state; return { phase: s.phase, anim: __mono.ui.animating, actor: __mono.actorOf(s), cur: s.cur, bot: s.players[s.cur].bot, pend: s.pending && s.pending.type, debts: s.debts.length }; });
    if (st.phase === 'over' || st.anim) { if (st.phase === 'over') break; continue; }
    if (await page.locator('#modal[open]').count()) {
      if (st.pend === 'buy') await page.click('#modal[open] [data-fid=buy]:not([disabled]), #modal[open] [data-fid=decl]');
      else if (st.pend === 'auction') { const pass = page.locator('#modal[open] [data-fid^=pass]:not([disabled])'); if (await pass.count()) await pass.first().click(); }
      else if (st.pend === 'trade') { const show = page.locator('#modal[open] [data-ui=tradeShow]'); if (await show.count()) await show.click(); else await page.click('#modal[open] [data-a*=TRADE_DECLINE]'); }
      else if (st.pend || st.debts) await page.evaluate(() => __mono.dispatch(__mono.botAction(__mono.state)));
      continue;
    }
    if (!st.bot && st.actor === st.cur) {
      const btn = page.locator('#center .acts .btn.primary').first();
      if (await btn.count()) { if ((await btn.innerText()) === 'End turn') humanTurns++; await btn.click(); }
    }
  }
  const played = (await page.evaluate(() => __mono.state.turnNo)) - startTurn;
  if (humanTurns < 3) problems.push(`bot test: only ${humanTurns} of 3 turns finished alongside the computer players`);
  console.log(`Computer player test: ${played} turns played, ${humanTurns} by the person`);
  await ctx.close();
}

// 5. Installable app: manifest, service worker, offline reload
{
  const { ctx, page } = await fresh();
  await page.goto(url);
  const manifest = await page.evaluate(async () => { const href = document.querySelector('link[rel=manifest]').href; return (await fetch(href)).json(); });
  if (manifest.display !== 'standalone' || !manifest.icons?.some(i => i.sizes === '512x512')) problems.push('manifest is missing standalone display or a 512px icon');
  for (const icon of manifest.icons) { const ok = await page.evaluate(async src => (await fetch(src)).ok, icon.src); if (!ok) problems.push('missing icon ' + icon.src); }
  const sw = await page.evaluate(async () => { const reg = await navigator.serviceWorker.ready; return !!reg.active; });
  if (!sw) problems.push('service worker did not activate');
  await page.waitForTimeout(500);
  await ctx.setOffline(true);
  await page.reload();
  const offline = await page.locator('#setup-title').isVisible();
  if (!offline) problems.push('the game did not load offline');
  console.log(`App test: manifest ok, service worker ${sw ? 'active' : 'missing'}, offline load ${offline ? 'ok' : 'failed'}`);
  await ctx.close();
}

await browser.close();
server.close();
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log('All checks passed.');
