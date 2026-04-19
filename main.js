const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');
const Store = require('electron-store');
const { exec } = require('child_process');

const store = new Store();

// ── One-time migration from old userData path (when app was named 'eq-parser') ─
(function migrateOldStore() {
  if (store.get('_migrated_from_eq_parser')) return;
  const oldPath = path.join(app.getPath('home'), '.config', 'eq-parser', 'config.json');
  if (!fs.existsSync(oldPath)) return;
  try {
    const old = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
    // Import keys from old store that don't already exist in the new store
    for (const [k, v] of Object.entries(old)) {
      if (store.get(k) === undefined) store.set(k, v);
    }
    store.set('_migrated_from_eq_parser', true);
    console.log('Migrated settings from old eq-parser config.');
  } catch (e) {
    console.error('Migration from old config failed:', e.message);
  }
})();

// ── Profile helpers ────────────────────────────────────────────────────────────
function profileKeyFromPath(logPath) {
  if (!logPath) return 'default';
  const base = path.basename(logPath, '.txt');
  const m = base.match(/^eqlog_(.+)$/i);
  return m ? m[1] : base;
}
function pGet(field, def) {
  const key = store.get('currentProfileKey', 'default');
  return store.get(`profiles.${key}.${field}`, def);
}
function pSet(field, value) {
  const key = store.get('currentProfileKey', 'default');
  store.set(`profiles.${key}.${field}`, value);
}

// One-time migration: if profile key has no data yet, copy old flat-store settings into it
const FLAT_PROFILE_FIELDS = ['charName', 'warderName', 'spellExtendPct', 'cooldownSettings', 'announceSkillups', 'rampageChangeEnabled', 'zoneTimerOptions'];
function migrateToProfile(key) {
  if (store.get(`profiles.${key}`) !== undefined) return; // already migrated
  const flat = {};
  FLAT_PROFILE_FIELDS.forEach(f => {
    const v = store.get(f);
    if (v !== undefined) flat[f] = v;
  });
  if (Object.keys(flat).length > 0) {
    store.set(`profiles.${key}`, flat);
  }
}

// Seed default raid timers on first run
if (!store.get('raidTimers')) {
  store.set('raidTimers', [
    {
      id: 'seru_torturing_winds',
      name: 'Lord Inquisitor Seru',
      aoeTrigger: 'stricken by torturing winds',
      interval: 45,
      warningLeadTime: 10,
      deathPattern: 'Lord Inquisitor Seru has been slain',
    },
  ]);
}

let mainWindow;
let logWatcher = null;
let traderWatchers = {};
let lastFileSize = 0;
let combatData = {};
let combatActive = false;
let combatTimeout = null;
let buffTimers = {};
let debuffTimers = {};
let pendingCast = null;
let pendingCastTimeout = null;
let groupCastAnchor = {}; // { [buffId]: recipientName } - anchor for current group buff cast window
let raidTimerState = {}; // { [id]: { warningTimeout, repeatTimeout, event } }
let pendingRoller  = null; // player name buffered from "**A Magic Die is rolled by X."
let lastRampageTarget = null; // tracks current rampage target for change detection

// Boss fight tracking — last 5 persisted to store, rest in-memory only
let bossFights = store.get('bossFightsHistory', []);
let activeFights = {};         // key: bossName.toLowerCase() → { bossName, startTime, players:{} }
let pendingSummon = null;      // { owner } — set when a summon line is seen, cleared on first pet hit
let petOwners = {};            // { petNameLower -> ownerName } — current session only (owners change)
let knownPetNames = new Set(store.get('knownPetNames', [])); // pet names seen across all sessions
let knownPlayers = new Set(store.get('knownPlayers', [])); // persisted across restarts
let knownBosses  = new Set(store.get('knownBosses',  [])); // mobs that have crossed the damage threshold
const BOSS_DMG_THRESHOLD = 40000;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900, height: 800, minWidth: 700, minHeight: 600,
    backgroundColor: '#0a0e1a', titleBarStyle: 'hidden', frame: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  mainWindow.loadFile(path.join(__dirname, 'src/index.html'));
  // Open dev tools with F12
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12') mainWindow.webContents.openDevTools();
  });
}

app.whenReady().then(() => {
  createWindow();
  initTraderWatchers();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// Log Watching
ipcMain.on('start-watching', (event, logPath) => {
  const profileKey = profileKeyFromPath(logPath);
  store.set('currentProfileKey', profileKey);
  migrateToProfile(profileKey);
  if (logWatcher) { logWatcher.close(); logWatcher = null; }
  lastFileSize = 0;
  if (!fs.existsSync(logPath)) { event.reply('watch-error', 'File not found: ' + logPath); return; }
  // Track known log paths for the character switcher dropdown
  const knownLogs = store.get('knownLogPaths', []);
  if (!knownLogs.includes(logPath)) {
    knownLogs.push(logPath);
    store.set('knownLogPaths', knownLogs);
  }
  lastFileSize = fs.statSync(logPath).size;
  logWatcher = chokidar.watch(logPath, { usePolling: true, interval: 500, persistent: true });
  logWatcher.on('change', (filePath) => {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size <= lastFileSize) return;
      const fd = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(stat.size - lastFileSize);
      fs.readSync(fd, buffer, 0, buffer.length, lastFileSize);
      fs.closeSync(fd);
      lastFileSize = stat.size;
      buffer.toString('utf8').split('\n').filter(l => l.trim()).forEach(line => processLine(line, event));
    } catch (e) { console.error('Read error:', e); }
  });
  event.reply('watch-started', logPath);
});
ipcMain.on('stop-watching', () => { if (logWatcher) { logWatcher.close(); logWatcher = null; } });

// Cast tracking - gate buffs/debuffs to only the player's own spells
function clearPendingCast() {
  pendingCast = null;
  groupCastAnchor = {};
  if (pendingCastTimeout) { clearTimeout(pendingCastTimeout); pendingCastTimeout = null; }
}

