# Erek's Everquest Parser

A native Linux EverQuest log parser with DPS meter, buff timers, and audio triggers.
Built with Electron — no Wine required.

## Prerequisites

### Required

- **Node.js 18+** and **npm**
  ```bash
  # Ubuntu/Debian
  sudo apt install nodejs npm

  # Or use nvm for the latest version:
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  nvm install 18
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
3. Enter your character name (e.g. `Erek`) for DPS highlighting
4. Click **Watch** then **Save Settings**

## Features

### DPS Meter
- Live updates during combat
- Shows all players/NPCs dealing damage
- Damage %, DPS, and total damage per entity
- Auto-resets after 8 seconds of no combat activity

### Buff Timers
- Add buffs manually with name, log trigger pattern, and duration
- Use **PQDI Spell Lookup** to auto-fill cast text and duration from pqdi.cc
- Countdown bars with warning highlight under 30 seconds
- Optional TTS alert when buff expires

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
- **3 raid event timers** — Lord Inquisitor Seru (Torturing Winds, 49s), Emperor
  Ssraeshza tank-hit rage mechanic (60s), Fling (49s)

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
# Output: dist/Erek's Everquest Parser-1.0.0.AppImage
```

## Updating

```bash
git pull
npm install
```

## License

MIT — see [LICENSE](LICENSE).
