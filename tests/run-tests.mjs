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

  // 3. Full screen toggle (shortcuts are off while a dialog is open, so close it first)
  await page.keyboard.press('v');
  if (!(await page.evaluate(() => document.body.classList.contains('tv')))) problems.push('Full screen layout did not turn on');
  await page.keyboard.press('v');
  if (await page.evaluate(() => document.body.classList.contains('tv'))) problems.push('Full screen layout did not turn off');
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
  // Turn animations off and confirm no dice toss. After a reload the home screen offers Resume game.
  await page.click('[data-ui=resume]');
  await page.waitForSelector('#game:not([hidden])', { timeout: 3000 });
  await page.evaluate(() => { const first = __mono.state.cur; for (let k = 0; k < 40; k++) { const s = __mono.state; if (s.cur !== first && s.phase === 'start' && !s.pending && !s.debts.length) break; __mono.autoplay(1); } });
  await page.waitForTimeout(1500);
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

// 10. Cleaner screen: toolbar, log, sound, colors, spinner length.
{
  const { ctx, page } = await fresh({ viewport: { width: 1280, height: 860 } });
  await page.goto(url);
  const heroBg = await page.evaluate(() => getComputedStyle(document.querySelector('.hero svg .ln')).fill);
  if (heroBg !== 'rgb(255, 255, 255)') problems.push('home: cards are not white: ' + heroBg);
  await page.click('input[name=count][value="3"]', { force: true });
  await page.check('#spinfirst');
  await page.click('button[type=submit]');
  const t0 = Date.now();
  await page.waitForSelector('#modal[open] .spin');
  await page.click('#modal[open] [data-ui=spinOk]:not([disabled])', { timeout: 15000 });
  const spinMs = Date.now() - t0;
  if (spinMs < 4000) problems.push(`spinner: only ${spinMs} ms`);
  const bar = await page.locator('.toolbar button').evaluateAll(els => els.map(e => (e.getAttribute('aria-label') || e.innerText).trim()));
  if (bar.join('|') !== 'Undo|Full screen|Sound is on. Turn sound off|Game menu') problems.push('toolbar: expected Undo, Full screen, sound, Game menu but saw ' + bar.join('|'));
  if (await page.locator('#log').isVisible()) problems.push('log: visible by default');
  const centerImg = await page.evaluate(() => getComputedStyle(document.querySelector('#board .center')).backgroundImage);
  if (centerImg !== 'none') problems.push('board: the center still has a pattern: ' + centerImg);
  const colors = await page.evaluate(() => { const r = document.querySelector('#center .acts .btn.primary'); return getComputedStyle(r).backgroundColor; });
  await page.evaluate(() => { __mono.ui.state.debugDice = [[1, 2]]; });
  await page.keyboard.press('Space'); await page.waitForTimeout(2500);
  await page.evaluate(() => __mono.autoplay(1)).catch(() => {});
  await page.click('#menu-btn');
  await page.waitForSelector('#modal[open] [data-ui=log]');
  await page.click('#modal[open] [data-ui=log][data-v=on]');
  if (!(await page.locator('#log').isVisible())) problems.push('log: not shown after turning it on in the menu');
  await page.click('#modal[open] [data-ui=sound][data-v=off]');
  if ((await page.evaluate(() => localStorage.getItem('mono.muted'))) !== '1') problems.push('sound: Off in the menu did not mute');
  await page.click('#modal[open] [data-ui=sound][data-v=on]');
  if ((await page.evaluate(() => localStorage.getItem('mono.muted'))) !== '0') problems.push('sound: On in the menu did not unmute');
  await page.click('#modal[open] [data-ui=log][data-v=off]');
  if (await page.locator('#log').isVisible()) problems.push('log: still visible after hiding');
  console.log(`Screen test: toolbar ${bar.join(', ')}, spinner ${spinMs} ms, roll button ${colors}`);
  await ctx.close();
}