const normalizeSpellName = s => s.toLowerCase().replace(/`/g, "'");

function parseCastStart(line) {
  const beginM = line.match(/\] You begin casting (.+?)\./i);
  if (beginM) { clearPendingCast(); pendingCast = normalizeSpellName(beginM[1].trim()); return; }
  if (/\] Your spell fizzles/i.test(line) || /\] Your spell is interrupted/i.test(line)) {
    clearPendingCast();
  }
}

// Pet owner tracking — Mage / Necro summons
function parsePetSummon(line) {
  const m = line.match(/\] (.+?) (?:summons a (?:swirling orb of elements|howling spirit)|animates an undead servant)\./i);
  if (m) pendingSummon = { owner: m[1].trim() };
}

function resolvePetOwner(name) {
  const key = name.toLowerCase();
  if (petOwners[key]) return petOwners[key];
  if (pendingSummon && !knownPlayers.has(key)) {
    petOwners[key] = pendingSummon.owner;
    pendingSummon = null;
    if (!knownPetNames.has(key)) {
      knownPetNames.add(key);
      store.set('knownPetNames', [...knownPetNames]);
    }
    return petOwners[key];
  }
  if (knownPetNames.has(key)) return 'Unknown Pet';
  if (!knownPlayers.has(key)) {
    knownPlayers.add(key);
    store.set('knownPlayers', [...knownPlayers]);
  }
  return name;
}

// Line Processing
function processLine(line, event) {
  event.reply('log-line', line);
  parsePetSummon(line);
  checkTriggers(line, event);
  parseCombat(line, event);
  parseCastStart(line);
  parseBuffs(line, event);
  parseDebuffs(line, event);
  parseDeaths(line, event);
  parseWarderDeath(line, event);
  parseWornOff(line, event);
  parseCombatAlerts(line, event);
  parseSkillup(line, event);
  parseCooldowns(line, event);
  parseDiscs(line, event);
  parseRaidTimers(line, event);
  parseLootMessages(line, event);
  parseTell(line, event);
  parseZone(line, event);
  parseBossFight(line, event);
}

function checkTriggers(line, event) {
  (store.get('triggers', [])).forEach(trigger => {
    if (!trigger.enabled) return;
    try {
      if (new RegExp(trigger.pattern, 'i').test(line)) {
        if (trigger.ttsText) speakText(trigger.ttsText);
        event.reply('trigger-fired', { trigger, line });
      }
    } catch (e) {}
  });
}

// Combat / DPS - spell vs melee separated
function parseCombat(line, event) {
  const patterns = [
    { re: /\] (.+?) was hit by non-melee for (\d+) points? of damage/i, who: 'You', type: 'spell' },
    { re: /\] Your .+? (?:hit|hits|blast|blasts|burn|burns|pierce|pierces) .+? for (\d+) points? of (?:non-melee |fire |cold |magic |poison |disease |chromatic )?damage/i, who: 'You', type: 'spell', dmgIdx: 1 },
    // Mob hits YOU - attacker is m[1], dmg is m[2]; flagged as incoming
    { re: /\] (.+?) (?:hit|slash|crush|pierce|kick|bash|strike|punch|backstab|bite|claw|sting|maul|gore|rend|burn|blast)(?:es|ing|s|ed)? YOU for (\d+) points? of damage/i, who: null, type: 'melee', isIncoming: true },
    // Named attacker hits named target (not YOU) — target captured in m[2], dmg in m[3]
    { re: /\] (.+?) (?:hit|slash|crush|pierce|kick|bash|strike|punch|backstab|bite|claw|sting|maul|gore|rend|burn|blast)(?:es|ing|s|ed)? (?!YOU)(.+?) for (\d+) points? of damage/i, who: null, type: 'melee', dmgIdx: 3, targetIdx: 2 },
    // Named spellcaster hits named target for non-melee damage: "Sever hit Emperor Ssraeshza for 645 points of non-melee damage."
    { re: /\] (.+?) hit (?!YOU)(.+?) for (\d+) points? of non-melee damage/i, who: null, type: 'spell', dmgIdx: 3, targetIdx: 2 },
  ];

  for (const pat of patterns) {
    const m = line.match(pat.re);
    if (!m) continue;
    const dmg = parseInt(pat.dmgIdx ? m[pat.dmgIdx] : m[2]);
    if (isNaN(dmg) || dmg <= 0) break;

    if (!combatActive) {
      combatActive = true;
      combatData = { startTime: Date.now(), totalDmg: 0, enemyTotalDmg: 0, players: {}, enemies: {} };
      event.reply('combat-start');
    }
    const attacker = pat.who || m[1];
    const target   = pat.targetIdx ? m[pat.targetIdx] : null;
    // Multi-word attacker + single-word target → mob hitting a player → enemy.
    // Multi-word attacker + multi-word target → pet/charmed mob hitting a mob → player.
    const isMob = !pat.isIncoming && attacker !== 'You' && /\s/.test(attacker)
                  && !/[`']s?\s+warder\b/i.test(attacker) && (!target || !/\s/.test(target));
    // Also incoming if target is a player's warder (e.g. "Vulak`Aerr hit Xikikaz`s warder")
    const targetIsWarder = !!(target && /[`']s?\s+warder\b/i.test(target));
    const effectiveIncoming = pat.isIncoming || isMob || targetIsWarder;
    const bucket = effectiveIncoming ? combatData.enemies : combatData.players;
    const effectiveAttacker = effectiveIncoming ? attacker : resolvePetOwner(attacker);
    if (!bucket[effectiveAttacker]) bucket[effectiveAttacker] = { totalDmg: 0, spellDmg: 0, meleeDmg: 0, hits: 0 };
    const p = bucket[effectiveAttacker];
    p.totalDmg += dmg; p.hits++;
    if (pat.type === 'spell') p.spellDmg += dmg; else p.meleeDmg += dmg;
    if (effectiveIncoming) combatData.enemyTotalDmg += dmg; else combatData.totalDmg += dmg;

    if (combatTimeout) clearTimeout(combatTimeout);
    combatTimeout = setTimeout(() => {
      combatActive = false;
      event.reply('combat-end', buildCombatSummary());
      combatData = {};
    }, 8000);
    event.reply('combat-update', buildCombatSummary());
    break;
  }
}

function mergeWarders(playersMap) {
  const result = {};
  // First pass: copy all non-warder entries
  Object.entries(playersMap).forEach(([name, data]) => {
    if (!/Warder$/i.test(name)) result[name] = { ...data };
  });
  // Second pass: merge warder stats into owner, or keep standalone if owner absent
  Object.entries(playersMap).forEach(([name, data]) => {
    const m = name.match(/^(.+?)'s\s+Warder$/i);
    if (!m) return;
    const owner = m[1].trim();
    if (result[owner]) {
      result[owner].totalDmg += data.totalDmg;
      result[owner].hits     += data.hits;
      result[owner].spellDmg += data.spellDmg;
      result[owner].meleeDmg += data.meleeDmg;
    } else {
      result[name] = { ...data };
    }
  });
  return result;
}

function buildCombatSummary() {
  const elapsed = Math.max(1, (Date.now() - combatData.startTime) / 1000);
  const toRows = (map, total) => Object.entries(map || {}).map(([name, d]) => ({
    name, totalDmg: d.totalDmg, hits: d.hits,
    dps: Math.round(d.totalDmg / elapsed),
    pct: total > 0 ? Math.round((d.totalDmg / total) * 100) : 0,
  })).sort((a, b) => b.totalDmg - a.totalDmg);
  const players = toRows(mergeWarders(combatData.players), combatData.totalDmg);
  const enemies = toRows(combatData.enemies, combatData.enemyTotalDmg);
  return {
    elapsed: Math.round(elapsed),
    totalDmg: combatData.totalDmg,
    dps: Math.round(combatData.totalDmg / elapsed),
    enemyTotalDmg: combatData.enemyTotalDmg,
    enemyDps: Math.round(combatData.enemyTotalDmg / elapsed),
    players,
    enemies,
  };
}

// ── Boss Fight Tracking ────────────────────────────────────────────────────────

function isBossTarget(name) {
  if (!name || !name.trim()) return false;
  // Generic mobs start with lowercase article — never a boss
  if (/^an? /i.test(name) && /^[a-z]/.test(name.replace(/^an? /i, ''))) return false;
  const settings = store.get('bossFightSettings', {});
  const neverList = (settings.never || []).map(n => n.toLowerCase());
  if (neverList.includes(name.toLowerCase())) return false;
  return true;
}

function parseBossFight(line, event) {
  const ts = Date.now();

  // Damage dealt BY a player/pet TO a named target
  // Reuse the two outgoing hit patterns from parseCombat
  const hitPatterns = [
    /\] (.+?) (?:hit|slash|crush|pierce|kick|bash|strike|punch|backstab|bite|claw|sting|maul|gore|rend|burn|blast)(?:es|ing|s|ed)? (?!YOU)(.+?) for (\d+) points? of damage/i,
    /\] (.+?) hit (?!YOU)(.+?) for (\d+) points? of non-melee damage/i,
  ];

  for (const re of hitPatterns) {
    const m = line.match(re);
    if (!m) continue;
    const attacker = m[1].trim();
    const target   = m[2].trim();
    const dmg      = parseInt(m[3]);
    if (isNaN(dmg) || dmg <= 0) break;

    // Skip if attacker looks like a mob (multi-word + single-word target = mob hitting player)
    const isMobAttacker = /\s/.test(attacker) && !/[`']s?\s+warder\b/i.test(attacker) && !/\s/.test(target);
    if (isMobAttacker) break;

    if (!isBossTarget(target)) break;

    const fkey = target.toLowerCase();
    if (!activeFights[fkey]) activeFights[fkey] = { bossName: target, startTime: ts, players: {} };
    const fight = activeFights[fkey];

    const key = resolvePetOwner(attacker);
    if (!fight.players[key]) fight.players[key] = { dmg: 0, firstHit: ts };
    fight.players[key].dmg += dmg;
    break;
  }

  // Boss slain lines
  const slainPatterns = [
    /\] (.+?) has been slain by/i,
    /\] You have slain (.+?)!/i,
    /\] (.+?) was slain by/i,
  ];
  for (const re of slainPatterns) {
    const m = line.match(re);
    if (!m) continue;
    const name = (m[1] || m[2] || m[3] || '').trim();
    const fkey = name.toLowerCase();
    if (activeFights[fkey]) {
      finalizeFight(activeFights[fkey], event);
      delete activeFights[fkey];
    }
    break;
  }
}

function finalizeFight(fight, event) {
  if (!fight) return;

  const totalDmg = Object.values(fight.players).reduce((s, v) => s + v.dmg, 0);
  const settings = store.get('bossFightSettings', {});
  const alwaysList = (settings.always || []).map(n => n.toLowerCase());
  const bossKey = fight.bossName.toLowerCase();
  const isAlways = alwaysList.includes(bossKey) || knownBosses.has(bossKey);

  if (!isAlways && totalDmg < BOSS_DMG_THRESHOLD) return;

  if (!knownBosses.has(bossKey)) {
    knownBosses.add(bossKey);
    store.set('knownBosses', [...knownBosses]);
  }

  const endTime = Date.now();
  const elapsed = Math.max(1, Math.round((endTime - fight.startTime) / 1000));
  const participants = Object.entries(fight.players)
    .map(([name, p]) => ({ name, dmg: p.dmg, elapsed: Math.max(1, Math.round((endTime - p.firstHit) / 1000)) }))
    .sort((a, b) => b.dmg - a.dmg);

  const record = {
    id: Date.now(),
    bossName: fight.bossName,
    date: new Date().toISOString(),
    elapsed,
    participants,
  };

  bossFights.unshift(record);
  store.set('bossFightsHistory', bossFights.slice(0, 5));
  if (event) event.reply('boss-fight-recorded', record);
}

