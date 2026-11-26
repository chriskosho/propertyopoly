// Serves the site locally, opens it in headless Chrome and:
//  1. runs the in-page rule tests (runTests),
//  2. plays several real turns through the interface, with animations on,
//  3. checks TV mode and keyboard shortcuts,
//  4. plays a person against computer players, with house rules on,
//  5. checks the installable app: manifest, service worker and offline reload,
//  6. checks updates: version list, automatic reload that keeps the game, and the What's new window.
// Fails on any failed test, uncaught error or console error.
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
const appVersion = () => fs.readFileSync(path.join(root, 'index.html'), 'utf8').match(/APP_VERSION = '([^']+)'/)[1];
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  // The deploy step writes version.json; serve the same thing here.
  if (p === '/version.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ version: appVersion() })); return; }
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

// 6. Updates: the release list is consistent, a new version reloads the page and resumes the game once,
//    and the What's new window lists everything since the last version seen.
{
  const { ctx, page } = await fresh();
  await page.goto(url);
  const info = await page.evaluate(() => ({ v: APP_VERSION, top: RELEASES[0].version, all: RELEASES.map(r => r.version) }));
  if (info.v !== info.top) problems.push(`APP_VERSION ${info.v} does not match the newest release entry ${info.top}`);
  if (new Set(info.all).size !== info.all.length) problems.push('RELEASES has a repeated version number');
  await ctx.close();
}
{
  const { ctx, page } = await fresh({ serviceWorkers: 'block', viewport: { width: 1280, height: 820 } });
  let loads = 0; page.on('load', () => loads++);
  await page.route('**/version.json*', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ version: '99.0.0' }) }));
  await page.goto(url);
  await page.click('input[name=count][value="2"]', { force: true });
  await page.uncheck('#spinfirst');
  await page.click('button[type=submit]');
  await page.keyboard.press('Space');
  await page.waitForTimeout(2500);
  const before = await page.evaluate(() => __mono.state.log.length);
  await page.waitForEvent('load', { timeout: 20000 });
  await page.waitForSelector('#game:not([hidden])', { timeout: 5000 });
  const after = await page.evaluate(() => ({ log: __mono.state.log.length, modal: document.querySelector('#modal').open && document.querySelector('#modal-body').innerText.slice(0, 40) }));
  if (after.log < before) problems.push('update: the game in progress was not restored after reloading');
  if (after.modal && /Show the board/.test(after.modal)) problems.push('update: the pass-the-device screen came back after the reload');
  await page.waitForTimeout(6500);
  if (loads !== 2) problems.push(`update: expected one reload, saw ${loads - 1}`);
  console.log(`Update test: reloaded once and resumed the game (${loads - 1} reload)`);
  await ctx.close();
}
{
  const { ctx, page } = await fresh();
  await page.addInitScript(() => { if (!localStorage.getItem('mono.seenVersion')) { localStorage.setItem('mono.seenVersion', '1.0.0'); localStorage.setItem('mono.setup', '{}'); } });
  await page.goto(url);
  await page.waitForSelector('#whatsnew[open]', { timeout: 5000 });
  const { shown, expected } = await page.evaluate(() => ({ shown: document.querySelectorAll('#wn-body .rel').length, expected: RELEASES.length - 1 }));
  if (shown !== expected) problems.push(`What's new listed ${shown} releases, expected ${expected}`);
  await page.click('#whatsnew [data-ui=wnClose]');
  await page.waitForFunction(() => localStorage.getItem('mono.seenVersion') === APP_VERSION, null, { timeout: 5000 }).catch(() => {});
  const seen = await page.evaluate(() => [localStorage.getItem('mono.seenVersion'), APP_VERSION]);
  if (seen[0] !== seen[1]) problems.push("What's new did not record the version as seen");
  await page.reload();
  await page.waitForTimeout(500);
  if (await page.locator('#whatsnew[open]').count()) problems.push("What's new showed again for a version already seen");
  console.log(`What's new test: ${shown} releases listed, shown once`);
  await ctx.close();
}

