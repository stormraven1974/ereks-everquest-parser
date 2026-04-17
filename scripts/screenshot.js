#!/usr/bin/env node
// Launches the Electron app and captures a screenshot of each tab.
// Usage: node scripts/screenshot.js
// Output: screenshots/<tab>.png

const { _electron: electron } = require('playwright');
const path = require('path');

const TABS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'setup',     label: 'Setup' },
  { id: 'timers',    label: 'Timers' },
  { id: 'raid',      label: 'Raid' },
  { id: 'loot',      label: 'Loot' },
  { id: 'trader',    label: 'Trader' },
  { id: 'log',       label: 'Log' },
];

(async () => {
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [path.resolve(__dirname, '..'), '--no-sandbox', '--disable-gpu-sandbox'],
  });

  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  // Give the UI a moment to settle (fonts, timers, etc.)
  await page.waitForTimeout(1500);

  for (const tab of TABS) {
    await page.click(`[data-tab="${tab.id}"]`);
    await page.waitForTimeout(400);
    const out = path.resolve(__dirname, '..', 'screenshots', `${tab.id}.png`);
    await page.screenshot({ path: out });
    console.log(`  saved: screenshots/${tab.id}.png`);
  }

  await app.close();
  console.log('\nDone.');
})();
