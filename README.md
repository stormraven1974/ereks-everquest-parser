# Erek's Everquest Parser

A native Linux EverQuest log parser with DPS meter, buff/debuff timers, boss mob tracker,
loot bidding, loot wishlist, player/friend tracking, and audio triggers. Built with Electron — no Wine required.

## Prerequisites

### Required

- **Node.js 18+** and **npm**
  ```bash
  # Ubuntu/Debian
  sudo apt install nodejs npm

  # Or use nvm for the latest version:
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm-v0.39.7/install.sh | bash
  nvm install 18
  ```

### Guild Chat Output (for boss mob / fight output)

- **xdotool** and **wmctrl** — used to type directly into the EQ window
  ```bash
  sudo apt install xdotool wmctrl
  ```

### Text-to-Speech (for Audio Triggers)

The app tries TTS engines in this order, falling back if one isn't found:

1. **piper-tts** *(best quality — optional)*
   Download from [github.com/rhasspy/piper](https://github.com/rhasspy/piper/releases).
   Install the binary to `/usr/local/bin/piper-tts` and place an `.onnx` voice model at
   `~/.local/share/piper/en_GB-alba-medium.onnx` (or any voice from the piper releases page).
   Also requires `aplay` (`sudo apt install alsa-utils`).

2. **festival** *(good quality — optional)*
   ```bash
   sudo apt install festival
   ```

3. **espeak** *(minimal — recommended fallback)*
   ```bash
   sudo apt install espeak
   ```

At least one of these should be installed for audio triggers to work.

## Install & Run

```bash
git clone https://github.com/stormraven1974/ereks-everquest-parser.git
cd ereks-everquest-parser
npm install
npm start
```

> **Note:** `npm start` passes `--no-sandbox` automatically, which is required on most
> Linux systems unless you've configured the Chrome sandbox (setuid helper). If you
> want to run without that flag, use `npm run start-gpu` instead.

## First Time Setup

1. Go to the **Setup** tab
2. Enter your EQ log file path, e.g.:
   `/home/paul/Games/everquest/eqlog_Erek_pq.proj.txt`
3. Enter your character name and class (e.g. `Erek` / `Beastlord`) for DPS highlighting and loot usability checks
4. Click **Watch** then **Save Settings**

## Storage

All persistent data is stored in a single **SQLite database** at:

```
~/.config/ereks-everquest-parser/data.db
```

This includes player records, timer definitions, settings, DPS history, buff data, loot config, boss fights, trader data, and item/NPC cache. There is no longer any JSON settings file — everything lives in the database. If you need to reset the app to a clean state, delete `data.db` and restart.

The first time you run a new version, any data from the old electron-store format is automatically migrated into SQLite and the old store is left untouched as a backup.

## Features

### DPS Meter
- Live updates during combat
- Shows all players/NPCs dealing damage
- Damage %, DPS, and total damage per entity
- Auto-resets after 8 seconds of no combat activity
- **Boss fight tracking** — records fights against any mob in your Boss Mobs list; full history persisted across restarts with all participants and DPS
- **Post to Guild** — sends a compact fight summary to EQ guild chat via xdotool:
  `Boss 184s 1.2M@6700: Player1 75K, Player2 60K, ...` (fits as many players as possible in 255 chars)

### Engaged Mob Card
- Automatically appears when you start hitting a mob
- Shows resist profile (MR/CR/FR/DR/PR), HP, level, special abilities, and spells
- Pulls from your saved boss mob list first; falls back to a live PQDI lookup by name
- Debounced 500ms to avoid flicker when switching targets
- Auto-hides 8 seconds after the mob dies (dismissable manually)

### Group Panel
- Appears automatically at the top of the main view whenever you are in a group
- One card per member showing class icon, character name, and flag indicators (friend ★, Do Not Group, Do Not Help)
- **Class-based color coding** — each card has a muted dark background and colored left-border accent matching the character's class
- Updates in real time as players join or leave the group; class changes in the edit modal reflect immediately
- **Add Friend** and **Blacklist** quick-action buttons on each card
- Class icons for all 16 EQ classes; falls back to a colored abbreviation badge if the image is missing
- Your own character card always appears even if you were grouped before the app started

### Alpha Loot Tracker
- Tracks who is next for alpha (first pick) loot in a group
- Rotation seeded automatically from current group members when enabled; new members joining mid-session are slotted in alphabetically without requiring a reset
- Rotation advances only when the **current alpha person** loots a tracked item — not on any arbitrary loot
- **Voice + toast confirmation** when the alpha looter takes an item: announces who looted what and who is next
- **On/Off toggle** in the group panel alpha bar — enable or disable without going to Setup
- **Item search** in Setup — type to search PQDI item database and add items to the alpha list directly from results
- **Post** button sends `Next alpha: X (after: Y)` to group chat via xdotool
- Skip and Reset buttons available in the alpha bar

### Boss Mob List
- Maintain a roster of raid bosses with HP, level, zone, resists, and notes
- **This list controls fight tracking** — only mobs in this list are recorded as boss fights; add a mob here and its next kill is automatically captured
- **PQDI sync** — click the PQDI button on any mob to pull live data from pqdi.cc:
  - Hit points, level, resists (MR/CR/FR/DR/PR) scraped from the HTML page
  - Special abilities (Flurry, Rampage, Summon, Enrage, etc.)
  - Spells the NPC can cast, with links to spell data
- **Slowability** — each mob shows whether it's slowable by Shaman/Enchanter slow, disease slow only, or unslowable; included in the guild announcement
- **Special abilities & spells** — each ability and spell shown as a chip; click **+** to add it directly to your timer list, pre-filled with trigger text, duration, and spell-fades message pulled from PQDI
- **Guild output** — the **Guild** button builds a summary line and types it directly into EQ guild chat:
  `Boss Name (12k hp) | MR:190 FR:1000 | Flurries | Ancient Breath, Gift of A'err`
- **Zone editing** — mobs without a zone can have one assigned via a dropdown of all known zones

### Buff & Debuff Timers
- Add buff/debuff definitions with name, log trigger pattern, and duration
- Use **PQDI Spell Lookup** to auto-fill cast text and duration from pqdi.cc
- **+Timer button on Spells list** — click any spell with a duration to open the buff or debuff modal pre-filled with name, trigger pattern, duration, and spell-fades text pulled from PQDI; instant spells (direct damage etc.) do not show the button
- Countdown bars with warning highlight under 30 seconds
- Optional TTS alert when buff expires
- Timers grouped by category (Pet Buffs, Stat Buffs, Regen, Haste, etc.)
- Group spells track all party members separately under one definition

### Raid Event Timers
- Repeating AOE countdown timers for raid bosses
- Trigger fires on a log pattern (e.g. AoE landing message); resets automatically
- Warning alert at a configurable lead time before the next hit
- Stops cleanly on the boss death message
- Global — not tied to any character profile

### Loot Bidding
- Live DKP bidding panel — tracks open items, bids by player, and countdown timers
- Triggered by guild chat announcements (works whether you or another officer is calling)
- **BIDS OPEN** — `Item One, Item Two - BIDS OPEN` opens bid cards for each item
  - Item icon and stats auto-fetched from pqdi.cc for any item not already cached
  - Voice alert if any open item matches your desired loot list
- **Individual bids** — `Item Name mem 125` / `Item Name app 80` / `Item Name alt 50`
  - Configurable status keywords (default: mem, app, alt)
- **CLOSING IN** — `CLOSING IN 30s! Item (CurrentWinner - 125 dkp)` starts countdown
- **LAST CALL** — `CLOSING IN LAST CALL! Item (Winner - 125 dkp)`
- **SOLD** — `SOLD! Item (Winner - 125 dkp)` or `Item - Winner - 125 dkp - SOLD!` closes bidding and saves to history
- **Random roll mode** — tracks `/random` rolls per item; duplicate rolls from the same player are ignored (first roll wins)
- All keywords and separators configurable in Setup

### Loot Wishlist
- Per-character gear tracking — record what's equipped in each slot
- **Desired loot list** — mark items you want, organized by slot
- **Item tooltips** with stat comparison against your currently equipped item:
  - For multi-slot items (rings, earrings) compares against every item in those slots
  - Shows item slot(s), all stats, and usable classes/races
  - Your class and race highlighted in green (usable) or red (not usable)
- **I Want This** button on mob loot items adds them to your wishlist in one click
- Item data pulled from pqdi.cc API and cached locally; refreshed automatically when syncing a mob

### Player & Friend Tracking

Player records are automatically created when a character is seen speaking in group chat,
guild chat, raid chat, or an incoming tell. Auction, OOC, shout, and chat channels are
ignored for record creation, but if a **known friend** speaks in any of those channels their
online status is updated silently.

#### Players Tab
- Full list of all known players, searchable by name
- Each player record stores: friend flag, Do Not Group, Do Not Help, freeform notes, and a list of linked characters with class and main designation
- Click any row to open the **edit modal**: manage flags, notes, and the character list
- **Linking alts** — add multiple character names to one player record; designate a main; moving a character from another player's record automatically cleans up the old record if it becomes empty
- **Load from Log** — scans your full log history and seeds the player database from all group/guild/raid/tell activity, preserving the original timestamps
- **Cleanup** — bulk-delete unflagged, never-grouped players not seen in the last N days

#### Online Friends & Recent Tells
Shown at the top of the Players tab:
- **Online Friends** — players flagged as friends seen in chat within the last 30 minutes; displays active character name and designated main if different (e.g. `Bevan (main: Condiar)`)
- **Recent Tells** — last 5 incoming tells, most recent first, with sender, message, and timestamp
- Both sections have **Add Friend** and **Blacklist** quick-action buttons (Blacklist sets Do Not Group + Do Not Help in one click)
- Updates live as new tells arrive; refreshes immediately when you flag someone as a friend

### Audio Triggers
- Regex pattern matching against live log lines
- Text-to-speech alerts (uses system TTS, no audio files needed)
- Use **PQDI Spell Lookup** to auto-fill cast text from spell data
- Per-trigger enable/disable toggle
- Test button to preview TTS

### Feature Toggles
Heavy features can be individually disabled from the Setup tab if they impact performance:
- **Player tracking** — auto-create player records from chat activity
- **Pet window** — unassigned pet tracking (planned)
- **Online inference** — infer online status from recent chat (used by the Online Friends list)

### Live Log
- Scrolling view of all log lines
- Trigger matches highlighted in orange
- Auto-scroll toggle

## Common Vex Thal Triggers to Add

| Trigger Name | Log Pattern              | TTS Text     |
|--------------|--------------------------|--------------|
| Rampage      | `goes on a RAMPAGE`      | Rampage      |
| Enrage       | `has become ENRAGED`     | Enrage       |
| AE Incoming  | `You are pelted by`      | A E incoming |
| Flurry       | `flurries`               | Flurry       |
| You died     | `You have been slain`    | You died     |

## Importing Timers & Config

The repo includes a `timers.json` file with a ready-to-use set of buff timers, debuff
timers, raid event timers, and loot bidding config tuned for Beastlord play in Planes of Power / Luclin content.

**What's included:**

- **20 buff timers** — Beastlord pet buffs (Spirit of Snow/Storm/Flame, Sha's Ferocity,
  Omakin's Alacrity), group regen (Spiritual Radiance/Purity, Chloroplast), stat buffs
  (Spiritual Strength/Brawn, Talisman of Altuna/Tnarg, Furious Strength, Stamina,
  Dexterity), haste (Savagery, Alacrity), and utility (Spirit of Wolf, Spirit Sight)
- **7 debuff timers** — Sha's Lethargy, Drowsy (slows), DoT tracking (Envenomed Breath,
  Venom of the Snake, Sicken), Engulfing Roots, Incapacitate
- **5 raid event timers** — Lord Inquisitor Seru (Torturing Winds, 49s), Emperor
  Ssraeshza rage (60s), Fling/Aten Ha Ra (49s), Ventani the Warder (30s),
  Hraashna the Warder (15s)

**To import:**

1. Open the app and go to the **Setup** tab
2. Click **Import Timers** and select `timers.json` from the repo
3. Existing timers with matching IDs will be skipped; new ones are merged in
4. Loot bidding keywords (BIDS OPEN, CLOSING IN, etc.) are imported alongside timers

> **Note:** Raid timers are global (not per-character). Buff/debuff timers are global
> definitions — which ones are *active* is saved per character profile.

## Importing Boss Mobs

The repo includes a `boss-mobs.json` file. Once populated it contains the full raid boss
roster with HP, level, resist profiles, special abilities, and spells.

**To import:**

1. Open the app and go to the **Setup** tab
2. Click **Import Boss Mobs** and select `boss-mobs.json` from the repo
3. Mobs already in your list (matched by name) are skipped; new ones are added

**To export your own:**

- Click **Export Boss Mobs** on the Setup tab to save your current list to a file

## Importing Item Cache

The repo includes an `item-cache.json` file. Once populated it contains pre-fetched PQDI
item data (stats, icon, effects) so the app doesn't need to re-fetch every item from
pqdi.cc on first use.

**To import:**

1. Open the app and go to the **Setup** tab
2. Click **Import Item Cache** and select `item-cache.json` from the repo
3. Items already in your local cache are skipped; new ones are added

**To export your own:**

- Click **Export Item Cache** on the Setup tab to share your cached item data

## Build AppImage (optional)

```bash
npm run build
# Output: dist/Erek's Everquest Parser-1.5.0.AppImage
```

## Updating

```bash
git pull
npm install
```

> **Note:** After `git pull`, the app will automatically migrate any new schema changes
> on first launch. You do not need to do anything with the database manually.

## License

MIT — see [LICENSE](LICENSE).