// 7. Animations are on by default and the Game menu can turn them off. The theme is light by default and the board stays white in dark.
{
  const { ctx, page } = await fresh({ reducedMotion: 'reduce', viewport: { width: 1280, height: 820 } });
  await page.goto(url);
  await page.click('input[name=count][value="2"]', { force: true });
  await page.uncheck('#spinfirst');
  await page.click('button[type=submit]');
  const roll = async () => {
    await page.evaluate(() => { __mono.ui.state.debugDice = [[3, 4]]; });
    await page.keyboard.press('Space');
    await page.waitForTimeout(200);
    return page.evaluate(() => document.querySelectorAll('#dice .die.tossing').length);
  };
  const on = await roll();
  if (on !== 2) problems.push(`animations: expected 2 tossed dice by default (even when the device asks for reduced motion), saw ${on}`);
  await page.waitForFunction(() => !__mono.ui.animating, null, { timeout: 8000 }).catch(() => {});
  await page.evaluate(() => { const first = __mono.state.cur; for (let k = 0; k < 40; k++) { const s = __mono.state; if (s.cur !== first && s.phase === 'start' && !s.pending && !s.debts.length) break; __mono.autoplay(1); } });
  await page.waitForTimeout(1500);
  await page.keyboard.press('?');
  await page.waitForSelector('#modal[open] [data-ui=motion]', { timeout: 5000 });
  if (await page.locator('#modal[open] [data-ui=motion][data-v=auto]').count()) problems.push('animations: a Match device option is still offered');
  // Theme: light by default, dark on request, board white either way.
  const boardBg = () => page.evaluate(() => getComputedStyle(document.querySelector('#board .center')).backgroundColor);
  const pageBg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const lightTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  if (lightTheme !== 'light') problems.push('theme: default is not light');
  await page.click('#modal[open] [data-ui=theme][data-v=dark]');
  const dark = await page.evaluate(() => document.documentElement.dataset.theme);
  if (dark !== 'dark') problems.push('theme: dark did not apply');
  if ((await boardBg()) !== 'rgb(255, 255, 255)') problems.push('theme: the board is not white in dark mode: ' + await boardBg());
  if ((await pageBg()) === 'rgb(230, 237, 241)') problems.push('theme: the page did not turn dark');
  if (await page.evaluate(() => localStorage.getItem('mono.theme')) !== 'dark') problems.push('theme: the choice was not remembered');
  await page.reload(); await page.waitForTimeout(500);
  if (await page.evaluate(() => document.documentElement.dataset.theme) !== 'dark') problems.push('theme: dark was not restored after reload');
  await page.evaluate(() => { localStorage.setItem('mono.theme', 'light'); });
  // Turn animations off and confirm no dice toss, in a fresh game after the reload.
  await page.click('input[name=count][value="2"]', { force: true });
  await page.uncheck('#spinfirst');
  await page.click('button[type=submit]');
  await page.keyboard.press('?');
  await page.waitForSelector('#modal[open] [data-ui=motion]', { timeout: 5000 });
  await page.click('#modal[open] [data-ui=motion][data-v=off]');
  await page.click('#modal[open] [data-ui=close]');
  const off = await roll();
  if (off !== 0) problems.push(`animations: dice were tossed after turning animations off (${off})`);
  if (await page.evaluate(() => localStorage.getItem('mono.motion')) !== 'off') problems.push('animations: the setting was not remembered');
  console.log(`Animation and theme test: on by default (${on} tossed), off works (${off} tossed), board white in dark mode`);
  await ctx.close();
}

// 8. A card that moves the token: the card closes, the token is seen moving, then the landing card appears.
{
  const { ctx, page } = await fresh({ viewport: { width: 1280, height: 820 } });
  await page.goto(url);
  await page.click('input[name=count][value="2"]', { force: true });
  await page.uncheck('#spinfirst');
  await page.click('button[type=submit]');
  await page.evaluate(() => {
    const s = __mono.state; const deck = deckOf('chance');
    s.players[0].pos = 7; __mono.ui.displayPos = s.players.map(p => p.pos);
    s.pending = { type: 'card', player: 0, deck: 'chance', card: deck.findIndex(c => c.fx.nearest === 'rail') };
    s.phase = 'moved'; render();
  });
  await page.waitForSelector('#modal[open] .flip, #modal[open] [data-act]', { timeout: 3000 }).catch(() => {});
  const seen = { modalDuringMove: false, positions: new Set() };
  await page.evaluate(() => {
    window.__watch = { open: [], pos: [] };
    const iv = setInterval(() => { if (!__mono.ui.animating) return; window.__watch.open.push(document.querySelector('#modal').open); window.__watch.pos.push(__mono.ui.displayPos[0]); }, 40);
    window.__stopWatch = () => clearInterval(iv);
  });
  await page.click('#modal[open] button.primary');
  await page.waitForSelector('#modal[open] h2', { timeout: 6000 });
  const w = await page.evaluate(() => { __stopWatch(); return window.__watch; });
  const title = await page.evaluate(() => document.querySelector('#modal h2')?.textContent || '');
  if (w.open.some(Boolean)) problems.push('card move: a dialog was open while the token moved');
  const hops = new Set(w.pos).size;
  if (hops < 3) problems.push(`card move: the token was seen on only ${hops} spaces while moving`);
  if (!/Reading Railroad|Pennsylvania|B\. ?& ?O|Short Line|Railroad/.test(title)) problems.push('card move: landing card did not appear after the move: ' + title);
  console.log(`Card move test: dialog closed while moving, token seen on ${hops} spaces, then "${title}"`);
  await ctx.close();
}

