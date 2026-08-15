# The Computer Screen

A screen for running any tabletop campaign: a clock, a map you drill down
through, and everyone who is standing on it today.

Point it at a campaign folder — or let it make you one — and it gives you a
time-and-place view of your game. Drag the clock and the world moves: NPCs
appear where they are on that date, events surface as they approach, deadlines
count down. It works for Call of Cthulhu in 1925 and for a homebrew world on a
calendar you invented, because the calendar is data, not code.

---

## Running it

```bash
npm install
npm start
```

First launch doesn't ask you anything. It creates a campaign in your Documents
folder and opens it, so you land on something you can immediately start typing
into. Open a different one whenever you like with **Campaign → Open Campaign
Folder**, or start a fresh one with **⌘N / Ctrl+N**.

---

## The idea

Most GM tools are list-first: pick a note, read it. This one is
**time-and-place first**.

- **The left rail is a clock.** Drag it and the campaign date changes.
- **The centre is a map**, and you drill down through it: world → region →
  city → building → room, each step a hotspot you draw yourself.
- **The right rail** switches between the place tree, the people alive on the
  current date, the timeline, and your notes.
- **Detail slides out from the right**, so the map never leaves the screen.

### Blips — why the clock matters

Every entity has a location and a date range. When you're looking at a map, the
app asks of each of them: *is your location somewhere inside this map?* If yes,
it walks up the location tree until it finds the direct child of the current map
and draws the dot there.

So a cultist standing in a cellar is a dot on the cellar's floorplan, a dot on
the building, a dot on the city, and part of a cluster on the world map — all
from one piece of data. Scrub the clock and the dots move.

---

## Calendars

Everything internally counts in **day numbers** — plain integers — and the
calendar is the only thing that knows what a day number means. So the clock, the
blips and the timeline work unchanged on any calendar.

Built in: **Gregorian**, the **Calendar of Harptos** (Forgotten Realms, with
festival days and Shieldmeet), **Absalom Reckoning** (Pathfinder), the
**Galifar Calendar** (Eberron), and a plain 12 × 30 starting point for homebrew.

Or define your own in `campaign.json`:

```json
"calendar": {
  "kind": "custom",
  "name": "The Reckoning of Ash",
  "months": [
    { "name": "Emberfall", "days": 40 },
    { "name": "The Long Dark", "days": 3, "intercalary": true },
    { "name": "Thawmonth", "days": 40 }
  ],
  "weekdays": ["Ashday", "Emberday", "Coalday", "Smokeday"],
  "leap": { "every": 7, "month": 1, "extraDays": 1 },
  "era": "AR"
}
```

Dates are written `"Y-M-D"` with 1-based months and days, counting **every**
month in the list — festivals included. Gregorian dates are implemented with
days-from-civil arithmetic rather than the `Date` object, so historical
campaigns are exact and no timezone can shift a session by a day.

---

## The campaign folder

Your campaign is plain files you own, editable here or in any text editor. Edit
them in Obsidian while the app is open and it reloads.

```
My Campaign/
  campaign.json     calendar, groups, sources, the location tree
  entities.json     NPCs, factions, creatures, items
  timeline.json     dated events
  Maps/             image files
  Notes/            markdown, in whatever folders you like
```

**Play state lives outside the vault**, in your OS's app-data folder, so
replacing the executable never loses your progress and handing the campaign
folder to another GM doesn't hand over where your party got to. It's namespaced
per campaign, so opening a second one doesn't inherit the first one's positions.

A vault from the earlier Masks-only version still opens: `chapters`, a single
`pdf`, `doomsday`, and `Data/npcs.json` are all migrated in memory, and nothing
on disk is rewritten until you make an edit.

---

## The assistant

**View → Assistant**, or **⌘J / Ctrl+J**.

It answers from *your* campaign, not from the model's memory. Every question
carries two things into the prompt: the passages retrieved from your notes, and
a live brief of what is true right now — the date on your calendar, the place
you're looking at, and who is standing there.

- **Search needs nothing.** Retrieval is BM25 across your notes, NPCs,
  locations and events. No key, no download, no network — it works offline the
  moment you open the app.
- **Answers cite their sources.** Click a citation and the actual note, NPC or
  event opens in the app, so you can check it rather than trust it.
- **It says when it doesn't know**, rather than inventing a fact you'll have to
  un-say at the table. Ask it to invent something and it will, and it'll tell
  you that's what it's doing.

### Where the model runs

| | |
|---|---|
| **Cloud** | Anthropic, OpenAI, Google, or any OpenAI-compatible server (LM Studio, vLLM, OpenRouter). Paste a key; it's stored in your OS keychain via Electron's `safeStorage`, never in the campaign folder. |
| **On this computer** | Nothing to install — the inference engine ships with the app. Pick a model and it tells you **exactly how many gigabytes** it's about to download, where it will go, and how much room you have, before fetching a byte. Once it's down, nothing you ask leaves the machine. |

Already have a `.gguf`? Point the app at it instead of downloading anything.

---

## Building the single executable

```bash
npm run dist:win     # → dist/TheComputerScreen-0.2.0.exe    (one file, no installer)
npm run dist:mac     # → dist/TheComputerScreen-0.2.0-arm64.dmg and -x64.dmg
npm run dist:linux   # → dist/TheComputerScreen-0.2.0.AppImage
```

Each has to be built **on** the platform it targets, because the local
inference engine is a native module and can't be cross-compiled.
`.github/workflows/build.yml` does all three on a CI matrix and attaches them to
a draft release when you push a `v*` tag — that's the easy path.

The app icon is generated by `npm run icons`, which draws `build/icon.png` in
code so it stays diffable; electron-builder converts it to `.ico` and `.icns`.

### About the warnings your users will see

These builds are **unsigned**, and that is visible to whoever you hand them to:

- **Windows** shows *"Windows protected your PC"* on first run. They click
  **More info → Run anyway**. To remove it you need an OV or EV code-signing
  certificate (~$100–400/year); EV clears SmartScreen immediately, OV builds
  reputation over time.
- **macOS refuses a normal double-click** on an unsigned, un-notarised app.
  They right-click → **Open** → **Open**. To remove it you need an Apple
  Developer account ($99/year) and notarisation.
- **Linux AppImages** need no signature. `chmod +x` and run.

Signing is a distribution decision, not a code change — the build config has
hooks for it when you're ready.

---

## Testing

```bash
npm test
```

89 checks. The calendar and schema suites run in Node; the renderer suites run
the **real** renderer in a real Chromium against fixture campaigns, so the map
drag maths is exercised against actual laid-out pixels rather than a stub that
returns zeros. The page is assembled from `src/renderer/index.html` itself, so
what's tested can't drift from what ships.

---

## Layout

```
src/
  main/          Electron main — vault, IPC, watcher, menu
    llm/         providers, local models, keys, the assistant
    rag/         chunking, the search index, the campaign brief
  preload/       the only bridge to Node
  renderer/      clock · atlas · rails · panel · editors · assistant
shared/          calendar engine and campaign schema (used by both sides)
test/            fixtures and suites
```

---

## Not done yet

**Importing from a PDF or an existing notes folder.** The plan is pdf.js for
text and page-to-map rendering, plus assisted extraction of NPCs and places into
records you then correct. Until then, campaigns are built in the app or by
editing the JSON.

---

## Licence

MIT for the app. Whatever you put in your campaign folder is yours — and if it
came out of a published book, keep it out of a public repository.
