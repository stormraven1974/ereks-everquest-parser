# Erek's Everquest Parser

A native Linux EverQuest log parser with DPS meter, buff/debuff timers, boss mob tracker,
loot bidding, loot wishlist, and audio triggers. Built with Electron — no Wine required.

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

## Features

### DPS Meter
- Live updates during combat
- Shows all players/NPCs dealing damage
- Damage %, DPS, and total damage per entity
- Auto-resets after 8 seconds of no combat activity
- **Boss fight tracking** — automatically detects and records fights against named mobs above a damage threshold; persists the last 5 fights across restarts
- **Post to Guild** — sends a compact fight summary to EQ guild chat via xdotool:
  `Boss 184s 1.2M@6700: Player1 75K, Player2 60K, ...` (fits as many players as possible in 255 chars)

### Engaged Mob Card
- Automatically appears when you start hitting a mob
- Shows resist profile (MR/CR/FR/DR/PR), HP, level, special abilities, and spells
- Pulls from your saved boss mob list first; falls back to a live PQDI lookup by name
- Debounced 500ms to avoid flicker when switching targets
- Auto-hides 8 seconds after the mob dies (dismissable manually)

### Boss Mob List
- Maintain a roster of raid bosses with HP, level, zone, resists, and notes
- **PQDI sync** — click the PQDI button on any mob to pull live data from pqdi.cc:
  - Hit points, level, resists (MR/CR/FR/DR/PR) scraped from the HTML page
  - Special abilities (Flurry, Rampage, Summon, Enrage, etc.)
  - Spells the NPC can cast, with links to spell data
- **Special abilities & spells** — each ability and spell shown as a chip; click **+** to add it directly to your timer list, pre-filled with trigger text, duration, and spell-fades message pulled from PQDI
- **Guild output** — the **Guild** button builds a summary line and types it directly into EQ guild chat:
  `Boss Name (12k hp) | MR:190 FR:1000 | Flurries | Ancient Breath, Gift of A'err`
- **Zone editing** — mobs without a zone can have one assigned via a dropdown of all known zones

### Buff & Debuff Timers
- Add buff/debuff definitions with name, log trigger pattern, and duration
- Use **PQDI Spell Lookup** to auto-fill cast text and duration from pqdi.cc
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

### Audio Triggers
- Regex pattern matching against live log lines
- Text-to-speech alerts (uses system TTS, no audio files needed)
- Use **PQDI Spell Lookup** to auto-fill cast text from spell data
- Per-trigger enable/disable toggle
- Test button to preview TTS

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

## Importing Timers

The repo includes a `timers.json` file with a ready-to-use set of buff timers, debuff
timers, and raid event timers tuned for Beastlord play in Planes of Power / Luclin content.

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
2. Click **Import Timers**
3. Navigate to the repo directory and select `timers.json`
4. Existing timers with matching IDs will be skipped; new ones are merged in

> **Note:** Raid timers are global (not per-character). Buff/debuff timers are global
> definitions — which ones are *active* is saved per character profile.

## Build AppImage (optional)

```bash
npm run build
# Output: dist/Erek's Everquest Parser-1.2.0.AppImage
```

## Updating

```bash
git pull
npm install
```

## License

MIT — see [LICENSE](LICENSE).
