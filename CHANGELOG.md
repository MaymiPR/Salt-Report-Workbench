# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Security

- **The access code is hidden as dots** in the setup dialog and the Identity
  tab, so nobody can read it over your shoulder. *Show* reveals it until you
  leave that screen, and *Copy* copies it without showing it. The setup field
  is not a password field, so the browser doesn't offer to save the code.

## [2.15.0] - 2026-10-27

### Added

- **30 more narrative rules (55 in all)**, researched from open sources (US Army
  ATP 7-100.1 and 7-100.3, TRADOC, RUSI, RAND, and Russian practice in Ukraine
  since 2022), each with its Russian and PLA doctrine and its own on/off switch:
  - Maneuver: a fixing attack with the main effort elsewhere, reconnaissance in
    force, delivering an assault group by armored vehicle, infantry building up
    near the line, an assault on motorcycles and light vehicles, assault groups
    in built-up areas, exploiting a breakthrough, envelopment or encirclement,
    pursuit, a counterattack.
  - Defense: a company strongpoint, a fortified line in depth, a security zone
    or screen, remote mining.
  - Fires: persistent drone surveillance, counter-battery fire, shoot and scoot,
    tanks as fire support, thermobaric fires, strikes on command and sensors,
    suppressing air defense, drones cutting supply routes, glide bombs.
  - Support: chemical-defense and smoke troops, logistics pushing forward, a
    railhead, resupply by drone, a helicopter refueling point, casualty
    evacuation, regrouping after an attack.
- **A much larger equipment catalogue**: about 780 Russian and Chinese types
  (from 395), about 1,700 names with variants. It now covers loitering munitions
  and FPV families, radars, EW, chemical-defense, engineer, recovery and
  ambulance vehicles, glide bombs and missiles, and the 2025 PLA parade systems.
  ZBL-09 is now a name for the Type 08 IFV (the same vehicle as ZBL-08; VN-1 is
  its export version).

### Changed

- The doctrine text of 20 existing rules follows current practice. Russian
  assault detachments replace battalion tactical groups. PLA terms appear where
  they apply: "one point, two sides", annihilation zones, the firepower strike.
  Fiber-optic FPVs, glide bombs and hardened headquarters are mentioned.
- Rules read more of what reports say: UAVs count as reconnaissance ahead of
  armor, and loitering munitions as fire after a UAV. 30 or more infantry
  firing is company-sized, and small groups on light vehicles count as
  infiltration.
- Manual, README, architecture and security notes and the shipped README brought
  up to date. The Map has its own section in the manual,
  and the README has new screenshots.

### Fixed

- The basemap notice ("The basemap service didn't answer...") no longer sits
  behind *Latest grids / All reports* when the map's controls wrap to two rows.
  It is now its own line under the controls.
- Types that matched the wrong thing or nothing:
  - KamAZ-63968 (Typhoon) was a truck, and Shaanxi Y-8 / Y-9 aircraft were
    trucks.
  - HQ-series air defense the catalogue didn't list was a command post.
  - GAZ-233014 (Tigr), GAZ-39371 (Vodnik), and variants after a hyphen and a
    digit (Kornet-D 9P163-3, 2B14-1) were not recognized.
- "Fire support", a firing position and a cease-fire are no longer read as
  contact by the narrative, and a withdrawal is no longer read as an advance.
- "Type 84" is no longer in the catalogue: it names five different Chinese
  systems. Its bridge-layer is listed as WZ-621 and GQL-110.

## [2.14.0] - 2026-10-27

### Added

