# EQ Parser — Feature Backlog

## Architecture (Do This First)

### SQLite Migration
Migrate ALL persistent storage from JSON to SQLite. This includes:
- Player records
- Timer definitions
- Settings / feature toggles
- DPS history
- Group buff data
- Alert configurations

**Player database is global** — not scoped per character. Persists across all alts (Erek, Malzer, etc.).

### Tiered Log Processing
- **Group chat** — process immediately
- **Guild / raid chat** — batch on a short interval

### Per-Feature Toggles
Add settings toggles to disable heavy features individually if they bog down the app:
- Player tracking
- Pet window
- Online inference

---

## Feature 1 — Player / Friend / Guildmate Tracking

### Player Record Schema
| Field | Type | Notes |
|---|---|---|
| id | integer | Primary key |
| friend | boolean | Friend flag |
| do_not_group | boolean | Do not group flag |
| do_not_help | boolean | Do not help flag |
| last_grouped_time | datetime | Last time grouped with |
| last_seen_time | datetime | Last chat activity seen |
| notes | text | Freeform personal notes (e.g. "owes me a fungi", "avoid drama") |
| characters | list | Associated Characters (see below) |

### Character Schema
| Field | Type | Notes |
|---|---|---|
| name | string | Character name |
| class | string | EQ class (Beastlord, Warrior, etc.) |
| is_main | boolean | Designated main character for this player |

### Rules
- One character online per player at a time
- Alt linking is **manual only** via the Edit Player screen
- "Online" is inferred from recent chat activity (no Quarm online/offline events)

### Auto-Create Triggers
Player records are auto-created when a character is seen in:
- ✅ Group chat
- ✅ Guild chat
- ✅ Raid chat
- ✅ Incoming tells

Never auto-create from:
- ❌ Shout
- ❌ OOC
- ❌ Auction
- ❌ Chat channels

### Cleanup Tool
Bulk-delete stale records filtered by: no flags set + never grouped + last seen more than X days ago.

---

## Feature 2 — Dashboard Group Panel

Combined panel showing current group members and alpha loot rotation together.

### Group Member Info Cards
Each card displays:
- Active character name
- Class icon (see below)
- Friend flag indicator
- Do-not-group flag indicator
- Do-not-help flag indicator
- Last grouped time

### Class Icons
All 16 EQ classes are static. Pull icons from a fan site/wiki into `/assets` once. Map by class name:
```
"Beastlord"     → beastlord.png
"Warrior"       → warrior.png
"Paladin"       → paladin.png
"Ranger"        → ranger.png
"Shadow Knight" → shadowknight.png
"Druid"         → druid.png
"Monk"          → monk.png
"Bard"          → bard.png
"Rogue"         → rogue.png
"Shaman"        → shaman.png
"Necromancer"   → necromancer.png
"Wizard"        → wizard.png
"Magician"      → magician.png
"Enchanter"     → enchanter.png
"Cleric"        → cleric.png
"Berserker"     → berserker.png
```

### Group Membership Tracking
- Parse `"X has joined the group"` and `"X has left the group"` log messages
- Maximum 6 members
- Updates panel in real time

### Notes
- Raid members are stored in player records but do **not** appear on the dashboard group panel

---

## Feature 3 — Alpha Loot Tracker
*Addon — implement after player tracking is complete*

### Configuration (in existing Loot Tab)
- Manage alpha loot item list: add, remove, toggle individual items
- Master enable/disable toggle for the whole feature

### Rotation Logic
- When enabled, rotation is set **alphabetically** from current group members at that moment
- Advances when an alpha loot item is detected in the log
- **Skip button** — manually advance current player to the back of the rotation
- If the next-up player **leaves the group**, auto-advance to the next person
- If a player **rejoins**, they are treated as new and re-slot alphabetically

### "Post Next Alpha Loot" Button
- Lives on the dashboard group/loot panel
- Keystroke-injects a message to EQ group chat: who looted last (name + item) and who is next up
- Uses keystroke injection — copy/paste does not work in EQ

---

## Feature 4 — Friends Tab

### Online Friends List
- Shows all friends currently "online" (inferred from recent chat activity in group/guild/channels)
- Displays: active character name + designated main character name
- Example display: `Bevan (main: Condiar)`

### Quick Actions
- **Add as Friend** button on each dashboard group member card
- **Blacklist** shortcut — sets do-not-group + do-not-help flags on the player record in one action

### Recent Tells
- Last 5 **incoming** tells, most recent first
- Quick actions per entry: Add as Friend, Blacklist

---

## Feature 5 — Pet Tracking

### Unassigned Pet Window
- Lives at the **top of the DPS panel**
- Flags unknown DPS sources with no chat activity as possible pets
- Once assigned, drops off the list and DPS rolls up to the owner's total

### Auto-Association Rule
- If there is exactly **1 unknown DPS source** AND exactly **1 pet class player** in the group or raid → auto-associate, no prompt
- Otherwise → surface in the unassigned pet window for manual assignment

### Pet Classes
Magician, Necromancer, Enchanter, Bard, Druid

### Charmed Pets
- Handling is **TBD** — charmed pets are temporary and can be any random mob
- Open question for future design session

### DPS Rollup
- Pet damage rolls up to owner's total
- Display format (merged vs sub-line) TBD

---

## Edit Player Screen — Field Summary
- Friend flag
- Do-not-group flag
- Do-not-help flag
- Freeform notes field
- Character list: add/remove characters, set name + class per character
- Designate which character is the **main**