// Buff Timers - with AA Spell Extend, recipient capture, group buff deduplication
function parseBuffs(line, event) {
  const buffDefs = store.get('buffTimers', []);
  const extendPct = (pGet('spellExtendPct', 0)) / 100;
  const charName = (pGet('charName', 'Me')).toLowerCase();
  const enabledBuffIds = pGet('enabledBuffTimers', null);

  buffDefs.forEach(buff => {
    const isEnabled = enabledBuffIds ? enabledBuffIds.includes(buff.id) : buff.enabled;
    if (!isEnabled) return;
    try {
      const m = line.match(new RegExp(buff.triggerPattern, 'i'));
      if (!m) return;

      // Only track if this is the player's own cast
      const castName = normalizeSpellName(buff.castName || buff.name);
      if (!pendingCast || pendingCast !== castName) return;
      // Group spells: hold pendingCast open for a few seconds so all targets land
      if (buff.isGroupSpell) {
        if (pendingCastTimeout) clearTimeout(pendingCastTimeout);
        pendingCastTimeout = setTimeout(clearPendingCast, 3000);
      } else {
        clearPendingCast();
      }

      // Group spells: use first recipient seen in this cast window as the anchor label,
      // collapsing all group members into one timer per cast.
      const recipient = (buff.isGroupSpell)
        ? (() => {
            if (!groupCastAnchor[buff.id]) {
              groupCastAnchor[buff.id] = m[1] ? m[1].trim() : pGet('charName', 'Me');
            }
            return groupCastAnchor[buff.id];
          })()
        : (m[1] ? m[1].trim() : pGet('charName', 'Me'));
      const extendedDur = Math.round(buff.durationSeconds * (1 + extendPct));

      // Key by buff id + recipient so each target gets its own independent timer
      const timerId = buff.id + '_' + recipient.toLowerCase();

      if (buffTimers[timerId]) clearTimeout(buffTimers[timerId].timeout);
      const endsAt = Date.now() + extendedDur * 1000;
      buffTimers[timerId] = {
        name: buff.name, recipient, endsAt, durationSeconds: extendedDur,
        timeout: setTimeout(() => {
          delete buffTimers[timerId];
          event.reply('buff-expired', { id: timerId, name: buff.name, recipient });
          if (buff.expireAlert) {
            const charName = pGet('charName', 'Me');
            const isSelf = !recipient || recipient.toLowerCase() === charName.toLowerCase() || recipient === 'Me';
            speakText(buff.name + ' fading' + (isSelf ? '' : ' on ' + recipient));
          }
        }, extendedDur * 1000),
      };
      event.reply('buff-started', { id: timerId, name: buff.name, recipient, endsAt, durationSeconds: extendedDur, group: buff.group || 'General', isGroupSpell: !!buff.isGroupSpell });
    } catch (e) {}
  });
}

// Debuff Timers
function parseDebuffs(line, event) {
  const debuffDefs = store.get('debuffTimers', []);
  const enabledDebuffIds = pGet('enabledDebuffTimers', null);
  debuffDefs.forEach(debuff => {
    const isEnabled = enabledDebuffIds ? enabledDebuffIds.includes(debuff.id) : debuff.enabled;
    if (!isEnabled) return;
    try {
      const m = line.match(new RegExp(debuff.triggerPattern, 'i'));
      if (!m) return;

      // Only track if this is the player's own cast
      const castName = normalizeSpellName(debuff.castName || debuff.name);
      if (!pendingCast || pendingCast !== castName) return;
      clearPendingCast();

      const mobName = m[1] ? m[1].trim() : 'Target';
      const id = debuff.id + '_' + mobName;
      if (debuffTimers[id]) clearTimeout(debuffTimers[id].timeout);
      const endsAt = Date.now() + debuff.durationSeconds * 1000;
      debuffTimers[id] = {
        name: debuff.name, mobName, endsAt, durationSeconds: debuff.durationSeconds,
        timeout: setTimeout(() => {
          delete debuffTimers[id];
          event.reply('debuff-expired', { id, name: debuff.name, mobName });
        }, debuff.durationSeconds * 1000),
      };
      event.reply('debuff-started', { id, name: debuff.name, mobName, endsAt, durationSeconds: debuff.durationSeconds, group: debuff.group || 'General' });
    } catch (e) {}
  });
}

// Mob Death - clear debuffs for that mob
function parseDeaths(line, event) {
  // EQ has many death message formats
  const patterns = [
    /\] (.+?) has been slain by/i,           // mob slain by someone
    /\] You have slain (.+?)!/i,              // you slew mob
    /\] (.+?) dies\./i,                      // mob dies (some versions)
    /\] (.+?) has been defeated\./i,          // alternate
    /\] (.+?) was slain by/i,                 // passive variant
  ];
  let mobName = null;
  for (const re of patterns) {
    const m = line.match(re);
    if (m) { mobName = m[1].trim(); break; }
  }
  if (!mobName) return;
  // Skip player/pet deaths
  const charName = (pGet('charName', '')).toLowerCase();
  if (mobName.toLowerCase() === charName) return;
  if (mobName.toLowerCase().includes(charName + "\`s") || mobName.toLowerCase().includes(charName + "'s")) return;
  const cleared = [];
  Object.keys(debuffTimers).forEach(id => {
    if (debuffTimers[id].mobName.toLowerCase() === mobName.toLowerCase()) {
      clearTimeout(debuffTimers[id].timeout);
      cleared.push(id);
      delete debuffTimers[id];
    }
  });
  if (cleared.length > 0) event.reply('debuffs-cleared', { mobName, ids: cleared });
}