- **Narrative** summary report: the period in sentences, under *Observed*,
  *Assessment* and *Gaps*, kept apart so fact and judgment never mix.
  - *Observed*: report and observer counts, the equipment reported by kind,
    the largest single sighting of each kind with the unit size it suggests
    (approximately: section to battalion), headings, firing, and each busy
    place.
  - *Assessment*: 25 fixed rules drawn from Russian and PLA tactics, in four
    groups: maneuver (offensive, several axes, forward detachment or advance
    guard, reconnaissance ahead of armor, assembly area, second echelon or
    reserve, probing or attacking, withdrawal, infiltration by small groups,
    air assault, amphibious landing), defense (defense, antitank positions,
    camouflage and deception), fires (artillery preparation or fire strike,
    UAVs spotting for artillery, long-range strikes, loitering munitions and
    drones, attack aviation) and support (river or gap crossing, breaching,
    command post, air defense over a key site, EW, logistics point). They
    read the equipment as well as the words (a PMP is bridging, a UR-77
    breaching, an Orlan-10 a UAV). Each judgment is in ICD 203 likelihood
    terms with the reports it rests on, its confidence (high, moderate, low)
    in its own sentence, and what to watch for; rules never go past *very
    likely*. The ten strongest are shown, and how many more there were.
  - **Equipment-aware doctrine**: each judgment uses the doctrine of the army
    whose equipment is in its reports (Russian or Chinese; else the
    period's), with a *Doctrine* line on what that army typically does and
    its own terms where they differ (forward detachment or vanguard, DRG or
    special-operations teams, reconnaissance-fire complex or
    reconnaissance-strike). *Observed* says whose design the equipment is.
  - *Gaps*: reports without a grid, equipment not in the catalogue, and
    places quiet for 6 hours or more.
  - An equipment catalogue of Russian and Chinese systems (395 types, 855
    names with their variants, every kind from tanks to EW) plus plain words
    (tank, truck, PAX), used to name what was reported (in the reports' own
    style: *15x T-72, 31x trucks*), to size it, and to tell whose doctrine
    applies.
  - **Settings**, in a panel beside the report, which updates as you change
    them; tabs with counts, rows you tap to open, chips to pick places and
    kinds, on/off switches for rules.
  - **Call them**: what the narrative calls them (*OPFOR*, say) when no unit fits.
  - **Units**: each with the NAIs and OBJs it operates in and, optionally,
    the kinds of equipment it has; a judgment that fits is said of "elements
    of" the unit, in Assessment only, with a line saying it came from the
    unit list.
  - **Equipment**: types in your reports the catalogue doesn't know come
    first (a dot on the tab says there are some); look up any name; add your
    own or put built-in ones right for your team.
  - **Rules**: switch built-in rules off, and add your own (what it judges,
    the words to look for, how many reports within how many hours).
  - Shared with everyone through the server (`/api/save_narrative`), one set
    for every workspace, and kept in the backup files, the ones you export by
    hand included (importing one whose settings differ from yours asks
    first); editors change them, viewers see them. A server too old to keep
    them says so.
- **Edit text** on any summary report before you copy, save or print it:
  your wording is kept, per workspace and kind of report and through a
  reload (and stops following new reports), until *Revert*.
- **Change a basemap's layers**: *Layers* beside a WMS in *Manage basemaps…*
  opens it again, its layers looked up afresh with the ones in use ticked (a
  layer the service no longer lists stays, marked *not listed*); tick, untick
  or rename, and *Save*. *Edit* beside a tile service changes its address or
  name.

### Changed

- **Removing a basemap** is done from its details (*Remove*, which asks
  "Remove for everyone?" first), not with an × on its row.
- **Check's "It works"** message goes after a few seconds; a failure stays
  until you check again or close the panel.

### Fixed

- **The welcome screen** hid the page behind it only when the Report Log was
  the last view; with the map last, the map showed through.
- **The map's time slider**: its track no longer shortens under the thumb as
  *Now* appears, and it has a pointer, not a "not allowed" cursor, and its
  full color (a style meant for read-only text boxes caught it).

## [2.13.0] - 2026-10-27

### Changed

- **The map is under the Report Log**: the map button by the *Report Log*
  heading slides down to the map, and the same button (a list by then) slides
  back; the heading reads *Map* there. The bar stays above both, and its
  search narrows the map too.
- **One top bar for every view**: the sync dot, who's connected and the
  view's name stay in the same spot; the name changes (Workspaces,
  Statistics, Summary Reports) and each view's one-line summary takes the
  search's place. Views come in with a quick fade and rise. The view
  icons are a 2×2 square of four again, a little larger.
- **A bigger map**, the width of the panel, with its controls on it: the
  layers, *Latest grids* or *All reports*, and the window at the top left;
  the key and the *Up to* slider at its foot. *On the map*, *In an NAI or
  OBJ* and *BDA assessed* sit in a row above it.
