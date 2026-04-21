#!/usr/bin/env node
// Parse historical /random loot rolls from EQ log and merge into lootHistory store

const fs = require('fs');
const path = require('path');

const LOG_FILE = process.env.EQ_LOG || '/home/paul/Games/everquest/eqlog_Erek_pq.proj.txt';
const CONFIG_FILE = path.join(process.env.HOME, '.config/ereks-everquest-parser/config.json');

function cleanItemName(name) {
  return name
    .replace(/\s*-\s*$/, '')
    .replace(/\s+ran$/i, '')
    .replace(/,\s*$/, '')
    .trim();
}

function parseTimestamp(line) {
  const m = line.match(/^\[(\w{3} \w{3} +\d+ \d+:\d+:\d+ \d{4})\]/);
  if (!m) return null;
  return new Date(m[1]).getTime();
}

const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n');

// Map: number -> { itemName, ts }
const pendingByNumber = {};
// Map: itemName (lower) -> { winner, date }
const results = {};

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];

  // Officer announces items with numbers: "ItemName 1007 ItemName2 1008"
  // Guild channel loot announcement
  const announceM = line.match(/\] \S+ tells the guild[^,]*,\s*['"](.+?)['"]/i);
  if (announceM) {
    const msg = announceM[1];
    // Only process if it looks like a random loot post (contains 4-digit numbers)
    if (/\d{4}/.test(msg)) {
      const re = /(.+?)\s+(\d{4,})(?=\s+[A-Za-z]|$)/g;
      let m;
      while ((m = re.exec(msg)) !== null) {
        const rawName = cleanItemName(m[1]);
        const num = m[2];
        const ts = parseTimestamp(line);
        if (rawName && ts) {
          pendingByNumber[num] = { itemName: rawName, ts };
        }
      }
    }
  }

  // High Roll announcement
  // "**A Magic Die is rolled by Name." followed by range+result line
  // OR single-line: "(0-1003) High Roll: Name - 763 ItemName"
  const highRollM = line.match(/\(0-(\d+)\)\s+High Roll:\s+(.+?)\s+-\s+(\d+)(?:\s+(.+))?$/i);
  if (highRollM) {
    const maxNum = highRollM[1];
    const winner = highRollM[2].trim();
    const roll = parseInt(highRollM[3], 10);
    const inlineItem = highRollM[4] ? cleanItemName(highRollM[4].trim()) : null;
    const ts = parseTimestamp(line);

    // Find the pending item for this number
    const pending = pendingByNumber[maxNum];
    const itemName = inlineItem || (pending && pending.itemName);
    if (itemName && winner && ts) {
      // Only keep the most recent
      const existing = results[itemName.toLowerCase()];
      if (!existing || ts > existing.ts) {
        results[itemName.toLowerCase()] = { itemName, winner, ts };
      }
    }
    delete pendingByNumber[maxNum];
    continue;
  }

  // Two-line roll format: magic die line followed by result line
  const dieRolledM = line.match(/\*\*A Magic Die is rolled by (.+?)\./i);
  if (dieRolledM && i + 1 < lines.length) {
    const winner = dieRolledM[1].trim();
    const resultLine = lines[i + 1];
    const resultM = resultLine.match(/0 to (\d+), but this time it turned up a (\d+)/i);
    if (resultM) {
      const maxNum = resultM[1];
      const ts = parseTimestamp(line);
      const pending = pendingByNumber[maxNum];
      if (pending && ts) {
        const existing = results[pending.itemName.toLowerCase()];
        if (!existing || ts > existing.ts) {
          results[pending.itemName.toLowerCase()] = { itemName: pending.itemName, winner, ts };
        }
        delete pendingByNumber[maxNum];
      }
    }
  }
}

const entries = Object.values(results).sort((a, b) => a.itemName.localeCompare(b.itemName));
console.log(`Found ${entries.length} /random loot history entries:`);
entries.forEach(e => {
  const d = new Date(e.ts);
  console.log(`  ${e.itemName} => ${e.winner} (${d.toLocaleDateString()})`);
});

// Merge into store
const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const lootHistory = config.lootHistory || {};
let added = 0, skipped = 0;

for (const entry of entries) {
  const key = entry.itemName;
  const existing = lootHistory[key];
  // Only overwrite if this is newer or no entry exists
  if (!existing || entry.ts > existing.date) {
    lootHistory[key] = { winner: entry.winner, date: entry.ts, type: 'random' };
    added++;
  } else {
    skipped++;
  }
}

config.lootHistory = lootHistory;
fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
console.log(`\nWrote ${added} entries (${skipped} skipped — existing newer or equal)`);
console.log(`Total lootHistory entries: ${Object.keys(lootHistory).length}`);
