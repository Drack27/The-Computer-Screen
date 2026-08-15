# Masks GM

A Keeper's atlas for **Masks of Nyarlathotep** — Call of Cthulhu, 1925.

Forked from the Roselake GM app and generalized: everything campaign-specific
lives in `campaign.json` in the vault folder, so the same binary can drive a
different campaign by pointing it at a different folder.

---

## Running it

```bash
cd gm-app
npm install --omit=dev      # marked, dompurify, chokidar only
npm install -g electron@28  # once, avoids the 100 MB dev-dependency download
npm start
```

On first launch it asks for your campaign folder — pick the one containing
`campaign.json`. It remembers the choice; change it later via
**Campaign → Change Campaign Folder…**

Build a portable Windows `.exe` with `npm install && npm run dist`.

---

## The idea

Roselake's app was list-first: pick a note, read it. Masks is too big for that
— five continents, 669 pages, 85 named NPCs. So this one is **time-and-place
first**:

- **Left rail is a clock.** Drag it and the campaign date changes.
- **Centre is a map**, and you drill down through it: world → continent →
  city → building → room, each step a hotspot.
- **Right rail** switches between the place tree, the people alive on the
  current date, and your own notes.
- **Detail slides out from the right**, so the map never leaves the screen.

### Blips

The thing that makes the clock matter. Every NPC has a location and a date
range. When you're looking at a map, the app asks of each person: *is your
location somewhere inside this map?* If yes, it walks up the location tree
until it finds the direct child of the current map and draws the dot there.

So a cultist standing in Ju-Ju House is a dot on the Ju-Ju House floorplan, a
dot on Harlem, a dot on New York, and part of a cluster on the world map — all
from one piece of data. Scrub the clock and the dots move.

---

## Files

```
gm-app/
  main.js            Electron main — vault resolution, IPC, gmapp:// protocol, watcher
  preload.js         Context bridge
  renderer/
    index.html       Three-column shell: clock | stage | rail
    style.css        Dark theme
    app.js           Clock, atlas, blip resolution, rails, panel
  harness.js         jsdom test harness — `node harness.js`, 22 checks

../campaign.json     Chapters, the location tree, clock settings
../Data/*.json       Generated: npcs, timeline, maps
../Tools/*.py        The generators (see below)
```

State lives outside the vault, so replacing the `.exe` never loses progress:

- Windows: `%APPDATA%\Masks GM\state\`
- macOS: `~/Library/Application Support/Masks GM/state/`

`hotspots.json` holds the boxes you draw, `world.json` holds NPC movements and
events, `app-state.json` holds location coordinates and your notes.

---

## Regenerating the data

All three scripts are idempotent — rerun any of them after editing the PDF or
adding maps.

```bash
python3 Tools/extract_masks.py    # PDF  → Extracted/ (full text + 159 sections)
python3 Tools/harvest_maps.py     # PDF  → maps rendered at 200 DPI
python3 Tools/build_data.py       # text → Data/npcs.json, timeline.json, maps.json
```

`extract_masks.py` is column-aware: it reconstructs two-column reading order
from block coordinates rather than trusting `pdftotext`, detects headings by
font size, and strips the decorative "SERPENT OF YIG" spine and folio numbers
that would otherwise litter every page.

---

## Placing locations

Most locations in `campaign.json` start with `"pos": null` — the app can't know
where Harlem sits on the New York map. Any map with unplaced children shows
them in a tray in the top-right corner, so nothing is ever a dead end.

To place one: open the parent map, click **Place N unplaced**, drag a box over
the spot, and pick which location it is. That writes both a clickable hotspot
and the coordinate the blip system uses.

---

## Testing

```bash
node harness.js
```

Runs the real renderer against the real campaign data in jsdom — clock maths,
navigation, blip resolution, panel behaviour, and layer refresh. It runs
headless, so it's the fastest way to check a change didn't break navigation.

---

## A note on content

The campaign text is Chaosium's. `Extracted/`, `Data/`, and the harvested maps
are derived from your own PDF for your own table. Keep them out of any public
repo — the app is the part that's shareable, and it ships empty.
