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
