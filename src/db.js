'use strict';

const Database = require('better-sqlite3');
const path     = require('path');
const { app }  = require('electron');

const DB_PATH = path.join(app.getPath('userData'), 'eq-parser.db');

let db;

function getDb() {
  if (!db) throw new Error('DB not initialized');
  return db;
}

// ── Schema ────────────────────────────────────────────────────────────────────

function initSchema() {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS buff_timers (
      id   TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS debuff_timers (
      id   TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS raid_timers (
      id   TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS timer_groups (
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      pos  INTEGER DEFAULT 0,
      PRIMARY KEY (type, name)
    );

    CREATE TABLE IF NOT EXISTS profiles (
      key  TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS boss_mobs (
      name TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS boss_fight_settings (
      list TEXT NOT NULL,
      name TEXT NOT NULL,
      PRIMARY KEY (list, name)
    );

    CREATE TABLE IF NOT EXISTS known_bosses (
      name TEXT PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS boss_fights_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      boss_name   TEXT NOT NULL,
      recorded_at INTEGER NOT NULL,
      data        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS item_cache (
      id   INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS npc_cache (
      key  TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS loot_history (
      item_name   TEXT PRIMARY KEY,
      winner      TEXT NOT NULL,
      amount      INTEGER,
      type        TEXT,
      recorded_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS known_names (
      name TEXT PRIMARY KEY,
      type TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS known_log_paths (
      path TEXT PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS loot_config (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS triggers (
      id   TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS traders (
      name TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trader_snapshots (
      name TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trader_sales (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      trader     TEXT NOT NULL,
      item_name  TEXT NOT NULL,
      qty_sold   INTEGER NOT NULL DEFAULT 0,
      price_each INTEGER NOT NULL DEFAULT 0,
      total      INTEGER NOT NULL DEFAULT 0,
      sold_at    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_trader_sales_trader ON trader_sales(trader);

    CREATE TABLE IF NOT EXISTS feature_toggles (
      feature TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS players (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      friend            INTEGER NOT NULL DEFAULT 0,
      do_not_group      INTEGER NOT NULL DEFAULT 0,
      do_not_help       INTEGER NOT NULL DEFAULT 0,
      last_grouped_time INTEGER,
      last_seen_time    INTEGER,
      notes             TEXT
    );

    CREATE TABLE IF NOT EXISTS characters (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      name      TEXT    UNIQUE NOT NULL,
      class     TEXT,
      is_main   INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_characters_player ON characters(player_id);
    CREATE INDEX IF NOT EXISTS idx_characters_name   ON characters(name COLLATE NOCASE);
  `);
  // Add last_seen_time to characters if it doesn't exist yet (safe migration)
  const cols = db.prepare("PRAGMA table_info(characters)").all().map(c => c.name);
  if (!cols.includes('last_seen_time')) {
    db.prepare("ALTER TABLE characters ADD COLUMN last_seen_time INTEGER").run();
  }
}

// ── Migration from electron-store ─────────────────────────────────────────────

function migrate(store) {
  const already = getSetting('_db_migrated');
  if (already) return;

  console.log('[db] Migrating from electron-store...');

  const insert = db.transaction(() => {
    // Settings
    const simpleKeys = [
      'logPath', 'charName', 'warderName', 'spellExtendPct',
      'announceSkillups', 'currentProfileKey',
    ];
    for (const k of simpleKeys) {
      const v = store.get(k);
      if (v !== undefined) setSetting(k, v);
    }

    // Known log paths
    const logPaths = store.get('knownLogPaths', []);
    const insLogPath = db.prepare('INSERT OR IGNORE INTO known_log_paths(path) VALUES(?)');
    for (const p of logPaths) insLogPath.run(p);

    // Buff timers
    const insBuffTimer = db.prepare('INSERT OR IGNORE INTO buff_timers(id, data) VALUES(?, ?)');
    for (const t of store.get('buffTimers', [])) {
      insBuffTimer.run(t.id, JSON.stringify(t));
    }

    // Debuff timers
    const insDebuffTimer = db.prepare('INSERT OR IGNORE INTO debuff_timers(id, data) VALUES(?, ?)');
    for (const t of store.get('debuffTimers', [])) {
      insDebuffTimer.run(t.id, JSON.stringify(t));
    }

    // Raid timers
    const insRaidTimer = db.prepare('INSERT OR IGNORE INTO raid_timers(id, data) VALUES(?, ?)');
    for (const t of store.get('raidTimers', [])) {
      insRaidTimer.run(t.id, JSON.stringify(t));
    }

    // Timer groups
    const insGroup = db.prepare('INSERT OR IGNORE INTO timer_groups(type, name, pos) VALUES(?, ?, ?)');
    store.get('buffTimerGroups',   ['General']).forEach((n, i) => insGroup.run('buff',   n, i));
    store.get('debuffTimerGroups', ['General']).forEach((n, i) => insGroup.run('debuff', n, i));

    // Profiles — electron-store flattens dot-separated keys into nested JSON.
    // e.g. profile key "Erek_pq.proj" is stored as profiles["Erek_pq"]["proj"] = {...}.
    // Detect and handle both flat (no-dot server names) and nested (dot in server name).
    const insProfile = db.prepare('INSERT OR IGNORE INTO profiles(key, data) VALUES(?, ?)');
    const profiles = store.get('profiles', {});
    for (const [outerKey, outerVal] of Object.entries(profiles)) {
      if (!outerVal || typeof outerVal !== 'object' || Array.isArray(outerVal)) continue;
      const subEntries = Object.entries(outerVal);
      const allSubsAreObjects = subEntries.length > 0 &&
        subEntries.every(([, v]) => v && typeof v === 'object' && !Array.isArray(v));
      if (allSubsAreObjects) {
        // Nested: profile key has a dot (e.g. "Erek_pq.proj")
        for (const [innerKey, innerVal] of subEntries) {
          insProfile.run(`${outerKey}.${innerKey}`, JSON.stringify(innerVal));
        }
      } else {
        // Flat: profile key has no dot (e.g. "Erek_quarm")
        insProfile.run(outerKey, JSON.stringify(outerVal));
      }
    }

    // Boss mobs
    const insBoss = db.prepare('INSERT OR IGNORE INTO boss_mobs(name, data) VALUES(?, ?)');
    for (const m of store.get('bossMobInfo', [])) insBoss.run(m.name, JSON.stringify(m));

    // Known bosses
    const insKB = db.prepare('INSERT OR IGNORE INTO known_bosses(name) VALUES(?)');
    for (const n of store.get('knownBosses', [])) insKB.run(n);

    // Boss fights history
    const insFight = db.prepare(
      'INSERT OR IGNORE INTO boss_fights_history(boss_name, recorded_at, data) VALUES(?, ?, ?)'
    );
    for (const f of store.get('bossFightsHistory', [])) {
      insFight.run(f.bossName || f.boss_name || '', f.startTime || Date.now(), JSON.stringify(f));
    }

    // Item cache
    const insItem = db.prepare('INSERT OR IGNORE INTO item_cache(id, name, data) VALUES(?, ?, ?)');
    const itemCache = store.get('itemCache', {});
    for (const item of Object.values(itemCache)) {
      if (item && item.id) insItem.run(item.id, item.name || '', JSON.stringify(item));
    }

    // NPC cache
    const insNpc = db.prepare('INSERT OR IGNORE INTO npc_cache(key, name, data) VALUES(?, ?, ?)');
    const npcCache = store.get('npcCache', {});
    for (const [k, npc] of Object.entries(npcCache)) {
      if (npc) insNpc.run(k, npc.name || '', JSON.stringify(npc));
    }

    // Loot history
    const insLoot = db.prepare(
      'INSERT OR IGNORE INTO loot_history(item_name, winner, amount, type, recorded_at) VALUES(?, ?, ?, ?, ?)'
    );
    const lootHistory = store.get('lootHistory', {});
    for (const [item, rec] of Object.entries(lootHistory)) {
      insLoot.run(item, rec.winner || '', rec.amount || 0, rec.type || 'dkp', rec.date || Date.now());
    }

    // Loot config
    const insLC = db.prepare('INSERT OR IGNORE INTO loot_config(key, value) VALUES(?, ?)');
    const lc = store.get('lootConfig', {});
    for (const [k, v] of Object.entries(lc)) insLC.run(k, JSON.stringify(v));

    // Known names
    const insName = db.prepare('INSERT OR IGNORE INTO known_names(name, type) VALUES(?, ?)');
    for (const n of store.get('knownPlayers',  [])) insName.run(n, 'player');
    for (const n of store.get('knownPetNames', [])) insName.run(n, 'pet');

    // Triggers
    const insTrigger = db.prepare('INSERT OR IGNORE INTO triggers(id, data) VALUES(?, ?)');
    for (const t of store.get('triggers', [])) {
      if (t.id) insTrigger.run(t.id, JSON.stringify(t));
    }

    // Traders
    const insTrader = db.prepare('INSERT OR IGNORE INTO traders(name, data) VALUES(?, ?)');
    const traders = store.get('traders', []);
    for (const t of traders) if (t.name) insTrader.run(t.name, JSON.stringify(t));

    // Trader sales (migrate from per-name keys)
    const insTraderSale = db.prepare(
      'INSERT INTO trader_sales(trader, item_name, qty_sold, price_each, total, sold_at) VALUES(?, ?, ?, ?, ?, ?)'
    );
    for (const t of traders) {
      if (!t.name) continue;
      for (const s of store.get(`traderSales.${t.name}`, [])) {
        insTraderSale.run(t.name, s.name || '', s.qtySold || 0, s.priceEach || 0, s.total || 0, s.soldAt || Date.now());
      }
    }

    // Default feature toggles
    const insFT = db.prepare('INSERT OR IGNORE INTO feature_toggles(feature, enabled) VALUES(?, ?)');
    insFT.run('player_tracking', 1);
    insFT.run('pet_window',      1);
    insFT.run('online_inference', 1);

    setSetting('_db_migrated', true);
  });

  insert();
  console.log('[db] Migration complete.');
}

// ── Settings helpers ──────────────────────────────────────────────────────────

function getSetting(key, def) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return def;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)').run(key, JSON.stringify(value));
}

// ── Timer helpers ─────────────────────────────────────────────────────────────

function getTimers(table) {
  return db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all().map(r => JSON.parse(r.data));
}

function setTimers(table, timers) {
  db.transaction(() => {
    db.prepare(`DELETE FROM ${table}`).run();
    const ins = db.prepare(`INSERT INTO ${table}(id, data) VALUES(?, ?)`);
    for (const t of timers) ins.run(t.id, JSON.stringify(t));
  })();
}

function getTimerGroups(type) {
  return db.prepare('SELECT name FROM timer_groups WHERE type = ? ORDER BY pos').all(type).map(r => r.name);
}

function setTimerGroups(type, groups) {
  db.transaction(() => {
    db.prepare('DELETE FROM timer_groups WHERE type = ?').run(type);
    const ins = db.prepare('INSERT INTO timer_groups(type, name, pos) VALUES(?, ?, ?)');
    groups.forEach((n, i) => ins.run(type, n, i));
  })();
}

// ── Profile helpers ───────────────────────────────────────────────────────────

function getProfile(key) {
  const row = db.prepare('SELECT data FROM profiles WHERE key = ?').get(key);
  return row ? JSON.parse(row.data) : {};
}

function setProfile(key, data) {
  db.prepare('INSERT OR REPLACE INTO profiles(key, data) VALUES(?, ?)').run(key, JSON.stringify(data));
}

function getAllProfiles() {
  const rows = db.prepare('SELECT key, data FROM profiles').all();
  const out = {};
  for (const r of rows) out[r.key] = JSON.parse(r.data);
  return out;
}

// ── Boss mob helpers ──────────────────────────────────────────────────────────

function getBossMobs() {
  return db.prepare('SELECT data FROM boss_mobs ORDER BY rowid').all().map(r => JSON.parse(r.data));
}

function setBossMobs(mobs) {
  db.transaction(() => {
    db.prepare('DELETE FROM boss_mobs').run();
    const ins = db.prepare('INSERT INTO boss_mobs(name, data) VALUES(?, ?)');
    for (const m of mobs) ins.run(m.name, JSON.stringify(m));
  })();
}


function getKnownBosses() {
  return new Set(db.prepare('SELECT name FROM known_bosses').all().map(r => r.name));
}

function addKnownBoss(name) {
  db.prepare('INSERT OR IGNORE INTO known_bosses(name) VALUES(?)').run(name);
}

function getBossFightsHistory() {
  return db.prepare('SELECT data FROM boss_fights_history ORDER BY recorded_at DESC')
    .all().map(r => JSON.parse(r.data));
}

function addBossFight(fight) {
  db.prepare('INSERT INTO boss_fights_history(boss_name, recorded_at, data) VALUES(?, ?, ?)')
    .run(fight.bossName || '', fight.id || fight.startTime || Date.now(), JSON.stringify(fight));
}

function removeBossFight(id) {
  db.prepare('DELETE FROM boss_fights_history WHERE recorded_at = ?').run(id);
}

// ── Item / NPC cache helpers ──────────────────────────────────────────────────

function getItemCache() {
  const rows = db.prepare('SELECT id, data FROM item_cache').all();
  const out = {};
  for (const r of rows) out[r.id] = JSON.parse(r.data);
  return out;
}

function getItemById(id) {
  const row = db.prepare('SELECT data FROM item_cache WHERE id = ?').get(id);
  return row ? JSON.parse(row.data) : null;
}

function setItem(item) {
  db.prepare('INSERT OR REPLACE INTO item_cache(id, name, data) VALUES(?, ?, ?)')
    .run(item.id, item.name || '', JSON.stringify(item));
}

function getNpcCache() {
  const rows = db.prepare('SELECT key, data FROM npc_cache').all();
  const out = {};
  for (const r of rows) out[r.key] = JSON.parse(r.data);
  return out;
}

function getNpcByKey(key) {
  const row = db.prepare('SELECT data FROM npc_cache WHERE key = ?').get(key);
  return row ? JSON.parse(row.data) : null;
}

function setNpc(key, npc) {
  db.prepare('INSERT OR REPLACE INTO npc_cache(key, name, data) VALUES(?, ?, ?)')
    .run(key, npc.name || '', JSON.stringify(npc));
}

// ── Loot helpers ──────────────────────────────────────────────────────────────

function getLootHistory() {
  const rows = db.prepare('SELECT item_name, winner, amount, type, recorded_at FROM loot_history').all();
  const out = {};
  for (const r of rows) {
    out[r.item_name] = { winner: r.winner, amount: r.amount, type: r.type, date: r.recorded_at };
  }
  return out;
}

function setLootEntry(itemName, winner, amount, type) {
  db.prepare('INSERT OR REPLACE INTO loot_history(item_name, winner, amount, type, recorded_at) VALUES(?, ?, ?, ?, ?)')
    .run(itemName, winner, amount, type, Date.now());
}

function getLootConfig() {
  const rows = db.prepare('SELECT key, value FROM loot_config').all();
  const out = {};
  for (const r of rows) {
    try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
  }
  return out;
}

function setLootConfig(config) {
  db.transaction(() => {
    db.prepare('DELETE FROM loot_config').run();
    const ins = db.prepare('INSERT INTO loot_config(key, value) VALUES(?, ?)');
    for (const [k, v] of Object.entries(config)) ins.run(k, JSON.stringify(v));
  })();
}

// ── Known names helpers ───────────────────────────────────────────────────────

function getKnownNames(type) {
  return new Set(db.prepare('SELECT name FROM known_names WHERE type = ?').all(type).map(r => r.name));
}

function addKnownName(name, type) {
  db.prepare('INSERT OR IGNORE INTO known_names(name, type) VALUES(?, ?)').run(name, type);
}

// ── Known log paths ───────────────────────────────────────────────────────────

function getKnownLogPaths() {
  return db.prepare('SELECT path FROM known_log_paths').all().map(r => r.path);
}

function addKnownLogPath(p) {
  db.prepare('INSERT OR IGNORE INTO known_log_paths(path) VALUES(?)').run(p);
}

// ── Feature toggles ───────────────────────────────────────────────────────────

function getFeatureToggles() {
  const rows = db.prepare('SELECT feature, enabled FROM feature_toggles').all();
  const out = {};
  for (const r of rows) out[r.feature] = r.enabled === 1;
  return out;
}

function setFeatureToggle(feature, enabled) {
  db.prepare('INSERT OR REPLACE INTO feature_toggles(feature, enabled) VALUES(?, ?)').run(feature, enabled ? 1 : 0);
}

function isFeatureEnabled(feature) {
  const row = db.prepare('SELECT enabled FROM feature_toggles WHERE feature = ?').get(feature);
  return row ? row.enabled === 1 : true;
}

// ── Triggers ──────────────────────────────────────────────────────────────────

function getTriggers() {
  return db.prepare('SELECT data FROM triggers ORDER BY rowid').all().map(r => JSON.parse(r.data));
}

function setTriggers(triggers) {
  db.transaction(() => {
    db.prepare('DELETE FROM triggers').run();
    const ins = db.prepare('INSERT INTO triggers(id, data) VALUES(?, ?)');
    for (const t of triggers) if (t.id) ins.run(t.id, JSON.stringify(t));
  })();
}

// ── Traders ───────────────────────────────────────────────────────────────────

function getTraders() {
  return db.prepare('SELECT data FROM traders ORDER BY rowid').all().map(r => JSON.parse(r.data));
}

function setTrader(name, data) {
  db.prepare('INSERT OR REPLACE INTO traders(name, data) VALUES(?, ?)').run(name, JSON.stringify(data));
}

function setTraders(traders) {
  db.transaction(() => {
    db.prepare('DELETE FROM traders').run();
    const ins = db.prepare('INSERT INTO traders(name, data) VALUES(?, ?)');
    for (const t of traders) if (t.name) ins.run(t.name, JSON.stringify(t));
  })();
}

function deleteTrader(name) {
  db.prepare('DELETE FROM traders WHERE name = ?').run(name);
}

function getTraderSnapshot(name) {
  const row = db.prepare('SELECT data FROM trader_snapshots WHERE name = ?').get(name);
  return row ? JSON.parse(row.data) : null;
}

function setTraderSnapshot(name, snapshot) {
  db.prepare('INSERT OR REPLACE INTO trader_snapshots(name, data) VALUES(?, ?)').run(name, JSON.stringify(snapshot));
}

function getTraderSales(name) {
  return db.prepare('SELECT * FROM trader_sales WHERE trader = ? ORDER BY sold_at ASC').all(name)
    .map(r => ({ name: r.item_name, qtySold: r.qty_sold, priceEach: r.price_each, total: r.total, soldAt: r.sold_at }));
}

function addTraderSales(name, sales) {
  const ins = db.prepare(
    'INSERT INTO trader_sales(trader, item_name, qty_sold, price_each, total, sold_at) VALUES(?, ?, ?, ?, ?, ?)'
  );
  db.transaction(() => {
    for (const s of sales) ins.run(name, s.name || '', s.qtySold || 0, s.priceEach || 0, s.total || 0, s.soldAt || Date.now());
  })();
}

function clearTraderSales(name) {
  db.prepare('DELETE FROM trader_sales WHERE trader = ?').run(name);
}

function clearBossFightsHistory() {
  db.prepare('DELETE FROM boss_fights_history').run();
}

// ── Player / Character helpers (Feature 1) ────────────────────────────────────

function findCharacter(name) {
  return db.prepare(`
    SELECT c.*, p.friend, p.do_not_group, p.do_not_help,
           p.last_grouped_time, p.last_seen_time, p.notes
    FROM characters c JOIN players p ON p.id = c.player_id
    WHERE c.name = ? COLLATE NOCASE
  `).get(name);
}

function upsertCharacterSeen(name, now) {
  now = now || Date.now();
  let char = db.prepare('SELECT id, player_id FROM characters WHERE name = ? COLLATE NOCASE').get(name);
  if (!char) {
    const player = db.prepare('INSERT INTO players(last_seen_time) VALUES(?)').run(now);
    db.prepare('INSERT INTO characters(player_id, name) VALUES(?, ?)').run(player.lastInsertRowid, name);
    char = db.prepare('SELECT id, player_id FROM characters WHERE name = ? COLLATE NOCASE').get(name);
  }
  db.prepare('UPDATE players    SET last_seen_time = ? WHERE id = ?').run(now, char.player_id);
  db.prepare('UPDATE characters SET last_seen_time = ? WHERE id = ?').run(now, char.id);
  return char;
}

function touchFriendSeen(name, now) {
  now = now || Date.now();
  const row = db.prepare(`
    SELECT c.id, c.player_id FROM characters c
    JOIN players p ON p.id = c.player_id
    WHERE c.name = ? COLLATE NOCASE AND p.friend = 1
  `).get(name);
  if (!row) return;
  db.prepare('UPDATE players    SET last_seen_time = ? WHERE id = ?').run(now, row.player_id);
  db.prepare('UPDATE characters SET last_seen_time = ? WHERE id = ?').run(now, row.id);
}

function recordGrouped(name, now) {
  now = now || Date.now();
  const char = upsertCharacterSeen(name, now);
  db.prepare('UPDATE players SET last_grouped_time = ? WHERE id = ?').run(now, char.player_id);
}

function getPlayer(playerId) {
  const p = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (!p) return null;
  p.characters = db.prepare('SELECT * FROM characters WHERE player_id = ?').all(playerId);
  return p;
}

function getAllPlayers() {
  const players = db.prepare('SELECT * FROM players ORDER BY last_seen_time DESC').all();
  const chars   = db.prepare('SELECT * FROM characters').all();
  const byPlayer = {};
  for (const c of chars) {
    if (!byPlayer[c.player_id]) byPlayer[c.player_id] = [];
    byPlayer[c.player_id].push(c);
  }
  for (const p of players) p.characters = byPlayer[p.id] || [];
  return players;
}

function updatePlayer(id, fields) {
  const allowed = ['friend', 'do_not_group', 'do_not_help', 'notes'];
  const sets = Object.keys(fields).filter(k => allowed.includes(k));
  if (!sets.length) return;
  const sql = `UPDATE players SET ${sets.map(k => `${k} = ?`).join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...sets.map(k => fields[k]), id);
}

function updateCharacter(id, fields) {
  const allowed = ['name', 'class', 'is_main'];
  const sets = Object.keys(fields).filter(k => allowed.includes(k));
  if (!sets.length) return;
  const sql = `UPDATE characters SET ${sets.map(k => `${k} = ?`).join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...sets.map(k => fields[k]), id);
}

function addCharacterToPlayer(playerId, name, charClass, isMain) {
  return db.prepare('INSERT OR IGNORE INTO characters(player_id, name, class, is_main) VALUES(?, ?, ?, ?)')
    .run(playerId, name, charClass || null, isMain ? 1 : 0);
}

function moveCharacter(charId, toPlayerId) {
  db.prepare('UPDATE characters SET player_id = ? WHERE id = ?').run(toPlayerId, charId);
  // Delete the old player if it now has no characters
  db.prepare(`
    DELETE FROM players WHERE id NOT IN (SELECT DISTINCT player_id FROM characters)
      AND friend = 0 AND do_not_group = 0 AND do_not_help = 0 AND notes IS NULL
  `).run();
}

function deleteStaleNonFlaggedPlayers(olderThanMs) {
  const cutoff = Date.now() - olderThanMs;
  db.prepare(`
    DELETE FROM players WHERE friend = 0 AND do_not_group = 0 AND do_not_help = 0
      AND last_grouped_time IS NULL AND last_seen_time < ?
  `).run(cutoff);
}

// ── Init ──────────────────────────────────────────────────────────────────────

// One-time fix for DBs migrated before the profile key nesting was handled correctly.
// Profiles stored as { "Erek_pq": { proj: {...} } } get re-keyed to { "Erek_pq.proj": {...} }.
function fixProfileKeys() {
  if (getSetting('_profiles_rekeyed')) return;
  const rows = db.prepare('SELECT key, data FROM profiles').all();
  db.transaction(() => {
    for (const r of rows) {
      const d = JSON.parse(r.data);
      if (!d || typeof d !== 'object' || Array.isArray(d)) continue;
      const subEntries = Object.entries(d);
      const allSubsAreObjects = subEntries.length > 0 &&
        subEntries.every(([, v]) => v && typeof v === 'object' && !Array.isArray(v));
      if (allSubsAreObjects) {
        for (const [subKey, subData] of subEntries) {
          db.prepare('INSERT OR REPLACE INTO profiles(key, data) VALUES(?, ?)').run(`${r.key}.${subKey}`, JSON.stringify(subData));
        }
        db.prepare('DELETE FROM profiles WHERE key = ?').run(r.key);
      }
    }
    setSetting('_profiles_rekeyed', true);
  })();
  console.log('[db] Profile keys normalized.');
}

function init(store) {
  db = new Database(DB_PATH);
  initSchema();
  if (store) migrate(store);
  fixProfileKeys();
  return db;
}

module.exports = {
  init, getDb,
  // Settings
  getSetting, setSetting,
  // Timers
  getTimers, setTimers, getTimerGroups, setTimerGroups,
  // Profiles
  getProfile, setProfile, getAllProfiles,
  // Boss mobs
  getBossMobs, setBossMobs, removeBossFight,
  getKnownBosses, addKnownBoss, getBossFightsHistory, addBossFight, clearBossFightsHistory,
  // Item / NPC cache
  getItemCache, getItemById, setItem, getNpcCache, getNpcByKey, setNpc,
  // Loot
  getLootHistory, setLootEntry, getLootConfig, setLootConfig,
  // Known names
  getKnownNames, addKnownName,
  // Known log paths
  getKnownLogPaths, addKnownLogPath,
  // Feature toggles
  getFeatureToggles, setFeatureToggle, isFeatureEnabled,
  // Triggers
  getTriggers, setTriggers,
  // Traders
  getTraders, setTrader, setTraders, deleteTrader,
  getTraderSnapshot, setTraderSnapshot,
  getTraderSales, addTraderSales, clearTraderSales,
  // Players / Characters
  findCharacter, upsertCharacterSeen, touchFriendSeen, recordGrouped,
  getPlayer, getAllPlayers, updatePlayer, updateCharacter,
  addCharacterToPlayer, moveCharacter, deleteStaleNonFlaggedPlayers,
};
