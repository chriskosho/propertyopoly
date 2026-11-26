// Opens index.html in headless Chrome, runs the in-page rule tests, and fails on any
// failed test, uncaught error or console error.
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html');
const executablePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';

const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
const page = await browser.newPage();
const problems = [];
page.on('console', m => { if (m.type() === 'error') problems.push('console error: ' + m.text()); });
page.on('pageerror', e => problems.push('page error: ' + e.message));

await page.goto('file://' + file);
const result = await page.evaluate(() => runTests());
await browser.close();

for (const r of result.results) if (!r.pass) problems.push(`FAILED ${r.test}: ${r.error}`);
console.log(`${result.passed} passed, ${result.failed} failed`);
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