// 11. Reopening resumes the game; sound button; theme on the home screen; phone toolbar at the top.
{
  const { ctx, page } = await fresh({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await page.goto(url);
  await page.click('.setup-theme [data-v=dark]');
  if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== 'dark') problems.push('home: the theme buttons did not switch to dark');
  await page.click('.setup-theme [data-v=light]');
  await page.click('input[name=count][value="2"]', { force: true });
  await page.uncheck('#spinfirst');
  await page.click('button[type=submit]');
  await page.waitForSelector('#game:not([hidden])');
  const pos = await page.evaluate(() => ({ bar: document.querySelector('.toolbar').getBoundingClientRect().top, board: document.querySelector('#board').getBoundingClientRect().top }));
  if (!(pos.bar < pos.board)) problems.push('phone: the toolbar is not above the board');
  await page.click('#sound-btn');
  if ((await page.evaluate(() => localStorage.getItem('mono.muted'))) !== '1') problems.push('sound button: did not mute');
  if (!/off/.test(await page.getAttribute('#sound-btn', 'aria-label'))) problems.push('sound button: label did not change');
  await page.click('#sound-btn');
  if ((await page.evaluate(() => localStorage.getItem('mono.muted'))) !== '0') problems.push('sound button: did not unmute');
  await page.evaluate(() => { __mono.state.players[0].cash = 1234; __mono.state.players[1].cash = 1234; });
  await page.click('#menu-btn'); await page.click('#modal[open] [data-ui=close]'); // forces a save
  await page.waitForTimeout(400);
  await page.reload();
  await page.waitForSelector('#resume-box:not([hidden])', { timeout: 4000 }).catch(() => problems.push('resume: no Resume game box after reopening'));
  if (await page.locator('#setup-form').isVisible()) problems.push('resume: the new game options are showing before Start a new game was chosen');
  await page.click('[data-ui=resume]');
  await page.waitForSelector('#game:not([hidden])', { timeout: 4000 }).catch(() => problems.push('resume: Resume game did not open the game'));
  const cash = await page.evaluate(() => __mono.state && __mono.state.players[0].cash);
  if (cash === undefined || cash === null) problems.push('resume: no game state after resuming');
  console.log('Resume, sound button, home theme and phone toolbar test done');
  await ctx.close();
}

// 12. Button colors, X on the menu, new game in the menu with a confirmation, and the two reopen buttons.
{
  const { ctx, page } = await fresh({ viewport: { width: 1280, height: 860 } });
  await page.goto(url);
  await page.click('input[name=count][value="2"]', { force: true });
  await page.uncheck('#spinfirst');
  await page.click('button[type=submit]');
  await page.waitForSelector('#game:not([hidden])');
  const bg = sel => page.evaluate(s => getComputedStyle(document.querySelector(s)).backgroundColor, sel);
  if ((await bg('#center .acts .btn.primary')) !== 'rgb(15, 122, 92)') problems.push('buttons: Roll dice is not green: ' + await bg('#center .acts .btn.primary'));
  await page.evaluate(() => { const s = __mono.state; s.phase = 'end'; s.dice = [3, 4]; render(); });
  if ((await bg('#center .acts .btn.primary')) !== 'rgb(168, 20, 31)') problems.push('buttons: End turn is not red: ' + await bg('#center .acts .btn.primary'));
  await page.click('#menu-btn');
  await page.waitForSelector('#modal[open] #modal-x:not([hidden])').catch(() => problems.push('menu: no X button'));
  const order = await page.evaluate(() => { const b = [...document.querySelectorAll('#modal-body [data-ui]')].map(e => e.dataset.ui); return b.indexOf('newgame') > -1 && b.indexOf('newgame') < b.indexOf('theme'); });
  if (!order) problems.push('menu: Start a new game is not in the top section');
  await page.click('#modal-x');
  if (await page.locator('#modal[open]').count()) problems.push('menu: the X did not close it');
  await page.click('#menu-btn'); await page.click('#modal[open] [data-ui=newgame]');
  await page.waitForSelector('#confirm[open]').catch(() => problems.push('new game: no confirmation'));
  await page.click('#confirm [data-no]');
  if (await page.evaluate(() => document.querySelector('#game').hidden)) problems.push('new game: Keep playing still left the game');
  await page.click('#modal[open] [data-ui=newgame]'); await page.waitForSelector('#confirm[open]');
  await page.click('#confirm [data-yes]');
  await page.waitForSelector('#setup:not([hidden])');
  if (!(await page.locator('#setup-form').isVisible()) || await page.locator('#resume-box:not([hidden])').count()) problems.push('new game: after ending the game the options should show and no resume box');
  // Start another game, then reload: two buttons, options hidden until Start a new game, and a confirmation on submit
  await page.click('input[name=count][value="2"]', { force: true });
  await page.uncheck('#spinfirst');
  await page.click('button[type=submit]');
  await page.waitForSelector('#game:not([hidden])');
  await page.evaluate(() => { __mono.ui.state.debugDice = [[3, 4]]; }); await page.keyboard.press('Space'); await page.waitForTimeout(2500);
  await page.reload();
  await page.waitForSelector('#resume-box:not([hidden])');
  const two = await page.locator('#resume-box .btn').allInnerTexts();
  if (two.join('|') !== 'Resume game|Start a new game') problems.push('reopen: expected the two buttons, saw ' + two.join('|'));
  await page.click('#newopts-btn');
  if (!(await page.locator('#setup-form').isVisible())) problems.push('reopen: Start a new game did not open the new game options');
  await page.click('button[type=submit]');
  await page.waitForSelector('#confirm[open]').catch(() => problems.push('reopen: no confirmation before replacing the game'));
  await page.click('#confirm [data-no]');
  if (!(await page.evaluate(() => document.querySelector('#game').hidden))) problems.push('reopen: declining the confirmation still started a game');
  const other = await page.evaluate(() => { const b = document.createElement('button'); b.className = 'btn primary'; document.body.appendChild(b); const c = getComputedStyle(b).backgroundColor; b.remove(); return c; });
  if (other !== 'rgb(213, 47, 38)') problems.push('buttons: other main buttons changed color: ' + other);
  console.log('Button colors, menu X, new game confirmation and reopen buttons test done');
  await ctx.close();
}

// 13. Cards opened from Still for sale can be stepped through without closing.
{
  const { ctx, page } = await fresh({ viewport: { width: 390, height: 800 }, hasTouch: true });
  await page.goto(url);
  await page.click('input[name=count][value="2"]', { force: true });
  await page.uncheck('#spinfirst');
  await page.click('button[type=submit]');
  await page.waitForSelector('#game:not([hidden])');
  const total = await page.locator('#fs-row .chip').count();
  await page.locator('#fs-row .chip').nth(1).click();
  await page.waitForSelector('#modal[open] .deed-nav');
  const title = () => page.evaluate(() => document.querySelector('#modal .deed .hd strong')?.textContent);
  const pos = () => page.locator('#modal .deed-nav span').innerText();
  const first = await title();
  if ((await pos()) !== `2 of ${total}`) problems.push('deed nav: expected "2 of ' + total + '", saw ' + await pos());
  await page.click('#modal [data-ui=deedNav][data-d="1"]');
  const second = await title();
  if (second === first) problems.push('deed nav: Next did not change the card');
  await page.keyboard.press('ArrowLeft');
  if ((await title()) !== first) problems.push('deed nav: ArrowLeft did not go back');
  // swipe left = next card
  await page.evaluate(() => { const d = document.querySelector('#modal'); const mk = (type, x) => { const t = new Touch({ identifier: 1, target: d, clientX: x, clientY: 300 }); d.dispatchEvent(new TouchEvent(type, { touches: type === 'touchend' ? [] : [t], changedTouches: [t], bubbles: true })); }; mk('touchstart', 300); mk('touchend', 150); });
  if ((await title()) !== second) problems.push('deed nav: swipe left did not show the next card');
  // wraps around from the first card
  await page.locator('#modal .row-btns [data-ui=close]').click();
  await page.locator('#fs-row .chip').nth(0).click();
  await page.waitForSelector('#modal[open] .deed-nav');
  await page.keyboard.press('ArrowLeft');
  if ((await pos()) !== `${total} of ${total}`) problems.push('deed nav: did not wrap to the last card: ' + await pos());
  await page.locator('#modal .row-btns [data-ui=close]').click();
  if (await page.locator('#modal[open]').count()) problems.push('deed nav: Close did not close');
  console.log('Card navigation test done');
  await ctx.close();
}

// 14. Immersive rolling: menu toggle, tap picks the dice up, tap/flick/shake throws, 3D dice settle on the rolled faces.
{
  const { ctx, page } = await fresh({ viewport: { width: 390, height: 800 }, hasTouch: true });
  await page.goto(url);
  await page.click('input[name=count][value="2"]', { force: true });
  await page.uncheck('#spinfirst');
  await page.click('button[type=submit]');
  await page.waitForSelector('#game:not([hidden])');
  const st = () => page.evaluate(() => localStorage.getItem('mono.rollStyle'));
  if ((await st()) === 'immersive') problems.push('immersive: should be off by default');
  await page.click('#menu-btn'); await page.click('#modal [data-ui=rollstyle][data-v=immersive]');
  if ((await st()) !== 'immersive') problems.push('immersive: menu toggle did not save');
  await page.click('#modal-x');
  const idle = () => page.waitForFunction(() => !__mono.ui.animating && !document.querySelector('#throw'), null, { timeout: 15000 });
  const fresh1 = () => page.evaluate(() => { const s = __mono.ui.state; s.pending = null; s.phase = 'start'; s.dice = null; s.doubles = 0; s.cur = 0; s.players[0].inJail = false; s.fx = []; render(); syncModal(); });
  const faces = () => page.evaluate(() => [...document.querySelectorAll('#dice .die')].map(d => d.getAttribute('aria-label')).join('|'));
  // 1. Tapping Roll dice picks the dice up and does not roll yet
  await page.evaluate(() => { __mono.ui.state.debugDice = [[2, 5]]; });
  await page.locator('#center .acts .btn.primary').click();
  await page.waitForSelector('#throw.armed .tdie .cube .face').catch(() => problems.push('immersive: tapping Roll dice did not pick up the dice'));
  if ((await page.locator('#throw .tdie').count()) !== 2) problems.push('immersive: expected two dice');
  if ((await page.locator('#throw .tdie').first().locator('.face').count()) !== 6) problems.push('immersive: dice are not 3D cubes with six faces');
  await page.waitForTimeout(500);
  if (await page.evaluate(() => __mono.ui.state.dice)) problems.push('immersive: the roll happened before the throw');
  // Put them down cancels
  await page.click('#throw .throw-cancel');
  await page.waitForSelector('#throw', { state: 'detached', timeout: 3000 }).catch(() => problems.push('immersive: Put them down did not cancel'));
  if (await page.evaluate(() => __mono.ui.state.dice)) problems.push('immersive: cancelling still rolled');
  // 2. Pick up, then tap to throw; watch every frame stays on screen; faces land as rolled
  await page.evaluate(() => { window.__seen = { n: 0, out: 0 }; const tick = () => { document.querySelectorAll('#throw .tdie').forEach(d => { const r = d.getBoundingClientRect(); window.__seen.n++; if (r.left < -4 || r.top < -4 || r.right > innerWidth + 4 || r.bottom > innerHeight + 4) window.__seen.out++; }); requestAnimationFrame(tick); }; tick(); });
  await page.locator('#center .acts .btn.primary').click();
  await page.waitForSelector('#throw.armed');
  await page.mouse.click(195, 500);
  await page.waitForSelector('#throw:not(.armed)', { timeout: 3000 }).catch(() => problems.push('immersive: tapping did not throw'));
  const landed = await page.waitForSelector('#throw[data-faces]', { timeout: 8000 }).then(() => page.evaluate(() => {
    // the face pointing at the viewer is the one whose normal has the largest z after the cube's rotation
    return [...document.querySelectorAll('#throw .tdie')].map(d => { const cube = d.querySelector('.cube'); let best = null, bz = -2;
      d.querySelectorAll('.face').forEach((f, k) => { const m = new DOMMatrix(getComputedStyle(cube).transform).multiply(new DOMMatrix(getComputedStyle(f).transform)); const z = m.m33; if (z > bz) { bz = z; best = f.querySelectorAll('i').length; } }); return best; }).join(',');
  })).catch(() => null);
  if (landed !== '2,5') problems.push('immersive: 3D dice settled on ' + landed + ' instead of 2,5');
  await idle().catch(() => problems.push('immersive: dice layer never finished'));
  const seen = await page.evaluate(() => window.__seen);
  if (!(seen.n > 20)) problems.push('immersive: too few frames seen ' + seen.n);
  if (seen.out) problems.push('immersive: dice left the screen in ' + seen.out + ' frames');
  if ((await faces()) !== 'Die showing 2|Die showing 5') problems.push('immersive: center dice differ from the roll: ' + await faces());
  // 3. Flick throws (mouse drag)
  await fresh1(); await page.evaluate(() => { __mono.ui.state.debugDice = [[1, 3]]; });
  await page.locator('#center .acts .btn.primary').click(); await page.waitForSelector('#throw.armed');
  await page.mouse.move(200, 650); await page.mouse.down(); await page.mouse.move(210, 500, { steps: 2 }); await page.mouse.move(220, 300, { steps: 2 }); await page.mouse.up();
  await page.waitForSelector('#throw:not(.armed)', { timeout: 3000 }).catch(() => problems.push('immersive: flicking did not throw'));
  await idle().catch(() => {});
  if ((await faces()) !== 'Die showing 1|Die showing 3') problems.push('immersive: flick roll faces wrong: ' + await faces());
  // 4. Shake: realistic samples (linear acceleration in m/s²), with and without picking up first
  const shake = () => page.evaluate(async () => { for (const m of [2, 18, 3, 1, 20, 2, 1]) { window.dispatchEvent(new DeviceMotionEvent('devicemotion', { acceleration: { x: m, y: 0, z: 0 }, accelerationIncludingGravity: { x: m, y: 0, z: 9.8 } })); await new Promise(r => setTimeout(r, 60)); } });
  const gentle = () => page.evaluate(async () => { for (let k = 0; k < 12; k++) { window.dispatchEvent(new DeviceMotionEvent('devicemotion', { acceleration: { x: 4, y: 3, z: 0 }, accelerationIncludingGravity: { x: 4, y: 3, z: 9.8 } })); await new Promise(r => setTimeout(r, 60)); } });
  await page.evaluate(() => startMotionWatch());
  await fresh1(); await page.evaluate(() => { __mono.ui.state.debugDice = [[4, 6]]; });
  await gentle(); await page.waitForTimeout(300);
  if (await page.locator('#throw').count()) problems.push('immersive: a gentle movement (passing the phone) started a roll');
  await shake();
  await page.waitForSelector('#throw', { timeout: 3000 }).catch(() => problems.push('immersive: shaking did not roll'));
  await idle().catch(() => {});
  if ((await faces()) !== 'Die showing 4|Die showing 6') problems.push('immersive: shake roll faces wrong: ' + await faces());
  await page.waitForTimeout(2600); // shake cooldown
  await fresh1(); await page.evaluate(() => { __mono.ui.state.debugDice = [[3, 3], [1, 2]]; });
  await page.locator('#center .acts .btn.primary').click(); await page.waitForSelector('#throw.armed');
  await shake();
  await page.waitForSelector('#throw:not(.armed)', { timeout: 3000 }).catch(() => problems.push('immersive: shaking did not throw held dice'));
  await idle().catch(() => {});
  // 5. Keyboard: R picks up, Space throws
  await page.evaluate(() => { const s = __mono.ui.state; s.pending = null; render(); syncModal(); });
  await fresh1(); await page.evaluate(() => { __mono.ui.state.debugDice = [[6, 1]]; });
  await page.keyboard.press('r'); await page.waitForSelector('#throw.armed', { timeout: 2000 }).catch(() => problems.push('immersive: R did not pick up the dice'));
  await page.keyboard.press('Space');
  await page.waitForSelector('#throw:not(.armed)', { timeout: 3000 }).catch(() => problems.push('immersive: Space did not throw'));
  await idle().catch(() => {});
  // 6. Classic again: Roll dice rolls straight away, no full-screen layer
  await page.evaluate(() => { localStorage.setItem('mono.rollStyle', 'classic'); __mono.ui.rollStyle = 'classic'; });
  await fresh1(); await page.locator('#center .acts .btn.primary').click(); await page.waitForTimeout(200);
  if (await page.locator('#throw').count()) problems.push('classic: a full-screen layer appeared');
  console.log('Immersive roll test done');
  await ctx.close();
}

await browser.close();
server.close();
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log('All checks passed.');