- **Map layers together**: Heat map (on to start with), Tracks and Reports
  are each turned on and off by themselves, so the heat map and tracks can be
  seen at once. Kept per browser.
- **Latest grids or All reports** for the heat map and the dots: each report
  at its latest grid, or every saved report (updates too) at its grids. The
  one picked is solid blue.
- **Activity filter**: in a sidebar left of the map, click activities
  (several at once) to show only those reports; *Show all* clears it. The
  busiest places are under them in the same sidebar, down the map's left
  edge in two halves that each scroll. The sidebar button on the map slides
  it away (and back); the map keeps its size, so nothing jumps.
- Tracks are red with a black outline, and so are the report dots.
- Import / Export: the time range's *Clear* looks like the 24h / 12h / 6h /
  1h buttons, and is always there.
- Zoomed all the way out, the map shows more around the graphics, so the
  controls and the key don't cover them.
- Over the map, a plain scroll now scrolls the page on to the table;
  **Ctrl + scroll** (Cmd on a Mac, or a trackpad pinch) zooms, and a hint says
  so. In full screen a plain scroll still zooms.
- **Basemaps** are on the map: a layers button under the zoom buttons opens
  the picker and, for editors, *Manage basemaps…*: one box takes a WMS link
  (its layers are looked up) or a tile address, with an optional name.

### Fixed

- Whether the map was on screen, and *Only what's on the map*, are now
  remembered when the page is reloaded.
- The numbers over the map no longer arrive a moment late and push the map
  down the first time it opens.

## [2.12.0] - 2026-10-27

### Added

- **The Map view**, its own icon beside Workspaces. It has the map; beside it
  the numbers for what's on the map (reports, in an NAI or OBJ, BDA, the
  commonest activities, the busiest places); and under it the table of those
  reports.
- On the map, click a report for its card (*Show in table*, and *Edit* for
  editors); click a row to move the map to its report; click an NAI, OBJ, or
  phase line (or a busiest place) to narrow the table to it.
- *Only what's on the map*: the table follows the part of the map on screen.
- **Reports** mode (each report as a dot), beside Heat map and Tracks; a
  picked track shows the time at each position.
- **Up to**: a slider under the map that moves the window's end back, to see
  how things stood earlier.

### Changed

- The view icons are a row of five: Workspaces, Map, Statistics, Summary,
  Settings.
- The map leaves the Overlays tab, which keeps the list, import and unload
  (editors). Viewers use the Map view, and no longer have an Overlays tab.

## [2.11.0] - 2026-10-27

### Added

- **Export to Excel** in Statistics: one workbook with the headline numbers,
  each chart's table beside an Excel chart drawn from it (editable, and it
  follows the numbers), and the reports in the window as an Excel table.
- **Drop a file to import it**: on the Import / Export tab, drop (or choose) a
  backup, another tool's CSV, or overlay files; what it is gets worked out
  from the file.

### Changed

- The Import / Export tab is one screen, with no Export / Import switch:
  pick and run an export; under that the time range, and beside it the
  format's options with Import (only a drop area) filling the rest of that
  column. The time range gets a 24h preset, and its Clear is a blue text
  button at the top right of the card, shown once a range is set.
- Statistics: *Export All* is now *Charts (.zip)*, beside *Export to Excel*.

### Fixed

- A To time now takes in the whole of its minute: a report logged in the last
  second of it was left out of exports, statistics and summaries.

### Removed

- The busiest grid squares chart and its 10 km / 1 km switch, from
  Statistics. The Most Trafficked summary still lists grid squares.

## [2.10.0] - 2026-10-26

### Added

- **Find a WMS's layers**: paste the link you use in other tools and press
  *Find layers*; tick the layers you want and they are added as one basemap,
  named after the service. The map then asks the service in its own terms
  (its WMS version, image format, and Web Mercator or, when that isn't
  offered, latitude / longitude). When a service won't let the page read its
  layer list, the sync server reads it instead.
- **Check** beside each basemap: asks the service for a little of the map and
  shows what came back, an image or the service's own error.