// Warder Death - audio alert and clear warder buff timers
function parseWarderDeath(line, event) {
  const charName = pGet('charName', '');
  const warderName = pGet('warderName', '') || (charName + "'s warder");
  // Normalize both to lowercase, handle backtick vs apostrophe
  const normalize = s => s.toLowerCase().replace(/`/g, "'");
  const normalizedWarder = normalize(warderName);

  // Match death messages
  const deathPatterns = [
    /\] (.+?) has been slain by/i,
    /\] (.+?) dies\./i,
    /\] (.+?) was slain by/i,
  ];

  let died = false;
  for (const re of deathPatterns) {
    const m = line.match(re);
    if (m && normalize(m[1].trim()) === normalizedWarder) {
      died = true;
      break;
    }
  }
  if (!died) return;

  // Speak alert
  speakText('Warder down');
  event.reply('warder-died', { warderName });

  // Clear all buff timers where recipient matches warder name
  const cleared = [];
  Object.keys(buffTimers).forEach(id => {
    const b = buffTimers[id];
    if (normalize(b.recipient) === normalizedWarder) {
      clearTimeout(b.timeout);
      cleared.push({ id, name: b.name });
      delete buffTimers[id];
    }
  });
  if (cleared.length > 0) {
    event.reply('warder-buffs-cleared', { warderName, cleared });
  }
}

// Worn Off - handles both buffs and debuffs
// Matches "Your X spell has worn off." and stored spell_fades text
function parseWornOff(line, event) {
  const wornM = line.match(/\] Your (.+?) (?:spell )?has worn off\./i);
  const spellName = wornM ? wornM[1].trim().toLowerCase() : null;

  // ── Clear matching buff timers ──────────────────────────────────────────────
  const clearedBuffs = [];
  Object.keys(buffTimers).forEach(id => {
    const b = buffTimers[id];
    if (spellName && b.name.toLowerCase() === spellName) {
      clearTimeout(b.timeout);
      clearedBuffs.push({ id, name: b.name, recipient: b.recipient });
      delete buffTimers[id];
    }
  });
  // Also check spell_fades text on buff definitions
  if (clearedBuffs.length === 0) {
    const buffDefs = store.get('buffTimers', []);
    buffDefs.forEach(def => {
      if (!def.spellFades) return;
      try {
        const re = new RegExp(def.spellFades.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        if (re.test(line)) {
          Object.keys(buffTimers).forEach(id => {
            if (buffTimers[id].name.toLowerCase() === def.name.toLowerCase()) {
              clearTimeout(buffTimers[id].timeout);
              clearedBuffs.push({ id, name: buffTimers[id].name, recipient: buffTimers[id].recipient });
              delete buffTimers[id];
            }
          });
        }
      } catch (e) {}
    });
  }
  clearedBuffs.forEach(({ id, name, recipient }) => {
    event.reply('buff-expired', { id, name, recipient });
  });

  // ── Clear matching debuff timers ────────────────────────────────────────────
  const clearedDebuffs = [];
  Object.keys(debuffTimers).forEach(id => {
    const d = debuffTimers[id];
    if (spellName && d.name.toLowerCase() === spellName) {
      clearTimeout(d.timeout);
      clearedDebuffs.push({ id, name: d.name, mobName: d.mobName });
      delete debuffTimers[id];
    }
  });
  // Also check spell_fades text on debuff definitions
  if (clearedDebuffs.length === 0) {
    const debuffDefs = store.get('debuffTimers', []);
    debuffDefs.forEach(def => {
      if (!def.spellFades) return;
      try {
        const re = new RegExp(def.spellFades.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        if (re.test(line)) {
          Object.keys(debuffTimers).forEach(id => {
            if (debuffTimers[id].name.toLowerCase() === def.name.toLowerCase()) {
              clearTimeout(debuffTimers[id].timeout);
              clearedDebuffs.push({ id, name: debuffTimers[id].name, mobName: debuffTimers[id].mobName });
              delete debuffTimers[id];
            }
          });
        }
      } catch (e) {}
    });
  }
  clearedDebuffs.forEach(({ id, name, mobName }) => {
    event.reply('debuff-expired', { id, name, mobName });
  });
}

// Combat Alerts - enrage and rampage
function parseCombatAlerts(line, event) {
  // Enrage: "X has become ENRAGED!"  or "X is enraged!"
  const enrageM = line.match(/\] (.+?) (?:has become ENRAGED|is enraged)/i);
  if (enrageM) {
    const mobName = enrageM[1].trim();
    speakText('Enrage warning');
    event.reply('combat-alert', { type: 'enrage', mobName, message: mobName + ' enraged!' });
    return;
  }

  // Wild Rampage (AE rampage) — check before regular rampage since it also contains "RAMPAGE"
  const wildM = line.match(/\] (.+?) goes on a WILD RAMPAGE/i);
  if (wildM) {
    const mobName = wildM[1].trim();
    speakText('Wild rampage incoming');
    event.reply('combat-alert', { type: 'wild-rampage', mobName, message: mobName + ' wild rampage!' });
    return;
  }

  // Rampage: "MobName goes on a RAMPAGE against TargetName!"
  const rampageM = line.match(/\] (.+?) goes on a RAMPAGE against (.+?)!/i);
  if (rampageM) {
    const mobName = rampageM[1].trim();
    const target = rampageM[2].trim();
    if (pGet('rampageChangeEnabled', false)) {
      if (target.toLowerCase() !== (lastRampageTarget || '').toLowerCase()) {
        lastRampageTarget = target;
        speakText('Rampage Change ' + target);
        event.reply('combat-alert', { type: 'rampage', mobName, message: 'Rampage Change - ' + target });
      }
    }
    return;
  }

  // Rampage hit to YOU
  const rampHitM = line.match(/\] (.+?) RAMPAGES? and hits? YOU for (\d+) points? of damage/i);
  if (rampHitM) {
    const mobName = rampHitM[1].trim();
    const dmg = rampHitM[2];
    event.reply('combat-alert', { type: 'rampage-hit', mobName, dmg, message: 'RAMPAGE hit you for ' + dmg + '!' });
    return;
  }
}

// Tell Detection - ignore warder, speak sender name
// Cooldown tracking
let cooldownTimers = {};

function parseCooldowns(line, event) {
  const settings = pGet('cooldownSettings', {});

  // Paragon of Spirit — gate on pendingCast so another shaman casting it on us doesn't trigger
  if (settings.paragonEnabled) {
    const paragonPattern = settings.paragonPattern || 'Your spirit transcends';
    if (line.toLowerCase().includes(paragonPattern.toLowerCase())) {
      if (pendingCast && /paragon/i.test(pendingCast)) {
        clearPendingCast();
        const dur = (settings.paragonDuration || 900); // 15 min default
        startCooldown('paragon', 'Paragon', dur, event);
      }
    }
    // Sync from "You can use the ability Paragon of Spirits? again in X minute(s) Y seconds."
    const syncM = line.match(/You can use the ability Paragon of Spirits? again in (\d+) minute[^0-9]+(\d+) second/i);
    if (syncM) {
      const remaining = parseInt(syncM[1]) * 60 + parseInt(syncM[2]);
      if (remaining > 0) startCooldown('paragon', 'Paragon', remaining, event);
    }
  }

  // Mass Group Buff - fires when the AA activates, before the buff cast
  if (settings.mgbEnabled) {
    if (/The next group buff you cast will hit all targets in range/i.test(line)) {
      const dur = (settings.mgbDuration || 4320); // 72 min default
      startCooldown('mgb', 'Mass Group Buff', dur, event);
    }
  }

  // Frenzy of Spirit (Beastlord)
  if (settings.frenzyEnabled) {
    if (/Your body channels the spirits of battle/i.test(line)) {
      const dur = (settings.frenzyDuration || 600); // 10 min default
      startCooldown('frenzy', 'Frenzy of Spirit', dur, event);
    }
  }

  // Savagery (Beastlord) — self-cast only
  if (settings.savageryEnabled) {
    if (/Your lips curl into a feral snarl as you descend into savagery/i.test(line)) {
      const dur = (settings.savageryDuration || 180);
      startCooldown('savagery', 'Savagery', dur, event);
    }
  }

}

// Discipline cooldown detection - reads triggers saved to profile at settings-save time
// ── Raid Event Timers ─────────────────────────────────────────────────────────
function startRaidTimer(def, event) {
  if (raidTimerState[def.id]) {
    clearTimeout(raidTimerState[def.id].warningTimeout);
    clearTimeout(raidTimerState[def.id].repeatTimeout);
  }
  const leadTime = def.warningLeadTime || 10;
  const endsAt = Date.now() + def.interval * 1000;
  event.reply('raid-timer-started', { id: def.id, name: def.name, endsAt, interval: def.interval, warningLeadTime: leadTime });
  raidTimerState[def.id] = {
    warningTimeout: setTimeout(() => {
      event.reply('raid-timer-warning', { id: def.id, name: def.name });
      speakText(def.name + ' in ' + leadTime + ' seconds');
    }, (def.interval - leadTime) * 1000),
    repeatTimeout: setTimeout(() => {
      startRaidTimer(def, event);
    }, def.interval * 1000),
  };
}

function parseRaidTimers(line, event) {
  const defs = store.get('raidTimers', []);
  for (const def of defs) {
    if (def.deathPattern && (() => { try { return new RegExp(def.deathPattern, 'i').test(line); } catch(e) { return line.toLowerCase().includes(def.deathPattern.toLowerCase()); } })()) {
      if (raidTimerState[def.id]) {
        clearTimeout(raidTimerState[def.id].warningTimeout);
        clearTimeout(raidTimerState[def.id].repeatTimeout);
        delete raidTimerState[def.id];
      }
      event.reply('raid-timer-stopped', { id: def.id });
      continue;
    }
    if (def.aoeTrigger && (() => { try { return new RegExp(def.aoeTrigger, 'i').test(line); } catch(e) { return line.toLowerCase().includes(def.aoeTrigger.toLowerCase()); } })()) {
      startRaidTimer(def, event);
    }
  }
}

// ── Loot Bidding ───────────────────────────────────────────────────────────────
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseLootMessages(line, event) {
  const config = store.get('lootConfig') || {};
  if (!config.enabled) return;

  // Roll lines are system messages, not guild chat — handle before guild check
  const rollerM = line.match(/\]\s+\*\*A Magic Die is rolled by (.+?)\./i);
  if (rollerM) { pendingRoller = rollerM[1].trim(); return; }

  const rollResultM = line.match(/\]\s+\*\*It could have been any number from 0 to (\d+), but this time it turned up a (\d+)/i);
  if (rollResultM && pendingRoller) {
    event.reply('loot-roll', { player: pendingRoller, max: parseInt(rollResultM[1]), roll: parseInt(rollResultM[2]) });
    pendingRoller = null;
    return;
  }

  const guildM = line.match(/\] (.+?) tells the guild, '(.+?)'\s*$/i);
  if (!guildM) return;
  const speaker = guildM[1].trim();
  const msg     = guildM[2].trim();
  const msgUp   = msg.toUpperCase();

  const bidsOpenKw = (config.bidsOpenKeyword || 'BIDS OPEN').toUpperCase();
  const closingKw  = (config.closingKeyword  || 'CLOSING IN').toUpperCase();
  const soldKw     = (config.soldKeyword     || 'SOLD!').toUpperCase();
  const delimiter  = config.itemDelimiter    || ' // ';
  const statuses   = (config.bidStatuses || 'mem, app, alt').split(',').map(s => s.trim()).filter(Boolean);

  // Parse "Item (Winner - 125 dkp) // ..." into [{itemName,winner,amount}]
  function parseItemsWithWinners(str) {
    return str.split(delimiter).map(entry => {
      const m = entry.trim().match(/^(.+?)\s+\((.+?)\s+-\s+(\d+)\s+dkp\)$/i);
      return m ? { itemName: m[1].trim(), winner: m[2].trim(), amount: parseInt(m[3]) } : null;
    }).filter(Boolean);
  }

  // BIDS OPEN: "Item One, Item Two - BIDS OPEN"
  if (msgUp.includes(bidsOpenKw)) {
    const bidsOpenSep = config.bidsOpenSeparator || ',';
    const idx = msgUp.lastIndexOf(bidsOpenKw);
    const itemsPart = msg.substring(0, idx).replace(/[\s\-]+$/, '').replace(new RegExp(escapeRegex(bidsOpenSep) + '\\s*$'), '').trim();
    const items = itemsPart.split(bidsOpenSep).map(s => s.trim()).filter(Boolean);
    if (items.length) {
      event.reply('loot-bids-open', { items });
      // Voice alert for any character whose desired loot is up for bid
      const itemsLower = items.map(i => i.toLowerCase());
      const allProfiles = store.get('profiles', {});
      for (const [, profileData] of Object.entries(allProfiles)) {
        const desired = profileData.desiredLoot || [];
        const match = desired.find(d => itemsLower.includes(d.name.toLowerCase()));
        if (match) {
          const charName = profileData.charName || '';
          speakText('Desired loot for ' + (charName || 'your character'));
        }
      }
    }
    return;
  }

  // SOLD: "SOLD! Item (Winner - 125 dkp) // ..."
  if (msgUp.startsWith(soldKw)) {
    const rest = msg.substring(soldKw.length).replace(/^[!\s]+/, '').trim();
    event.reply('loot-sold', { updates: parseItemsWithWinners(rest) });
    return;
  }

  // CLOSING IN: "CLOSING IN 15s! ..." or "CLOSING IN LAST CALL! ..."
  if (msgUp.startsWith(closingKw)) {
    const rest = msg.substring(closingKw.length).trim();
    const secM      = rest.match(/^(\d+)s[!\s]*/i);
    const lastCallM = rest.match(/^LAST\s+CALL[!\s]*/i);
    if (secM) {
      const countdown = parseInt(secM[1]);
      const updates   = parseItemsWithWinners(rest.substring(secM[0].length).trim());
      event.reply('loot-closing', { countdown, isLastCall: false, updates });
    } else if (lastCallM) {
      const updates = parseItemsWithWinners(rest.substring(lastCallM[0].length).trim());
      event.reply('loot-closing', { countdown: null, isLastCall: true, updates });
    }
    return;
  }

  // Individual bid: "[item name] [status] [amount]"
  for (const status of statuses) {
    const re = new RegExp('^(.+?)\\s+' + escapeRegex(status) + '\\s+(\\d+)\\s*$', 'i');
    const m  = msg.match(re);
    if (m) {
      event.reply('loot-bid', { itemName: m[1].trim(), bidder: speaker, status, amount: parseInt(m[2]) });
      return;
    }
  }

  // High roll winner: "(0-2002) High Roll: Bowdown - 1563"
  const highRollM = msg.match(/^\(0-(\d+)\)\s+High Roll:\s+(.+?)\s+-\s+(\d+)$/i);
  if (highRollM) {
    event.reply('loot-random-close', { max: parseInt(highRollM[1]), winner: highRollM[2].trim(), roll: parseInt(highRollM[3]) });
    return;
  }

  // Random item announcement: "Ancient: High Priest's Bulwark - 2002"
  const randomItemM = msg.match(/^(.+?)\s+-\s+(\d+)$/);
  if (randomItemM) {
    event.reply('loot-random-open', { itemName: randomItemM[1].trim(), max: parseInt(randomItemM[2]) });
  }
}

// All disciplines share a single cooldown pool: whichever fires sets the timer for all.
function parseDiscs(line, event) {
  const discTriggers = pGet('discTriggers', []);
  const fired = discTriggers.find(({ detect }) => detect && line.toLowerCase().includes(detect.toLowerCase()));
  if (!fired) return;
  discTriggers.forEach(({ id, name }) => startCooldown(id, name, fired.cooldown, event));
}

function startCooldown(id, name, durationSeconds, event) {
  if (cooldownTimers[id]) clearTimeout(cooldownTimers[id].timeout);
  const endsAt = Date.now() + durationSeconds * 1000;
  cooldownTimers[id] = {
    name, endsAt, durationSeconds,
    timeout: setTimeout(() => {
      delete cooldownTimers[id];
      event.reply('cooldown-ready', { id, name });
      speakText(name + ' ready');
    }, durationSeconds * 1000),
  };
  event.reply('cooldown-started', { id, name, endsAt, durationSeconds });
}

ipcMain.on('dismiss-cooldown', (event, id) => {
  if (cooldownTimers[id]) { clearTimeout(cooldownTimers[id].timeout); delete cooldownTimers[id]; }
});

ipcMain.on('dismiss-raid-timer', (event, id) => {
  if (raidTimerState[id]) {
    clearTimeout(raidTimerState[id].warningTimeout);
    clearTimeout(raidTimerState[id].repeatTimeout);
    delete raidTimerState[id];
  }
});

// Skillup detection
function parseSkillup(line, event) {
  if (!pGet('announceSkillups', false)) return;
  // Format 1: "You have become better at Conjuration! (202)"  <- Project Quarm
  // Format 2: "Your skill in Abjuration has increased to 200." <- some servers
  let skill, level;
  const m1 = line.match(/\] You have become better at (.+?)!\s*\((\d+)\)/i);
  const m2 = line.match(/\] Your skill in (.+?) has increased to (\d+)\./i);
  if (m1) { skill = m1[1].trim(); level = m1[2]; }
  else if (m2) { skill = m2[1].trim(); level = m2[2]; }
  else return;
  speakText(skill + ' ' + level);
  event.reply('skillup', { skill, level });
}

function parseTell(line, event) {
  if (!/\] .+ tells you,/i.test(line)) return;
  const m = line.match(/\] (.+?) tells you,\s*['"](.+?)['"]/i);
  const sender = m ? m[1].trim() : 'Someone';
  const msg = m ? m[2] : '';
  const charName = pGet('charName', '');

  // Normalize both sides: replace backtick with apostrophe for comparison
  const normalize = s => s.toLowerCase().replace(/`/g, "'");
  const storedWarder = pGet('warderName', '');
  // Build default warder name patterns to check
  const defaultWarder = charName + "'s warder";
  const warderPatterns = [
    normalize(storedWarder),
    normalize(defaultWarder),
    normalize(charName + "\`s warder"),
  ].filter(Boolean);

  if (warderPatterns.some(w => w === normalize(sender))) return;

  // Ignore NPC vendors by surname (two word names without apostrophe)
  if (sender.includes(' ') && !sender.includes("'") && !sender.includes('`')) return;

  // Ignore vendor/merchant message content regardless of sender name
  const vendorPhrases = [
    /^that'll be /i,
    /^i'll give you /i,
    /^i don't have /i,
    /^i'm sorry/i,
    /^i cannot /i,
    /^i could not /i,
    /^i have no /i,
    /^thank you for (your business|shopping)/i,
    /^\d+ (platinum|gold|silver|copper)/i,
  ];
  if (vendorPhrases.some(re => re.test(msg))) return;

  speakText(sender);
  event.reply('tell-received', { sender, msg, line });
}