// 9. Turn passes without a pass-the-device screen; mortgage reminder; for-sale panel; trade screen; monopoly celebration.
{
  const { ctx, page } = await fresh({ viewport: { width: 1280, height: 860 } });
  await page.goto(url);
  await page.click('input[name=count][value="2"]', { force: true });
  await page.uncheck('#spinfirst');
  await page.click('button[type=submit]');
  await page.waitForTimeout(500);
  if (await page.locator('#modal[open]').count()) problems.push('turn: a dialog covers the board at the start of the game');
  const toast1 = await page.locator('#toast div').allInnerTexts();
  if (!toast1.some(x => /’s turn/.test(x))) problems.push('turn: no turn note at the start: ' + toast1.join('|'));
  // For sale panel
  const fs = await page.locator('#forsale .fs-count').innerText();
  if (!/28 of 28/.test(fs)) problems.push('for sale: expected 28 of 28 at the start, saw ' + fs);
  const fsRow = await page.evaluate(() => { const r = document.querySelector('#fs-row'); const cs = getComputedStyle(r); return { ox: cs.overflowX, wrap: cs.flexWrap, over: r.scrollWidth > r.clientWidth, h: r.clientHeight, hint: !document.querySelector('#fs-swipe').hidden }; });
  if (fsRow.ox !== 'auto' || fsRow.wrap !== 'nowrap' || !fsRow.over || !fsRow.hint || fsRow.h > 60) problems.push('for sale: the row is not a sideways scroller: ' + JSON.stringify(fsRow));
  await page.evaluate(() => { document.querySelector('#fs-row').scrollLeft = 120; });
  if ((await page.evaluate(() => document.querySelector('#fs-row').scrollLeft)) < 50) problems.push('for sale: the row did not scroll sideways');
  // Mortgage reminder at the start of a turn
  await page.evaluate(() => { const s = __mono.state; s.cur = 0; s.props[1].owner = 0; s.props[1].mortgaged = true; s.props[3].owner = 0; render(); });
  const note = await page.locator('.mortnote').innerText().catch(() => '');
  if (!/1 mortgaged property/.test(note)) problems.push('mortgage: no reminder in the center panel: ' + note);
  if (!/1 mortgaged/.test(await page.locator('#players').innerText())) problems.push('mortgage: no badge in the player list');
  const fs2 = await page.locator('#forsale .fs-count').innerText();
  if (!/26 of 28/.test(fs2)) problems.push('for sale: expected 26 of 28 after two are owned, saw ' + fs2);
  // Trade screen: the other player owns the set-completing property
  await page.evaluate(() => { const s = __mono.state; s.props[1].mortgaged = false; s.props[3].owner = 1; s.props[6].owner = 0; s.props[8].owner = 1; s.props[9].owner = 0; render(); });
  await page.click('[data-ui=trade]');
  await page.waitForSelector('#modal[open] .tneeds');
  const needs = await page.locator('#modal .tneeds').innerText();
  if (!/Baltic Avenue/.test(needs)) problems.push('trade: set-completing property not suggested: ' + needs);
  await page.click('#modal .tneeds [data-ui=tradeAdd]');
  await page.waitForSelector('#modal input[data-trade=get][data-prop="3"]:checked');
  const impact = await page.locator('#trade-impact').innerText();
  if (!/completes the set/i.test(impact)) problems.push('trade: summary does not say the set is completed: ' + impact);
  await page.click('#modal [data-ui=tradeCard][data-i="3"]');
  const cardShown = await page.locator('#modal .tcard[data-i="3"]').isVisible();
  const cardText = await page.locator('#modal .tcard[data-i="3"]').innerText();
  if (!cardShown || !/hotel/i.test(cardText)) problems.push('trade: card with house and hotel rents is not shown');
  await page.fill('#modal input[data-trade=give][data-cash]', '120');
  const impact2 = await page.locator('#trade-impact').innerText();
  if (!/gives \$120/.test(impact2)) problems.push('trade: summary did not update after typing cash: ' + impact2);
  await page.click('#modal [data-ui=tradeSend]');
  await page.waitForSelector('#modal[open] [data-ui=tradeShow]');
  await page.click('#modal [data-ui=tradeShow]');
  const review = await page.locator('#modal').innerText();
  if (!/What this trade changes/.test(review) || !/Show the card/.test(review)) problems.push('trade: review screen lacks the impact summary or card');
  // Accept: monopoly celebration plays and the set is complete
  await page.evaluate(() => { window.__sawBanner = false; const iv = setInterval(() => { if (document.querySelector('#board .mono-banner')) window.__sawBanner = true; }, 50); window.__bi = iv; });
  await page.click('#modal [data-a*=TRADE_ACCEPT]');
  await page.waitForFunction(() => window.__sawBanner, null, { timeout: 4000 }).catch(() => {});
  const saw = await page.evaluate(() => window.__sawBanner);
  if (!saw) problems.push('monopoly: no celebration banner appeared');
  await page.waitForFunction(() => !__mono.ui.animating, null, { timeout: 8000 }).catch(() => {});
  const confettiLeft = await page.locator('#board .confetti, #board .mono-banner').count();
  if (confettiLeft) problems.push('monopoly: celebration left elements on the board');
  console.log('Turn, reminder, for-sale, trade and monopoly test done');
  await ctx.close();
}

await browser.close();
server.close();
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log('All checks passed.');