- **Shapefile (.zip) exports** for the ArcGIS points and tracks: unzip, then
  drag the .shp into ArcGIS Pro or open it from a folder connection (Pro
  doesn't take .json or .geojson that way).
- **Full screen** for the map.
- **Viewers' Map tab**: the map alone, with heat or tracks, the window, full
  screen and the basemap picker.
- **MGRS Lock** (Settings): set the grid zone and 100 km square once
  (`11S NV`); grids typed as digits alone get it when logged.
- **Partial BDA**: log some of an element (3 of `40x T-72`); the rest stays on
  the checklist. Counts are of vehicles and items.

### Changed

- **One report format for every workspace**: switching or starting a
  workspace keeps it; it changes only when an operator edits it. A backup's
  format is taken only while the current one is the stock SALT format.
- Heat map colours: blue, green, yellow, red.
- Map names stay on screen when zoomed in.
- Statistics and Summary dates are laid out like the Workspaces time filter,
  and Clear sits above the To time in all three.
- The report panel keeps one width in every view, so switching views no
  longer moves things around.
- While updating, the title shows the short ID, with the full identifier and
  what the report says below it.

### Fixed

- The NAI / OBJ / PL chip under Location no longer sits on the box's edge, and
  its row keeps its room so the form doesn't move when one appears.
- BDA checklist entries, and the cursor in the box being typed in, are kept
  when a sync redraws the table.
- The Settings menu stays inside its panel on a short window.

## [2.9.0] - 2026-10-26

### Added

- **The map** (Overlays tab, *Map*): the overlays drawn in their colours,
  NAIs green, OBJs blue, phase lines black on a white edge, with:
  - a **heat map** of where reports are thickest, counting each report once
    at its latest grid however often it was updated;
  - a **track map**: each report's path from its first position through its
    updates to its latest, with an arrow for the way it went;
  - a window (All, 24, 12, 6 hours), zoom and pan within the area of the
    overlays and reports, and hover details for each track.
- **Basemaps**: any number of named WMS or tile (WMTS, ArcGIS, XYZ) services
  under the map, requested only for the map's area. Editors add and remove
  them for everyone; a picker on the map switches between them (or none),
  kept per browser, viewers included.
- **ArcGIS tracks** export (Esri JSON or GeoJSON): one line per report that
  moved, first grid to latest, with its direction, length and times, for an
  arrow symbol in ArcGIS Pro.
- **Latest version only** on the CSV export: one row per report, for tools
  that put every row on a map.
- Viewers can open the Overlays tab, to see the list and the map.

### Changed

- The tags under a Location and in the Overlays list use the map's colours:
  NAI green, OBJ blue, PL neutral.

## [2.8.0] - 2026-10-26

### Added

- **Shapefiles** in the Overlays tab: the zip ArcGIS writes, or the `.shp`,
  `.dbf` and `.prj` picked together. Areas keep their holes; names and types
  come from the attribute table. WGS 84 / NAD 83 latitude-longitude, Web
  Mercator, and UTM zones are converted; any other coordinate system is
  refused by name.
- **Logging names the place.** On Log or Update, the NAI or OBJ a grid is in,
  and a phase line within 1 km, are added to the Location
  (`11S NV 3921 0547, NAI 2, PL BLUE`). Chips under the Location box show
  them while you type; click one to add it at once.
- **Settling disagreements.** When a typed NAI, OBJ, or phase line disagrees
  with the grid, Log asks: use the grid's, keep yours, or keep both. The
  orange *Check* tag on an older report settles the same way, saved as an
  Update.
- **Statistics for all ATOs.** *Scope* switches between the workspace on
  screen and every loaded workspace, which adds a *Reports per ATO* chart.

### Changed

- **Overlays are shared by every workspace.** Import them once and every
  ATO, editor, and viewer uses them. The Overlays tab groups them as NAIs,
  Objectives, and Phase lines, each group with its own Unload, so an updated
  set can be unloaded and imported again a group at a time. Overlays saved
  per workspace by earlier versions are pooled into one set.
- **Four icons replace the menu's view items.** Workspaces, Statistics, and
  Summary Reports sit in a 2x2 square with a gear for Settings (what the
  ellipsis menu held), at the top right of the report panel in every view.
  The open view's icon is highlighted; click it again to go back to the
  Report Log.
- **Import / Export** is one picker: Export or Import, what (each with a line
  saying how to use it), and one button. Import also offers Overlays.
- **Horizontal layout reworked**: a compact form across the top, and the
  report panel filling the rest of the window with its table scrolling
  inside.

### Fixed

- In the horizontal layout, half the form stood empty when the format had no
  Analysis, the menu ran off the bottom of the screen, and the page scrolled
  to a table capped at 65% of the window.
- The Settings menu no longer runs past the panel that holds it in a short
  window; it scrolls instead.

## [2.7.2] - 2026-10-26

### Added

- **Export for ArcGIS (.json)**: Esri JSON, the format ArcGIS Pro's *JSON To
  Features* was made for. Every field's type and length is written in the
  file, so Pro has nothing to guess.

### Fixed

- A grid within 1 km of a phase line now shows that line as a tag under the
  Location, and counts toward it in the Overlays list. Before, phase lines
  only showed up in Statistics and Summary Reports.
- An NAI or OBJ drawn as a path (Google Earth's *Add Path*), or as a ring on
  its own, is now an area, so grids inside it are placed in it. Overlays
  already imported that way work without importing them again.
- The Overlays list, and every other Workspaces tab, scrolls when it is
  longer than the window. Before, overlays past the bottom couldn't be reached.
- ArcGIS Pro could fail to load the .geojson export. Text longer than 254
  characters (usually Analysis) is now cut to fit the 255-character text
  fields Pro gives GeoJSON; the .json and .csv exports keep all of it.

## [2.7.1] - 2026-10-26

### Changed

- The one-file `SALT-Workbench-v<version>.txt` is a quarter of its old size
  (about 170 KB instead of 670 KB), for networks where downloads are slow. The
  files inside are compressed with LZMA and written as Base85 text. Unpacking
  still checks every file against its SHA-256 and writes exactly what the zip
  holds. The unpacker at the top can still be read in Notepad, but the files
  themselves no longer can. `scripts/pack.py --plain` writes the old,
  readable form.

## [2.7.0] - 2026-10-26

### Added

- **Summary Reports** (ellipsis menu): written reports from one click, over
  the last 6, 12, or 24 hours, 7 days, all reports, or your own window:
  - **Rollup**: totals against the period before; each NAI, OBJ, and phase
    line with its count and activity; activity; what was reported by type;
    notable reports (firing or emplacing); BDA; and anything to check.
  - **Most Trafficked**: the busiest places, phase lines, and 1 km grid
    squares, with peak hours and main activity. This is the written heat map.
  - **Place Activity**: every report at one NAI, OBJ, or phase line, in time
    order.
  - **Shift Brief**: the short handover.

  Copy the text, save it as .txt, or print it with its charts. It is built
  from fixed templates and counting rules, not AI: the same reports always
  give the same words, and nothing is made up. Viewers can use it too.

### Changed

- Each release carries one checksum file, `SHA256SUMS.txt` (as ChanSampler does),
  for both the zip and the one-file `.txt`, in place of one per download.
  `python scripts/release.py <version>` builds all three in one go. The README
  has a PowerShell line that checks them.

## [2.6.0] - 2026-10-26

### Added

- **Statistics** (ellipsis menu): headline numbers and charts for the workspace
  on screen, for all reports or a time window. They follow the log live, and
  viewers get them too. The charts:
  - reports per NAI, per OBJ, and at each phase line (typed, or a grid within
    1 km of it)
  - the busiest 10 km or 1 km grid squares
  - reports by hour of day and by day
  - activity tags, and the heading of moving reports
  - what was reported by type, counted from Size
  - BDA outcomes

  Each chart has a hover readout and a table view. It exports as PNG, SVG, or
  CSV on a light background, with its title, workspace, and window written in.
  **Export All** zips every chart with one CSV of all the numbers.

### Changed

- How to download, verify, and upgrade now lives in the README's *Download*
  section, and release pages carry only the changelog.

## [2.5.0] - 2026-10-26

### Added

- **Overlays.** A new Overlays tab imports NAIs, OBJs, and phase lines from
  KML, KMZ, or GeoJSON as ArcGIS exports them. Each shape's type comes from
  its name, folder, or file name. A review step lets you set or change any
  of them before they are added. Overlays belong to a workspace, sync to
  everyone, and are saved in its backup file.
- **The Location box is read as typed** (`38S MB 12345 67890, NAI 1`): the
  grids, and the NAI, OBJ, and PL names, in any spacing or case. When no NAI
  or OBJ is typed and a grid falls inside one, the report is placed there,
  shown by a tag under the Location. When a typed one disagrees with the grid,
  the typed name still counts and a *Check* tag says what differs.
- **Activity tags**: Moving, Stationary, Dismounted, Emplacing, Firing,
  Observing, Resupplying, from the words in Activity, plus the heading when
  one is given (`moving N`, `heading 270`, `NB`, `westbound`).
- **Export for ArcGIS**, as GeoJSON (JSON To Features) or CSV (XY Table To
  Point). Each MGRS grid becomes one point, at the centre of its square, and
  carries:
  - the report's fields
  - its activity tags and heading
  - its NAI and OBJ, each marked typed or by grid
  - the nearest phase line and its distance
  - any check, the BDA, and custom fields

  The manual has the steps for a heat map in ArcGIS Pro.
- `scripts/pack.py` packs a release zip into one self-unpacking, plain-text
  file, `SALT-Workbench-v<version>.txt`, for transfer systems that refuse zips
  and scripts. Run it with Python and it unpacks into a `SALT Report
  Workbench` folder, checks every file, and deletes itself. It starts
  nothing. If anything fails, it deletes nothing. An upgrade keeps `Auto
  Backups` and the launcher's `PYTHON_EXE` path. The v2.4.1 release carries one.

### Fixed

- Typing a report no longer loses the cursor when a teammate's change
  arrives. Every sync re-laid the form out, which took the cursor out of the
  box being typed in, so the rest of the word went nowhere. The form is now
  only re-laid when the workspace's format changes, and the cursor stays put
  even then.

## [2.4.1] - 2026-10-25

### Fixed

- The connected-operators count no longer counts the host twice. The launcher
  opens the LAN address, so a host that also had a `localhost` tab open showed
  up as two operators. Every address of the host now counts as one machine.

## [2.4.0] - 2026-10-24

### Fixed

- Updating or editing a report without touching its Time box keeps the
  report's original timestamp. The box carries only the clock part, so the
  report used to be re-dated to today, and that counted as a change worth a
  history entry even when nothing else differed.
- A just-logged report no longer blinks out of the table when another
  operator's change arrives while it is still being sent.
- The server re-checks its own addresses every minute, so the host's browser
  keeps its free pass on the LAN URL after a DHCP change instead of being
  asked for the code until a restart.
- Starting the next report while the previous one is still uploading no
  longer wipes the fields: the form is cleared (and the report copied) as
  soon as it is logged, not after the server confirms.
- The first-run dialog scrolls when it is taller than the screen. With Quick
  Start chips filled in, "Get Started" could sit below the edge of a small
  laptop screen with no way to reach it.

### Changed

- Each workspace is saved to its own backup file, `{ATO}_{Title}.txt`, and
  only the workspace that changed is rewritten. One file used to hold every
  loaded workspace, named after the active one, so files duplicated each
  other and a stale copy of a workspace could win on reload. Files from
  earlier versions still load, and the first save after upgrading gives each
  workspace its own file. Unloading a workspace leaves its file in place, as
  before.
- For contributors: the page's code is split from one 2,700-line `app.js`
  into seven ordered scripts under `src/app/` (state, rendering, form,
  import/export, sync, handlers, startup). Same code, same scope; the build
  inlines them in order.
- For contributors: browser tests. `tests/test_browser.py` drives the built
  page in Chromium through Playwright (optional; skipped when it isn't
  installed) and CI runs it: first-run setup, logging, live update on the
  viewer, delete and undo, sorting, the BDA roll-up.

## [2.3.0] - 2026-10-24

### Fixed

- A browser whose storage is full keeps working. Every browser mirrors every
  workspace, with history, into the ~5 MB a browser allows, and when that
  ran out the client went silently offline. It now says so once and carries
  on from memory.
- Starting the server a second time on Windows failed to fail: both copies
  printed the banner and split the traffic between them. The second start now
  stops with "port already in use".
- Report ids are escaped wherever they land in the page, and the server
  accepts only the characters the app generates, so a tampered backup file
  can't carry markup into everyone's browser.
- The client reacts to the server's own shutdown notice, instead of waiting
  for the next failed heartbeat.
- A typed time more than an hour ahead of now is dated yesterday. In Zulu mode
  the day rolls over during a US evening, so `23:50` typed at `00:30Z` used to
  land twenty-three hours in the future.
- CSV import reads a Time column written as ISO 8601, `YYYY-MM-DD HH:MM`,
  `HH:MM`/`HHMM` (today), or a DTG such as `241430Z`. Any other value gets the
  import time and the result says how many. Before, a column in any form but
  ISO 8601 made the server refuse every imported row.
- A workspace whose ATO has a dash (`ALPHA-01`) numbers its reports with one
  prefix. Reports from the form dropped the dash (`ALPHA01001`); CSV imports
  and "Send to ATO" kept it, so the same workspace had two numbering schemes.

### Added

- **Undo** for Delete and Restore: a button on the message, for ten seconds.
- **Sort by Size, Activity, or Location** by clicking the header, with numbers
  in numeric order ("2x T-72" before "10x T-72").
- **BDA roll-up** above the table: elements assessed out of every element in
  the workspace, a count per outcome, and Unassessed; click a chip to show
  only those reports. Viewers see it too.
- An audit log, `Auto Backups/audit.log`: one line per accepted change with
  the time, the operator (initials and address), and what changed, plus
  server starts and stops.
- Dated backup snapshots in `Auto Backups/snapshots/`: one at every start,
  then at most one an hour, the newest 48 kept. The live backup is replaced
  within half a second of every change, so this is the way back from a bad
  import or a wrong delete.

### Changed

- Sync downloads are compressed. Every browser downloads the whole state after
  every change, and a month of reports is megabytes of JSON; it now travels
  five to eight times smaller, and one compression serves every client.
- Viewers (the read-only port) no longer keep a copy of the reports in browser
  storage, and clear any copy an earlier version left. The page comes from the
  server, so the copy was of no use without it.

## [2.2.0] - 2026-10-24

### Fixed

- Confirming a prompt no longer also runs an earlier prompt that was left
  unanswered. One click on Confirm could unload, delete, or restore something
  the dialog wasn't showing.
- Importing a backup that holds several workspaces (such as an "Export All
  ATOs" file) restores all of them. Only the active one used to reach the
  server, and the sync that followed erased the rest.
- A report the server refuses (a field over its length limit, an upload over
  the size cap) is reported with the server's reason. It used to show
  "logged & copied" and "Online & Synced", then vanish on the next sync.
  Changes that can't reach the server stay queued, and a sync no longer
  pulls over them. Form fields now carry the server's length limits.
- Importing someone else's reports no longer makes the server attribute your
  later edits to them.
- Restoring an earlier version restores its custom field values too.
- Updating a report that another operator deleted now says so, instead of
  silently copying an empty report over the clipboard.
- Esc on a new report clears custom fields along with the rest.
- A corrupt value in browser storage no longer stops the app from starting.
- Server: an oversized or refused upload gets its error reply instead of a
  connection reset, a negative `Content-Length` is refused at once, and a
  cookie with non-ASCII characters is denied instead of getting no response.
- Server: `HEAD` requests no longer report the size and date of files beside
  the server.
- Server: `--access-code` refuses a blank value, which used to open the editor
  port to anyone, and characters a browser cookie can't carry.
- The access-code box accepts codes longer than 10 characters, so a custom
  `--access-code` can be typed in.
- "Send to ATO" from the IMPORT workspace never pushed the destination
  workspace, so the moved reports were lost on the next sync.
- The MTI export finds counts written "4x tracked" (and "4 x tracked"), not
  only "4 tracked".

### Changed

- Each change uploads only the reports it touched instead of the whole
  workspace, so syncing no longer grows with the length of the operation.
- A report the server refuses is no longer lost. It stays in the table marked
  *Not saved*, with the server's reason, until it is fixed (then it is sent
  again) or discarded (the server's copy comes back). When several reports are
  sent together, the rest still land.
- The CSV and MTI Identifier column matches the table and copy text
  ("Patrol - ALPHA001", following the Title Separator) instead of the stored
  form without a separator ("PatrolALPHA001").
- The upload cap is 16 MB instead of 1 MB, so the full push a browser makes
  after a reload fits even a long operation.
- The ⋯ menu's "Clear All Data" is now "Clear Workspace", which is what it
  does. It shares Unload's behavior, so it also clears the title and form.
- The server reports unexpected errors on its console instead of swallowing
  them, and lines up its startup banner.

### Removed

- `archive/`, two old snapshots that nothing used. They remain in git history.

## [2.1.1] - 2026-10-24

### Changed

- Licensed under the GNU AGPL v3 only (`AGPL-3.0-only`), matching the author's
  other projects. The LICENSE file now matches the official FSF text exactly.

## [2.1.0] - 2026-10-24

### Added

- `Start SALT Workbench.bat`, a double-click launcher for Windows that needs no
  install or admin rights. It can be pointed at a specific `python.exe` by
  editing one line or setting `SALT_PYTHON`, and otherwise finds Python by
  itself, including a portable copy in a `python\` folder beside it. The build
  copies it into `dist/`.

### Removed

- The ™ marks after the product name and the © line in the server banner and
  the manual footer. They began as a joke; the name isn't a registered
  trademark. The license's copyright notices are unchanged.

## [2.0.0] - 2026-10-24

First tagged release. SALT logging with real-time LAN sync over Server-Sent
Events, offline mode, edit history with restore, workspaces, a read-only viewer
port, a per-launch access code, the report builder (SALT and SALT-U presets,
custom fields with their own table columns), BDA tracking with a pre-paired
checklist, and backup, CSV, and MTI exports. Licensed under the
GNU AGPL v3.

Changes below are relative to the untracked build this release grew out of.

### Fixed

- Backup writes no longer block requests. The whole save used to run while
  holding the data lock, so every sync and POST stalled for the duration of the
  disk write.
- Workspace unloads are written to disk immediately instead of whenever an
  unrelated later change triggered a save.
- The `Auto Backups/` folder is created beside the server, as documented, rather
  than in whatever directory the server was launched from.
- The access-code alphabet no longer includes `5`, which the docs already said
  was excluded to avoid confusion with `S`.
- The boot banner, including the access code, appears immediately when the
  server's output is redirected to a log file or a service wrapper. It used
  to sit in Python's output buffer.
- Server-stamped edit attribution no longer misses when initials arrive with
  surrounding whitespace.

### Changed

- The config and profile endpoints keep only the fields the app uses, instead
  of storing and re-broadcasting whatever the client sent.
- The repository now has a conventional layout: `src/`, `server/`, `scripts/`,
  `tests/`, `docs/`, `assets/`. The build produces a self-contained `dist/`
  folder with the page and the server.
- The server file is renamed `salt_sync_server.py`, and the page is served at
  `/` and `/index.html`. The old `/Salt%20Report%20Workbench.html` path still
  works.
- The build now fails, rather than shipping a broken page, when the stylesheet
  link or script tag it inlines is missing.

### Added

- Brand identity: logo, monochrome variants, avatar, README banners, social
  preview, and an inline favicon.
- A 54-test suite covering merge rules, backup round trips, validation, rate
  limiting, access control, and live HTTP behavior.
- CI: lint, tests on Python 3.10–3.13 and on Windows, and a build smoke test.
- Ruff, pre-commit, EditorConfig, and a Makefile.
- README, architecture notes, and contributing, security, and conduct guides.

[Unreleased]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.15.0...HEAD
[2.15.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.14.0...v2.15.0
[2.14.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.13.0...v2.14.0
[2.13.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.12.0...v2.13.0
[2.12.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.11.0...v2.12.0
[2.11.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.10.0...v2.11.0
[2.10.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.9.0...v2.10.0
[2.9.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.8.0...v2.9.0
[2.8.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.7.2...v2.8.0
[2.7.2]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.7.1...v2.7.2
[2.7.1]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.7.0...v2.7.1
[2.7.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.6.0...v2.7.0
[2.6.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.5.0...v2.6.0
[2.5.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.4.1...v2.5.0
[2.4.1]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.4.0...v2.4.1
[2.4.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.3.0...v2.4.0
[2.3.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.1.1...v2.2.0
[2.1.1]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.1.0...v2.1.1
[2.1.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/MaymiPR/SaltReportWorkbench/releases/tag/v2.0.0