// Zone Tracking
const wordNums = { one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,
                   eleven:11,twelve:12,fifteen:15,twenty:20,thirty:30 };

function parseZone(line, event) {
  const zoneM = line.match(/\] You have entered (.+?)\./i);
  if (zoneM) {
    event.reply('zone-entered', { zoneName: zoneM[1].trim() });
    return;
  }
  const afkM = line.match(/\] \[AFK Kick\].+?kicked in (\d+) Minutes? and (\d+) Seconds?/i);
  if (afkM) {
    const totalSeconds = parseInt(afkM[1]) * 60 + parseInt(afkM[2]);
    event.reply('zone-afk-timer', { totalSeconds });
    return;
  }
  // "The portal(s) to X will become active in Y minutes"
  const portalM = line.match(/A Mystic Voice says '.+?portals? to (.+?) will become active in (\w+) minutes?/i);
  if (portalM) {
    const mins = wordNums[portalM[2].toLowerCase()] || 0;
    if (mins > 0) event.reply('portal-timer', { label: portalM[1].trim(), totalSeconds: mins * 60 });
  }
  // "X minutes till teleportation to Y"
  const teleportM = line.match(/A Mystic Voice says '(\w+) minutes? till teleportation to (.+?)\./i);
  if (teleportM) {
    const mins = wordNums[teleportM[1].toLowerCase()] || 0;
    if (mins > 0) event.reply('portal-timer', { label: teleportM[2].trim(), totalSeconds: mins * 60 });
  }
  // "In approximately X minutes the portals will become active...back to Y"
  const approxM = line.match(/In approximately (\w+) minutes the portals will become active.+?back to ([^.']+)/i);
  if (approxM) {
    const mins = wordNums[approxM[1].toLowerCase()] || 0;
    if (mins > 0) event.reply('portal-timer', { label: approxM[2].trim(), totalSeconds: mins * 60 });
  }
  // "In X minutes the portal to Y will become active" — global, can appear multiple times per line
  for (const m of line.matchAll(/In (\w+) minutes the portal to ([^.']+?) will become active/gi)) {
    const mins = wordNums[m[1].toLowerCase()] || 0;
    if (mins > 0) event.reply('portal-timer', { label: m[2].trim(), totalSeconds: mins * 60 });
  }
}

// TTS
function speakText(text) {
  const safe = text
    .replace(/[`']s\b/g, 's') // "Erek`s" / "Sha's" → "Ereks" / "Shas" (natural possessive)
    .replace(/[`']/g, ' ')    // remaining backticks/apostrophes → space
    .replace(/["\\$;|&]/g, ' ');
  const piperBin = '/usr/local/bin/piper-tts';
  const piperModel = process.env.HOME + '/.local/share/piper/en_GB-alba-medium.onnx';
  const piperCmd = 'echo "' + safe + '" | "' + piperBin + '" --model "' + piperModel + '" --output-raw 2>/dev/null | aplay -r 22050 -f S16_LE -c 1 -q 2>/dev/null';
  exec(piperCmd, (err) => {
    if (err) {
      // Fallback to festival if piper not available
      exec('echo "' + safe + '" | festival --tts', (err2) => {
        if (err2) exec('espeak "' + safe + '"', () => {});
      });
    }
  });
}
ipcMain.on('speak', (event, text) => speakText(text));

// Store
ipcMain.handle('store-get', (event, key) => store.get(key));
ipcMain.handle('store-set', (event, key, value) => store.set(key, value));

ipcMain.handle('get-profile-key', () => store.get('currentProfileKey', 'default'));
ipcMain.handle('get-profile', () => {
  const key = store.get('currentProfileKey', 'default');
  migrateToProfile(key);
  return store.get(`profiles.${key}`, {});
});
ipcMain.handle('set-profile', (event, data) => {
  const key = store.get('currentProfileKey', 'default');
  const existing = store.get(`profiles.${key}`, {});
  store.set(`profiles.${key}`, { ...existing, ...data });
});
ipcMain.handle('get-all-profile-keys', () => Object.keys(store.get('profiles', {})));
ipcMain.handle('get-known-logs', () => store.get('knownLogPaths', []));
ipcMain.handle('store-delete', (event, key) => store.delete(key));

// Export / Import JSON
ipcMain.handle('export-timers', async () => {
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Timer Definitions', defaultPath: 'eq-timers.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (!filePath) return { success: false };
  const profileKey = store.get('currentProfileKey', 'default');
  const profile = store.get(`profiles.${profileKey}`, {});
  const data = {
    buffTimers:        store.get('buffTimers', []),
    debuffTimers:      store.get('debuffTimers', []),
    buffTimerGroups:   store.get('buffTimerGroups', ['General']),
    debuffTimerGroups: store.get('debuffTimerGroups', ['General']),
    raidTimers:        store.get('raidTimers', []),
    discOverrides:     profile.discOverrides    || {},
    enabledDiscs:      profile.enabledDiscs     || [],
    cooldownSettings:  profile.cooldownSettings || {},
    exportedAt: new Date().toISOString(),
  };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return { success: true, filePath };
});

ipcMain.handle('import-timers', async () => {
  const { filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Timer Definitions',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (!filePaths || !filePaths[0]) return { success: false };
  try {
    const data = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
    if (data.buffTimers)        store.set('buffTimers',        data.buffTimers);
    if (data.debuffTimers)      store.set('debuffTimers',      data.debuffTimers);
    if (data.buffTimerGroups)   store.set('buffTimerGroups',   data.buffTimerGroups);
    if (data.debuffTimerGroups) store.set('debuffTimerGroups', data.debuffTimerGroups);
    if (data.raidTimers)        store.set('raidTimers',        data.raidTimers);
    // Merge profile fields into current profile
    const profileKey = store.get('currentProfileKey', 'default');
    const existing = store.get(`profiles.${profileKey}`, {});
    const profileUpdate = {};
    if (data.discOverrides)    profileUpdate.discOverrides    = data.discOverrides;
    if (data.enabledDiscs)     profileUpdate.enabledDiscs     = data.enabledDiscs;
    if (data.cooldownSettings) profileUpdate.cooldownSettings = data.cooldownSettings;
    if (Object.keys(profileUpdate).length > 0) {
      store.set(`profiles.${profileKey}`, { ...existing, ...profileUpdate });
    }
    return {
      success: true,
      buffCount:      (data.buffTimers   || []).length,
      debuffCount:    (data.debuffTimers || []).length,
      raidTimerCount: (data.raidTimers   || []).length,
      hasDiscs:       !!data.discOverrides || !!data.enabledDiscs,
      hasCooldowns:   !!data.cooldownSettings,
    };
  } catch (e) { return { success: false, error: e.message }; }
});

// PQDI spell lookup - scrapes pqdi.cc which uses Quarm database
ipcMain.handle('fetch-spell', async (event, spellName) => {
  try {
    const https = require('https');

    // Step 1: search for spell on find-spells page
    const query = encodeURIComponent(spellName);
    const searchHtml = await new Promise((resolve, reject) => {
      https.get('https://www.pqdi.cc/find-spells?name=' + query,
        { headers: { 'User-Agent': 'Mozilla/5.0 EQ-Parser/1.0' } },
        (res) => {
          // Handle redirects
          if (res.statusCode === 301 || res.statusCode === 302) {
            https.get(res.headers.location, { headers: { 'User-Agent': 'Mozilla/5.0 EQ-Parser/1.0' } },
              (r2) => { let d = ''; r2.on('data', c => d += c); r2.on('end', () => resolve(d)); }
            ).on('error', reject);
          } else {
            let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
          }
        }
      ).on('error', reject);
    });

    // Parse spell links from search results: /spell/NNNN
    const spells = [];
    const rowRe = /<a[^>]+href="\/spell\/(\d+)"[^>]*>([^<]+)<\/a>/gi;
    let m;
    while ((m = rowRe.exec(searchHtml)) !== null && spells.length < 8) {
      const name = m[2].trim();
      if (name && name.length >= 2 && !name.includes('PQDI') && !name.includes('Spell Search')) {
        spells.push({ id: m[1], name });
      }
    }

    if (spells.length === 0) return null;

    // Step 2: fetch detail pages for top 5 results
    const detailed = await Promise.all(spells.slice(0, 5).map(async (spell) => {
      try {
        const spellHtml = await new Promise((resolve, reject) => {
          https.get('https://www.pqdi.cc/spell/' + spell.id,
            { headers: { 'User-Agent': 'Mozilla/5.0 EQ-Parser/1.0' } },
            (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); }
          ).on('error', reject);
        });

        // Parse raw data section - PQDI has clean labeled fields
        const extract = (field) => {
          const re = new RegExp('\\*\\*' + field + ':\\*\\*\\s*([^\n:]+)', 'i');
          const m2 = spellHtml.match(re);
          return m2 ? m2[1].trim() : '';
        };

        // Also try HTML definition list format: <dt>field:</dt><dd>value</dd>
        const extractDL = (field) => {
          const re = new RegExp('<dt[^>]*>\\s*' + field + '[:\\s]*<\/dt>\\s*<dd[^>]*>([^<]*)<', 'i');
          const m2 = spellHtml.match(re);
          return m2 ? m2[1].trim() : '';
        };

        // PQDI raw data uses "**field:** value" markdown-like format in the page
        const castOnYou = extract('cast_on_you') || extractDL('cast_on_you');
        const castOnOther = extract('cast_on_other') || extractDL('cast_on_other');
        const spellFades = extract('spell_fades') || extractDL('spell_fades');

        // Duration: buffduration (ticks) + buffdurationformula
        // Formula 6 = duration scales with level, base = buffduration ticks
        // For our purposes just use buffduration * 6 seconds
        const buffduration = parseInt(extract('buffduration') || extractDL('buffduration')) || 0;
        const durationSeconds = buffduration * 6;

        // Also try to get min/max duration from the displayed table
        const minDurM = spellHtml.match(/Min Duration[^:]*:\s*[\d\s\w]+\((\d+)\s*ticks?\)/i);
        const maxDurM = spellHtml.match(/Max Duration[^:]*:\s*[\d\s\w]+\((\d+)\s*ticks?\)/i);
        const displayedDurTicks = maxDurM ? parseInt(maxDurM[1]) : (minDurM ? parseInt(minDurM[1]) : 0);
        const displayedDurSeconds = displayedDurTicks * 6;

        const finalDuration = displayedDurSeconds || durationSeconds;

        return {
          ...spell,
          cast_on_you: castOnYou,
          cast_on_other: castOnOther.replace(/^\s+/, ''), // trim leading space
          spell_fades: spellFades,
          durationSeconds: finalDuration,
        };
      } catch (e) { return spell; }
    }));

    return detailed.length > 0 ? detailed : null;
  } catch (e) { console.error('PQDI spell fetch error:', e); return null; }
});

// Dismiss timers from UI
ipcMain.on('dismiss-buff', (event, id) => {
  if (buffTimers[id]) {
    clearTimeout(buffTimers[id].timeout);
    delete buffTimers[id];
  }
});

ipcMain.on('dismiss-debuff', (event, id) => {
  if (debuffTimers[id]) {
    clearTimeout(debuffTimers[id].timeout);
    delete debuffTimers[id];
  }
});

// PQDI import by spell ID
ipcMain.handle('fetch-spell-by-id', async (event, spellId) => {
  try {
    const https = require('https');
    const spellHtml = await new Promise((resolve, reject) => {
      https.get('https://www.pqdi.cc/spell/' + spellId,
        { headers: { 'User-Agent': 'Mozilla/5.0 EQ-Parser/1.0' } },
        (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); }
      ).on('error', reject);
    });

    if (!spellHtml.includes('cast_on_you')) {
      return { error: 'Spell ID not found on PQDI' };
    }

    // Strip all HTML tags to get plain text
    const plain = spellHtml
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ');

    // Extract field value: find "fieldname: " then grab text until next "word: " pattern
    const extractField = (field) => {
      const marker = field + ': ';
      const idx = plain.indexOf(marker);
      if (idx === -1) return '';
      const rest = plain.slice(idx + marker.length);
      const nextField = rest.search(/\s+\w+(?:_\w+)*:\s/);
      const val = nextField === -1 ? rest.slice(0, 200) : rest.slice(0, nextField);
      return val.trim();
    };

    // Extract spell name from title tag: "SpellName :: Spell :: PQDI"
    const titleM = spellHtml.match(/<title>([^:]+)::/i);
    const h2M = spellHtml.match(/<h2>([^<]+)<\/h2>/);
    const name = (h2M && h2M[1].trim()) || (titleM && titleM[1].trim()) || 'Unknown Spell';

    const castOnYou   = extractField('cast_on_you');
    const castOnOther = extractField('cast_on_other').replace(/^soandso\s*/i, '').trim();
    const spellFades  = extractField('spell_fades');
    const buffduration = parseInt(extractField('buffduration')) || 0;
    const goodEffect  = extractField('goodEffect');
    const isGoodEffect = goodEffect !== '0';

    // Duration: use displayed ticks from the summary table, fall back to buffduration
    const maxDurM = spellHtml.match(/Max Duration[^:]*:\s*[\d\s\w]+\((\d+)\s*ticks?\)/i);
    const minDurM = spellHtml.match(/Min Duration[^:]*:\s*[\d\s\w]+\((\d+)\s*ticks?\)/i);
    const ticks = maxDurM ? parseInt(maxDurM[1]) : (minDurM ? parseInt(minDurM[1]) : buffduration);
    const durationSeconds = ticks * 6;

    console.log('PQDI', spellId, name, '| cast_on_you:', JSON.stringify(castOnYou), '| cast_on_other:', JSON.stringify(castOnOther), '| dur:', durationSeconds + 's');

    return { id: spellId, name, cast_on_you: castOnYou, cast_on_other: castOnOther, spell_fades: spellFades, durationSeconds, isGoodEffect };
  } catch (e) {
    console.error('PQDI ID fetch error:', e);
    return { error: e.message };
  }
});

// Open PQDI in browser
ipcMain.on('open-pqdi', (event, classId) => {
  const { shell } = require('electron');
  const url = classId
    ? 'https://www.pqdi.cc/list-spells/' + classId
    : 'https://www.pqdi.cc/spells';
  shell.openExternal(url);
});
ipcMain.on('open-pqdi-url', (event, url) => {
  const { shell } = require('electron');
  if (url && url.startsWith('https://www.pqdi.cc/')) shell.openExternal(url);
});

ipcMain.handle('minimize-window', () => mainWindow.minimize());
ipcMain.handle('close-window', () => mainWindow.close());

// ── Equipment & Desired Loot ──────────────────────────────────────────────────

function pqdiGet(url) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 EQ-Parser/1.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return resolve(pqdiGet(res.headers.location));
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
  });
}

async function fetchEffectName(id) {
  if (!id || id <= 0) return null;
  try {
    const json = await pqdiGet(`https://www.pqdi.cc/api/v1/spell/${id}`);
    const s = JSON.parse(json);
    return (s && s.name) ? s.name : null;
  } catch (e) { return null; }
}

ipcMain.handle('fetch-item', async (event, itemId, force) => {
  const cacheKey = `itemCache.${itemId}`;
  const cached = store.get(cacheKey);
  if (cached && !force) return cached;
  try {
    const json = await pqdiGet(`https://www.pqdi.cc/api/v1/item/${itemId}`);
    const d = JSON.parse(json);
    if (!d || !d.Name) return null;

    const [focusName, wornName, clickName, procName] = await Promise.all([
      fetchEffectName(d.focuseffect),
      fetchEffectName(d.worneffect),
      fetchEffectName(d.clickeffect),
      fetchEffectName(d.proceffect),
    ]);

    const item = {
      id:     d.id,     name:   d.Name,
      ac:     d.ac     || 0,  hp:    d.hp    || 0,
      mana:   d.mana   || 0,  astr:  d.astr  || 0,
      adex:   d.adex   || 0,  asta:  d.asta  || 0,
      aint:   d.aint   || 0,  awis:  d.awis  || 0,
      aagi:   d.aagi   || 0,  acha:  d.acha  || 0,
      cr:     d.cr     || 0,  dr:    d.dr    || 0,
      fr:     d.fr     || 0,  mr:    d.mr    || 0,
      pr:     d.pr     || 0,  damage: d.damage || 0,
      delay:  d.delay  || 0,  slots:   d.slots   || 0,
      magic:  d.magic  || 0,  classes: d.classes || 0,  races: d.races || 0,
      icon:   d.icon   || 0,
      effects: {
        focus: focusName,
        worn:  wornName,
        click: clickName,
        proc:  procName,
      },
    };
    store.set(cacheKey, item);
    return item;
  } catch (e) {
    console.error('fetch-item error:', e);
    return null;
  }
});

ipcMain.handle('search-items', async (event, name) => {
  try {
    const json = await pqdiGet(`https://www.pqdi.cc/api/v1/items?name=${encodeURIComponent(name)}`);
    const data = JSON.parse(json);
    return data.items || [];
  } catch (e) {
    console.error('search-items error:', e);
    return [];
  }
});

ipcMain.handle('search-npc', async (event, name) => {
  try {
    const json = await pqdiGet(`https://www.pqdi.cc/api/v1/npcs?name=${encodeURIComponent(name)}`);
    const data = JSON.parse(json);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error('search-npc error:', e);
    return [];
  }
});

ipcMain.handle('fetch-npc-drops', async (event, npcId) => {
  try {
    const html = await pqdiGet(`https://www.pqdi.cc/npc/${npcId}`);

    // ── Drops ──────────────────────────────────────────────────────────────────
    const drops = [];
    const seen = new Set();
    const itemRe = /href="\/item\/(\d+)"[^>]*>\s*([^<]+?)\s*<\/a>\s*([\d.]+)%/g;
    let m;
    while ((m = itemRe.exec(html)) !== null) {
      const id = parseInt(m[1]);
      const name = m[2].trim();
      const dropRate = parseFloat(m[3]);
      if (!seen.has(id)) { seen.add(id); drops.push({ id, name, dropRate }); }
    }
    drops.sort((a, b) => b.dropRate - a.dropRate);

    // ── Resists (scraped from the MR/CR/FR/DR/PR table on the page) ────────────
    // Headers are <th>MR</th>…<th>PR</th>; values are <td>N</td> in the next row.
    let resists = null;
    const resistRe = /MR[\s\S]{0,60}?CR[\s\S]{0,60}?FR[\s\S]{0,60}?DR[\s\S]{0,60}?PR[\s\S]{0,800}?<t[dh][^>]*>\s*(\d+)\s*<\/t[dh]>[\s\S]{0,200}?<t[dh][^>]*>\s*(\d+)\s*<\/t[dh]>[\s\S]{0,200}?<t[dh][^>]*>\s*(\d+)\s*<\/t[dh]>[\s\S]{0,200}?<t[dh][^>]*>\s*(\d+)\s*<\/t[dh]>[\s\S]{0,200}?<t[dh][^>]*>\s*(\d+)\s*<\/t[dh]>/;
    const rm = resistRe.exec(html);
    if (rm) resists = { mr: +rm[1], cr: +rm[2], fr: +rm[3], dr: +rm[4], pr: +rm[5] };

    // ── Special Abilities ──────────────────────────────────────────────────────
    // Slice between "Special Abilities" and the next major section or end of page.
    let specialAbilities = [];
    const saIdx   = html.search(/Special\s+Abilities\s*:/i);
    const spellMarker = html.search(/Can\s+cast\s+these\s+spells/i);
    if (saIdx >= 0) {
      const saEnd = spellMarker > saIdx ? spellMarker : Math.min(saIdx + 2000, html.length);
      const saSrc = html.slice(saIdx, saEnd);
      const saText = saSrc
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
        .replace(/&#\d+;/g,' ').replace(/\s+/g,' ')
        .replace(/Special\s+Abilities\s*:/i, '')
        .trim();
      specialAbilities = saText.split(',').map(s => s.trim()).filter(s => s.length > 1);
    }

    // ── Spells ─────────────────────────────────────────────────────────────────
    let spells = [];
    if (spellMarker >= 0) {
      const spellSrc = html.slice(spellMarker, spellMarker + 4000);
      const spellLinkRe = /href="\/spell\/(\d+)"[^>]*>\s*([^<]+?)\s*<\/a>/g;
      let sm;
      while ((sm = spellLinkRe.exec(spellSrc)) !== null) {
        spells.push({ id: parseInt(sm[1]), name: sm[2].trim() });
      }
    }

    return { drops, resists, specialAbilities, spells };
  } catch (e) {
    console.error('fetch-npc-drops error:', e);
    return { drops: [], resists: null, specialAbilities: [], spells: [] };
  }
});

ipcMain.handle('load-equipment-file', async () => {
  const logPath = store.get('logPath', '');
  if (!logPath) return { error: 'No log file configured' };
  const dir  = path.dirname(logPath);
  const base = path.basename(logPath, '.txt');
  const m    = base.match(/^eqlog_([^_]+)/i);
  if (!m) return { error: 'Could not derive character name from log path' };
  const invPath = path.join(dir, m[1] + '-Inventory.txt');
  try {
    const content = fs.readFileSync(invPath, 'utf8');
    const lines = content.split('\n');
    const equipSlots = new Set(['Ear','Head','Face','Neck','Shoulders','Arms','Back','Wrist','Range','Hands','Primary','Secondary','Fingers','Chest','Legs','Feet','Waist','Ammo']);
    const items = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split('\t');
      if (cols.length < 4) continue;
      const slot = (cols[0] || '').trim();
      const name = (cols[1] || '').trim();
      const id   = parseInt(cols[2]) || 0;
      if (!equipSlots.has(slot) || !name || name === 'Empty' || id === 0) continue;
      items.push({ slot, name, id });
    }
    return { items, invPath };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('get-equipment',    ()           => pGet('equipment',   []));
ipcMain.handle('set-equipment',    (event, val) => pSet('equipment',   val));
ipcMain.handle('get-desired-loot', ()           => pGet('desiredLoot', []));
ipcMain.handle('set-desired-loot', (event, val) => pSet('desiredLoot', val));

// ── Trader ────────────────────────────────────────────────────────────────────

function parseTraderInventory(content) {
  const items = {};
  const lines = content.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    if (cols.length < 4) continue;
    const loc   = (cols[0] || '').trim();
    const name  = (cols[1] || '').trim();
    const count = parseInt(cols[3]) || 0;
    if (!/^General[2-8]-Slot\d+$/i.test(loc)) continue;
    if (!name || name === 'Empty' || count <= 0) continue;
    items[name] = (items[name] || 0) + count;
  }
  return items;
}

function parsePriceIni(content) {
  const prices = {};
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('[')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const name = t.slice(0, eq).trim();
    const val  = parseInt(t.slice(eq + 1).trim());
    if (name && !isNaN(val)) prices[name] = val;
  }
  return prices;
}

function findPriceIniPath(eqDir, charName) {
  try {
    const files = fs.readdirSync(eqDir);
    const match = files.find(f =>
      f.toLowerCase().startsWith('bzr_' + charName.toLowerCase() + '_') && f.endsWith('.ini')
    );
    return match ? path.join(eqDir, match) : null;
  } catch (e) { return null; }
}

function diffInventory(prev, curr) {
  const sold = [];
  for (const [name, prevCount] of Object.entries(prev)) {
    const currCount = curr[name] || 0;
    if (currCount < prevCount) sold.push({ name, qtySold: prevCount - currCount });
  }
  return sold;
}

function broadcastTraderData(charName, eqDir) {
  if (!mainWindow) return;
  const invPath = path.join(eqDir, `${charName}-Inventory.txt`);
  if (!fs.existsSync(invPath)) return;
  try {
    const curr    = parseTraderInventory(fs.readFileSync(invPath, 'utf8'));
    const iniPath = findPriceIniPath(eqDir, charName);
    const prices  = iniPath ? parsePriceIni(fs.readFileSync(iniPath, 'utf8')) : {};
    const items   = Object.entries(curr)
      .map(([name, count]) => ({ name, count, price: prices[name] !== undefined ? prices[name] : -1 }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const sales = store.get(`traderSales.${charName}`, []);
    mainWindow.webContents.send('trader-data', { charName, items, sales });
  } catch (e) { console.error('broadcastTraderData error:', e); }
}

function startTraderWatcher(trader) {
  const { name, eqDir } = trader;
  if (traderWatchers[name]) { traderWatchers[name].close(); delete traderWatchers[name]; }
  const invPath = path.join(eqDir, `${name}-Inventory.txt`);
  if (!fs.existsSync(invPath)) { console.warn(`Trader inventory not found: ${invPath}`); return; }

  const snapKey = `traderSnapshot.${name}`;
  if (!store.get(snapKey)) {
    store.set(snapKey, parseTraderInventory(fs.readFileSync(invPath, 'utf8')));
  }

  const watcher = chokidar.watch(invPath, { usePolling: true, interval: 3000, persistent: true });
  watcher.on('change', () => {
    try {
      const content = fs.readFileSync(invPath, 'utf8');
      const curr    = parseTraderInventory(content);
      const prev    = store.get(snapKey, {});
      const iniPath = findPriceIniPath(eqDir, name);
      const prices  = iniPath ? parsePriceIni(fs.readFileSync(iniPath, 'utf8')) : {};
      const sold    = diffInventory(prev, curr);
      if (sold.length > 0) {
        const salesKey  = `traderSales.${name}`;
        const timestamp = Date.now();
        const newSales  = sold.map(s => ({
          name: s.name, qtySold: s.qtySold,
          priceEach: prices[s.name] || 0,
          total: (prices[s.name] || 0) * s.qtySold,
          soldAt: timestamp,
        }));
        store.set(salesKey, [...store.get(salesKey, []), ...newSales]);
      }
      store.set(snapKey, curr);
      broadcastTraderData(name, eqDir);
    } catch (e) { console.error('Trader watcher error:', e); }
  });
  traderWatchers[name] = watcher;
}

function initTraderWatchers() {
  store.get('traders', []).forEach(t => startTraderWatcher(t));
}

ipcMain.handle('get-traders', () => store.get('traders', []));

ipcMain.handle('set-traders', (event, traders) => {
  const old = store.get('traders', []);
  old.filter(t => !traders.find(n => n.name === t.name)).forEach(t => {
    if (traderWatchers[t.name]) { traderWatchers[t.name].close(); delete traderWatchers[t.name]; }
  });
  traders.filter(t => !old.find(o => o.name === t.name)).forEach(t => startTraderWatcher(t));
  store.set('traders', traders);
  return { success: true };
});

ipcMain.handle('get-trader-data', (event, charName) => {
  const trader = store.get('traders', []).find(t => t.name === charName);
  if (!trader) return null;
  const invPath = path.join(trader.eqDir, `${charName}-Inventory.txt`);
  const iniPath = findPriceIniPath(trader.eqDir, charName);
  let items = [];
  if (fs.existsSync(invPath)) {
    const curr   = parseTraderInventory(fs.readFileSync(invPath, 'utf8'));
    const prices = iniPath ? parsePriceIni(fs.readFileSync(iniPath, 'utf8')) : {};
    items = Object.entries(curr)
      .map(([name, count]) => ({ name, count, price: prices[name] !== undefined ? prices[name] : -1 }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  return { items, sales: store.get(`traderSales.${charName}`, []) };
});

ipcMain.handle('clear-trader-sales', (event, charName) => {
  store.delete(`traderSales.${charName}`);
  return { success: true };
});

// ── Boss Fight IPC ─────────────────────────────────────────────────────────────
ipcMain.handle('get-boss-fights',          ()           => bossFights);
ipcMain.handle('get-boss-fight-settings',  ()           => store.get('bossFightSettings', { always: [], never: [] }));
ipcMain.handle('set-boss-fight-settings',  (e, val)     => store.set('bossFightSettings', val));
ipcMain.handle('clear-boss-fights',        ()           => { bossFights = []; store.delete('bossFightsHistory'); });

ipcMain.handle('seed-boss-fights-from-log', (e, logPath) => {
  if (!logPath || !fs.existsSync(logPath)) return { seeded: 0 };

  const settings   = store.get('bossFightSettings', {});
  const alwaysList = (settings.always || []).map(n => n.toLowerCase());
  const neverList  = (settings.never  || []).map(n => n.toLowerCase());

  function qualifies(name) {
    if (!name) return false;
    if (/^an? /i.test(name) && /^[a-z]/.test(name.replace(/^an? /i, ''))) return false;
    if (neverList.includes(name.toLowerCase())) return false;
    return true;
  }

  const hitRe   = /\[.+?\] (.+?) (?:hit|slash|crush|pierce|kick|bash|strike|punch|backstab|bite|claw|sting|maul|gore|rend|burn|blast)(?:es|ing|s|ed)? (?!YOU)(.+?) for (\d+) points? of (?:non-melee )?damage/i;
  const slainRe = /\[.+?\] (?:(.+?) has been slain by|You have slain (.+?)!|(.+?) was slain by)/i;
  const tsRe    = /^\[(.+?)\]/;

  const completed = [];
  const active = {}; // target (lowercase) → { bossName, startMs, lastMs, players:{} }

  const lines = fs.readFileSync(logPath, 'utf8').split('\n');
  for (const line of lines) {
    // Hit line
    const hm = line.match(hitRe);
    if (hm) {
      const attacker = hm[1].trim();
      const target   = hm[2].trim();
      const dmg      = parseInt(hm[3]);
      const isMob    = /\s/.test(attacker) && !/[`']s?\s+warder\b/i.test(attacker) && !/\s/.test(target);
      if (!isMob && qualifies(target)) {
        const tsM = line.match(tsRe);
        const ts  = tsM ? new Date(tsM[1]).getTime() : Date.now();
        const key = target.toLowerCase();
        if (!active[key]) active[key] = { bossName: target, startMs: ts, lastMs: ts, players: {} };
        active[key].lastMs = ts;
        if (!active[key].players[attacker]) active[key].players[attacker] = { dmg: 0, firstHit: ts };
        active[key].players[attacker].dmg += dmg;
      }
      continue;
    }

    // Slain line — finalize that target's fight
    const sm = line.match(slainRe);
    if (sm) {
      const name = (sm[1] || sm[2] || sm[3] || '').trim();
      const key  = name.toLowerCase();
      if (active[key]) {
        completed.push(active[key]);
        delete active[key];
      }
    }
  }
  // Any fights still open (no slain line found) — push them too
  Object.values(active).forEach(f => completed.push(f));

  // Filter by threshold / always list and build records
  const records = completed
    .filter(f => {
      const total = Object.values(f.players).reduce((s, v) => s + v.dmg, 0);
      return alwaysList.includes(f.bossName.toLowerCase()) || total >= BOSS_DMG_THRESHOLD;
    })
    .map(f => ({
      id: f.startMs,
      bossName: f.bossName,
      date: new Date(f.lastMs).toISOString(),
      elapsed: Math.max(1, Math.round((f.lastMs - f.startMs) / 1000)),
      participants: Object.entries(f.players)
        .map(([name, p]) => ({ name, dmg: p.dmg, elapsed: Math.max(1, Math.round((f.lastMs - p.firstHit) / 1000)) }))
        .sort((a, b) => b.dmg - a.dmg),
    }))
    .slice(-5)
    .reverse();

  bossFights = records;
  store.set('bossFightsHistory', bossFights);
  return { seeded: records.length };
});
