# Architecture

S.A.L.T. Report Workbench is two programs that share a JSON shape: a browser
client that owns the user experience and works on its own, and a small Python
server that makes several clients agree. This document explains how they fit
together and why the design looks the way it does.

## Design constraints

Three constraints drive almost every decision:

1. **No dependencies.** The tool has to run on air-gapped and locked-down
   machines where `pip install` is not an option. The server uses only the
   Python standard library, and the client is plain HTML, CSS, and JavaScript
   with no framework and nothing fetched at runtime.
2. **Offline-first.** A client must remain fully usable when the server is
   unreachable, and reconcile cleanly when it comes back.
3. **One folder to ship.** An operator should be able to copy a folder to a
   laptop and run it.

## Repository layout

```text
.
├── src/                      Frontend sources (edited by hand)
│   ├── index.html            Markup and the built-in user manual
│   ├── styles.css
│   ├── core/                 Pure logic (formatting, parsing, exports) in parts; unit-tested
│   │   ├── 00-head.js        Opens the function the parts share
│   │   ├── 10-dates.js       Dates, times, text safety
│   │   ├── 20-reports.js     Reports, BDA, backups, CSV
│   │   ├── 30-geography.js   MGRS, overlays, what a Location box says
│   │   ├── 40-map.js         Shapefiles read, tracks, heat, activity tags
│   │   ├── 45-measure.js     Units, lengths, areas, range rings, rate of march
│   │   ├── 50-arcgis.js      The ArcGIS and shapefile exports
│   │   ├── 60-statistics.js  Statistics, the Excel workbook, summary reports
│   │   ├── 70-catalogue.js   The equipment catalogue
│   │   ├── 75-doctrine.js    Echelons, likelihood terms, the built-in rules, doctrine
│   │   ├── 80-narrative.js   The narrative
│   │   ├── 85-sync.js        Sync bookkeeping
│   │   └── 90-exports.js     The SaltCore object; closes the function
│   └── app/                  DOM, state, and sync: ordered scripts sharing one scope
│       ├── 10-state.js       Elements, state, helpers, toasts
│       ├── 20-render.js      The report table, BDA panel and roll-up
│       ├── 30-form.js        Entry, editing, restore, undo
│       ├── 40-io.js          Manage panel, builder, export, import
│       ├── 50-overlays.js    Overlay import (KML, KMZ, GeoJSON, SHP), the Map tab's graphics, ArcGIS export
│       ├── 60-map.js         The map: its state, colors and shared helpers
│       ├── 61-map-draw.js    Drawing it: overlays, heat map, tracks, report dots, legend
│       ├── 62-map-basemaps.js  Basemaps: drawing them, finding, adding, checking services
│       ├── 63-map-drones.js  Drones: where, their view and range, their menu, saving; FMV mode
│       ├── 64-map-controls.js  Full screen, the panel above, menus, grab a grid, go to one, pointer
│       ├── 65-map-export.js  Saving and printing the map: PNG or print, with its key, title, north arrow, scale bar
│       ├── 70-stats.js       Statistics panel: charts, hover, tables, PNG / SVG / Excel export
│       ├── 80-summary.js     Summary Reports panel: written reports, copy, .txt, print, edit
│       ├── 81-narrative.js   The narrative's settings: enemy name, way of march, units, equipment, rules
│       ├── 85-mapview.js     The map under the Report Log: what's on it, its table, the report card
│       ├── 90-sync.js        Push, pull, SSE, offline queue
│       ├── 92-mission.js     Done with Mission, Previous Missions (Recall Settings, Load), Refresh
│       ├── 95-handlers.js    Event wiring
│       └── 99-startup.js     Restore saved state, then connect
├── server/
│   ├── salt_sync_server.py   Standard-library HTTP + SSE sync server
│   └── Start SALT Workbench.bat  Windows double-click launcher
├── scripts/
│   ├── build.py              Bundles src/ into dist/index.html, copies the server and launcher
│   ├── bump.py               Sets the version everywhere it is written down, for a release
│   ├── pack.py               Packs a release zip into one self-unpacking text file
│   └── release.py            Builds a release: the zip, the one-file .txt, and SHA256SUMS.txt
├── tests/                    Python tests (server, HTTP API, build, bump, pack, release, launcher, docs, styles,
│                             browser); js/ for the core
├── assets/                   Logo, icon, banners, social preview (see BRAND.md)
├── docs/                     Architecture (this file), INSTALL.md, OPERATIONS.md, and screenshots
└── dist/                     Build output (git-ignored)
```

## Components

```text
        src/index.html + styles.css + core/*.js + app/*.js
                          │  scripts/build.py (inline CSS + JS)
                          ▼
   dist/index.html ◄──── served by ────► dist/salt_sync_server.py
   (single file)                          │
        ▲  ▲                              ├─ editor port  :8080  (HTTPS, read/write, access code)
        │  │  GET /api/sync, SSE          ├─ viewer port  :8081  (HTTPS, read-only, no code)
        │  └──── POST /api/* ─────────────┤
        │                                 └─ Auto Backups/{ATO}_{Title}.txt
   localStorage (offline cache + queue)
```

### Client (`src/`)

The core (`src/core/`) holds the pure logic: date and time formatting, identifiers, copy
text, MGRS clean-up, BDA pairing and the Size it leaves (`sizeAfterBda`:
a report's stored Size stays as logged, and what the page shows, counts and
exports is that Size less what is assessed Destroyed, worked out each time,
so removing an assessment needs nothing undone), backup and CSV generation,
parsing, and the geography (MGRS to latitude/longitude, reading grids and NAI/OBJ/PL names out of
a Location box, placing them in overlay areas, activity tags, the ArcGIS
and track exports, shapefiles written and read), the counts behind the
Statistics panel (`statsData`), the Excel workbook (`statsXlsx`: the
.xlsx parts written by hand, charts included, zipped by `zipStore` like the
other zip exports), and the written summaries (`summaryReport`:
fixed templates over those counts, plus the Narrative below). It
touches no DOM, storage, or network, so it loads in the page as
`window.SaltCore` and in Node for `tests/js/`. It is one function split
into parts by subject, joined in name order (with a newline between parts)
by the build and by `tests/js/load-core.js`, so the parts share one scope:
`00-head.js` (opens the function), `10-dates.js` (dates, times, text safety),
`20-reports.js` (reports, BDA, backups, CSV), `30-geography.js` (MGRS,
overlays, Location boxes), `40-map.js` (shapefiles read, tracks, heat,
activity), `45-measure.js` (units, lengths, areas, range rings, what a
report moves as and its rate of march), `50-arcgis.js` (the ArcGIS and shapefile exports),
`60-statistics.js` (statistics, the Excel workbook, summary reports),
`70-catalogue.js` (the equipment catalogue), `75-doctrine.js` (echelons,
likelihood terms, the built-in rules, doctrine), `80-narrative.js` (the
narrative), `85-sync.js` (sync bookkeeping) and `90-exports.js` (the
`SaltCore` object; closes the function). The rest of the page is
`src/app/`, nineteen top-level scripts loaded in order (state, rendering,
form, import/export, overlays, the map in six parts, statistics, summary
reports, the narrative's settings, the map view, sync, missions, handlers,
startup) that
share one global scope, so a name declared in an earlier file is visible in the
later ones. Their numbers rise in the order the page loads them, and
`tests/test_build.py` checks that, that each is loaded once, and that no
top-level name is declared in two of them. Together they hold the whole
application state in a handful of top-level variables, with `reportsByAto` (every workspace's reports) as the core. Every
change is applied in memory first, so the UI never waits on the network, and
written to an offline copy in `localStorage`. That copy holds the workspace the
editor is in, the one the page opens in next, and every one with a change the
server hasn't taken (waiting, refused, or made since the last pull); the others
the server has, and the next pull brings them back (`reportsToCache`, with
`SaltCore.workspacesToCache`). A copy of every workspace, with weeks of
history, outgrew what a browser keeps for a site. A page opened as a file has
no server, so it keeps them all. Rendering is one function per surface, such
as `renderLog` and `renderWorkspacesList`, that rebuilds its DOM from state into a
`DocumentFragment` for a single reflow.

Pushes are deltas. After every pull the client records the version
(`lastModified`) of each report the server holds, and a push sends only the
reports that are new or changed since; with no record yet, such as right after
a reload, it sends the whole workspace. The server needs nothing special for
this: merging a partial batch is what it always did.

When a push can't land (the server is unreachable, rate-limits it, or
errors), the client sets `salt_offline_push`, and the next sync pushes again
*before* pulling, so the pull can't overwrite changes the server hasn't seen.
Changes still waiting are sent again every 5 seconds, so they go as soon as
the server is back, with no notice needed to start a sync. Every request has
a time limit (`serverFetch`: 20 seconds, longer for `/api/sync`, large saves,
services asked through the server, and missions; the event stream has none),
and one that runs out is treated as an unreachable server, so a request stuck
on a dropped connection can't hold back every pull.
A pull already on its way when a push comes back that way is dropped when it
answers, for the same reason. Because merging is idempotent (below),
replaying is always safe.

When the server refuses a batch outright (validation, size), the client
splits it until it knows exactly which reports were refused, so the rest
still land. Refused reports go to `salt_unsaved` in localStorage, are laid
back over the server's copy after every pull (`withUnsaved` in `core/85-sync.js`),
and are marked *Not saved* with the server's reason. A refused version isn't
re-sent until someone changes it; editing it sends it again, and Discard
drops it so the server's copy returns. Nothing a user typed is lost, and one
bad report never stalls syncing for anyone.

### Server (`server/salt_sync_server.py`)

A `ThreadingTCPServer` subclass with one `BaseHTTPRequestHandler` subclass.
The same handler class serves both ports; each listener carries a `view_only`
flag that the handler checks per request. Every path the server answers is
one entry in its `ROUTES` table: the method, the handler method, for a POST
its schema validator, and who may use it (whether it needs the access code,
whether the viewer port may use it, and for `/api/basemap` a rate limit of its
own). `do_GET` and `do_POST` look a request up there and apply the entry's
rules; a path that isn't there is a `404`, and a POST to one gets every
refusal a write gets first. The validator does all the checking of a
request's shape (a blank workspace name or an empty list of changes included),
so a route takes its fields as given; a route refuses only what depends on
what the server holds (a report that isn't there, `404`; an edit to an older
copy, `409`). The checking functions are named by what they return: `_v_<route>`
is a route's validator, `_check_<thing>` returns what is wrong (or `None`) and
the validators share them, and `_is_<thing>` answers yes or no.

The settings every workspace shares (the config, profiles, report format,
overlays, basemaps, drones, the narrative's settings, the tags and FMV mode) are each one entry in
`SHARED_SECTIONS`: its key, its empty value, its save route, validator and
cleaner, and how a backup file's copy is read. `DATA_STORE`, the `/api/sync`
payload, `Shared settings.json`, the copy in every workspace backup, the boot
load and the save routes all come from that list, in its order, so a new shared
list is one entry. What one of them does its own way stays written out where it
happens: the config is the workspace viewers are shown and has a route of its
own, profiles are saved one at a time and merged from every file at boot,
backups keep the format per workspace (`formats`), older per-workspace
overlays are pooled at boot, and an overlays save from a page from before tags
keeps the graphics it didn't know (a section's `keep`).

Every `/api` error reply, whatever refused it, is the same JSON:
`{"status": "error", "message": "..."}`, the message one sentence ending in a
full stop (`Validation failed: <what>.` for a refused shape), sent through
the handler's `_error`. Only a page that isn't there (an unknown path
outside `/api`) gets the standard library's HTML `404`.

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/`, `/index.html` | GET | The bundled page. On the viewer port it is stamped `read-only` before any script runs; for the host's own browser the access code is injected into a `<meta>` tag. |
| `/Salt%20Report%20Workbench.html` | GET | The same page, under its old single-file name, so old bookmarks still open it. |
| `/api/sync` | GET | Full state: workspaces, config (the workspace viewers are shown), profiles, the report format, overlays, basemaps, drones, the narrative's settings, the tags (`tags`), FMV mode (`fmv`), sources, the workspaces unloaded since the server started (`unloaded`), connected users, which workspace each connected editor is in (`connected_where`, initials to ATO), the last 50 changes for the Activity list (`activity`: `{at, who, what, ato}`, newest last, who as initials and what in plain words such as `logged ALPHA012`; kept in memory only, so a restart empties it, and no addresses), the number of the change it is as of (`version`, read before the data, so the answer holds at least that change), the server's release (`server_version`), and the mission it is on (`mission`) with the ids of those finished before it (`missions_finished`). |
| `/api/events` | GET | Server-Sent Events stream. Each message says the newest change's number, `{"v": n}`; a page that already has it doesn't pull, and others call `/api/sync`. Changes within 150 ms of each other go out as one message. |
| `/api/health` | GET | No code needed, on either port: `{status: ok \| not saving, version, uptime_seconds, last_saved, save_failures, connected_machines, change}`. Nothing about the reports. |
| `/api/basemap?u=` | GET | An image from an `http://` basemap, for an HTTPS page that can't load it itself. Only from the host of a saved basemap; a redirect followed only on that host (to https, say); images only, up to 16 MB. |
| `/api/save_reports` | POST | Merge a batch of reports into a workspace. A report that is new or says something new is stamped with the sender's profile as its author; one only deleted or put back keeps the author it has; an import (`source` `backup` or `csv`) keeps its reports' own. |
| `/api/edit_report` | POST | Overwrite fields of one report in place (its `observer` among them), without touching its history, stamped with the sender's profile. The page's Edit sends only this; `save_reports` carries it when the server can't be reached. |
| `/api/delete_history` | POST | Remove individual history entries. |
| `/api/unload_ato` | POST | Drop a workspace from memory. |
| `/api/save_config` | POST | Say which ATO and title this editor is in, and make it the one viewers are shown. Each editor keeps their own workspace; no other editor moves. |
| `/api/save_profile` | POST | Register an operator's initials and color. |
| `/api/save_format` | POST | Save the report format (Builder): one for every workspace. An `ato` from an older page is ignored. |
| `/api/save_overlays` | POST | Replace the shared overlays: `{overlays: [{type, name, label?, geometry}], tagged?}` (GeoJSON geometries, longitude/latitude; `type` NAI, OBJ, PL, AXIS, a tag's id or empty for none). An empty list clears them. Without `tagged: true` (a page from before tags) only the NAIs, OBJs and PLs are replaced, and the other graphics are kept. |
| `/api/save_tags` | POST | Replace the team's own tags for graphics: `[{id, name, color}]` (at most 30; `id` `tag-` and up to 16 lowercase letters or digits, made by the page and kept through a rename; names unique, at most 30 characters, none NAI, OBJ, PL, AXIS or Axis of advance; `color` `#rrggbb`). Shared like the overlays and kept in every backup file, where the ones it wouldn't take are dropped on boot. |
| `/api/save_basemaps` | POST | Replace the map's basemap services: `[{name, kind: wms \| tiles, url, layers?, version?, crs?, format?}]` (at most 20, names unique, http/https only; the last three are what a WMS's capabilities said to ask for). Shared like the overlays and kept in every backup file; each browser picks which to show. |
| `/api/save_drones` | POST | Replace the drones on the map: `[{name, grid, at, look?, range?, offStation?}]` (at most 10, names unique, `grid` and `look` MGRS grids as the page writes them, `at` when it was put there, in ms, `range` in km, more than 0 and at most 1,000, `offStation` true when it is off station, kept only then). Shared like the basemaps and kept in every backup file; each browser chooses whether they and their view show. |
| `/api/save_fmv` | POST | Turn FMV mode on or off for everyone: `{fmv: {on: true \| false}}`. Kept in every backup file. Until it is first saved the server holds `{}`, and the page takes that as on when there are drones, else off (a file that never had it, or `{}`, leaves it unsaved at boot). |
| `/api/save_narrative` | POST | Replace the narrative's settings: `{enemy, units: [{name, places, kinds}], equipment: [{type, role, origin, gear?}], off: [rule ids], custom: [{what, words, min, hours}], toward?, terrain?}` (at most 50 units, 500 equipment entries, 30 rules; `terrain`, the elevation source, `{basemap, layer, encoding, units}`, a saved basemap's name, a WMS layer, `terrarium` or `terrain-rgb` for tiles, `m` or `ft`, kept only when set; unit names and equipment types unique; roles and rule ids from the fixed lists, origin `RU`, `CN` or empty; an entry's `gear`, how it moves, `tracked`, `wheeled`, `towed`, `portable`, `foot`, `air` or `static`, kept only when set; a rule's `min` 1-20 reports within `hours` 1-168; `toward`, the AO's way of march, N, NE, E, SE, S, SW, W, NW or empty, kept only when set). Shared like the basemaps and kept in every backup file. |
| `/api/refresh` | POST | Refresh: read the backups in the folder the server hasn't read or written as they are now (by size and modification time), and merge their workspaces in; their shared settings are left. `{files, skipped, workspaces: {ATO: {added, changes}}}`. Not on the viewer port. |
| `/api/finish_mission` | POST | Done with Mission: `{confirm: "DONE"}`. Everything in the backup folder but `tls/`, `terrain.json` and `change.json` goes to `Mission Archives/<when> <title>/`, and the next mission starts with only the basemaps; `{archive, mission}`. A 500 resets nothing. Not on the viewer port. |
| `/api/missions` | GET | The finished missions, newest first: `{name, finished, by, title, workspaces: {ATO: reports}, settings: {overlays, tags, drones, profiles, format, narrative, fmv}}`. Not on the viewer port. |
| `/api/recall_settings` | POST | `{mission, parts}`: those settings of a finished mission, merged or replacing as Recall Settings says; `{taken, missed: {part: why}}`. Not on the viewer port. |
| `/api/load_mission` | POST | `{mission, atos}`: those workspaces of a finished mission, merged into this one and saved with it; `{loaded: {ATO: reports}}`. Not on the viewer port. |
| `/api/elevation` | POST | `{points: [[lon, lat], ...]}` (1 to 500): heights for the narrative, from the elevation source in its settings (`narrative.terrain`): `{source, heights, pending, unknown, error}`, a height in meters or null (no data, or not known yet) for each point; `pending` lists the points still being asked, `unknown` those the source failed on in the last minute, `error` why it last failed. The server asks the source (a WMS's GetFeatureInfo, or an elevation tile it decodes) with up to 4 threads, waits up to 8 s, and keeps the answers in `terrain.json` beside the backups, by point and source, through Done with Mission. On the viewer port too: it changes nothing anyone sees. |
| `/api/elevation_test` | POST | `{terrain, point}`: Test as elevation, for settings not yet saved: `{height, error, reply}`, the reply's start as text. Keeps nothing; logged in the audit log. Not on the viewer port. |
| `/api/wms_fetch` | POST | `{url}`: the server GETs an http(s) address for an editor's page and returns its status, content type, size and text (not images). For WMS capabilities and Check when a service sends no CORS headers. Changes nothing; logged in the audit log. Not on the viewer port. |

### Overlays and geography

Overlays are one list shared by every workspace (since 2.8; before, one per
workspace): `{type, name, label?, geometry}`, with GeoJSON geometry in
longitude/latitude. The type is the graphic's one tag: NAI, OBJ, PL or AXIS
(an axis of advance; built in), the id of one of the team's own tags (`tags`, `[{id, name, color}]`, its
own shared section), or empty for none. A graphic points at its tag by id, so
a rename or recolor changes no overlay, and deleting a tag leaves its graphics
with an id no tag has, which reads as none (Undo gives the tag back to them).
A graphic with none is Unknown: an import adds an area or point its names
don't place that way, rather than asking, and the page lists it first to be
sorted but doesn't draw it, key it or read a Location against it
(`placeOverlays`) until it has a tag.
The page keeps the tags' list (`BUILTIN_TAGS` and `tagOf` in
`app/50-overlays.js`): each tag's color and how its graphics are read
(`shape`: `area` closes a path into an area, `line` keeps it, `any` keeps it
as drawn); a later built-in tag is one more entry there and in the server's
`_OVERLAY_TYPES`. An area of the team's tags places a report as an NAI does,
by the graphic's name (`custom` in `analyzeLocation`, added to the Location by
`locationPlan`, the one place a grid adds a name); the statistics and the
narrative read NAI, OBJ and PL only (`PLACE_TYPES` in `core/20-reports.js`).
An axis of advance names no place: it is a line, drawn with an arrowhead at
its end, that the narrative reads the enemy's way of march from (below). Every workspace's backup file carries the
whole list, and on boot the newest file in that form wins; older files' per-
workspace dicts are pooled (`fold_overlays` in the server, `foldOverlays` in
`core/20-reports.js`). The page converts KML, KMZ and zipped shapefiles (unzipped with
the browser's `DecompressionStream`), loose shapefile parts, and GeoJSON (Web
Mercator converted, other projections refused) into that shape before saving,
so the server only validates: types, name lengths, coordinate ranges, at most
2,000 features and 200,000 points. Shapefiles are read by `parseShapefile` in
`core/40-map.js` (.shp geometry, .dbf attributes, .prj to longitude/latitude for
geographic, Web Mercator and UTM).

Nothing derived is stored. Each Location box is read on the fly by
`analyzeLocation` in `core/30-geography.js` (grids, typed names, the areas the grids fall
in, the nearest phase line, and checks where the two disagree), cached in the
page by text until the overlays change. The core keeps its own answers too,
with an index of each overlay list (`overlayIndex`: the areas, each ring's
box, the phase lines' boxes), used only while the list holds the same
overlays, one for one; a point outside a box is outside what is in it, and a
phase line whose box is further than the nearest so far isn't measured, so
the answers are the same as reading every overlay. MGRS uses Krüger's series for UTM and
picks the northing that lands inside the latitude band, which also refuses
typos; `tests/js/mgrs-vectors.json` holds reference points from the NGA's
GeoTrans to check it against.

The map (`app/60-map.js`) draws in screen pixels from Web Mercator, redrawn
on every pan and zoom. Each graphic's Web Mercator box is worked out once
(`overlayBox`, kept in a `WeakMap` by the graphic, so a sync's new objects
bring new boxes) and a graphic wholly off screen is left out of a drawing.
Names don't overlap: every layer offers its names to one `mapLabels` per
drawing, each with a priority (`LABEL_PRIORITY`: the measures, what is
picked, lines, places with reports, places without, the rest) and a box
from its text's width in the names' font; the names are placed in that
order into a grid of 64-pixel cells, and one whose box meets a placed one
is left off. A layer writes a token where its name goes, so the drawing
keeps its order, and the tokens become the names (or nothing) at the end.
A graphic's name is offered only when the graphic's box on screen is as
wide (and, for an area, as tall) as the name. The boxes placed are kept
(`mapState.labelBoxes`) for the tests to check.

Nothing on the map is synced; each browser keeps its own choices (`salt_map_layers`, `salt_map_grids`, `salt_map_base`,
`salt_map_side`, `salt_map_only_in_view`, `salt_map_tags_off` (the tags
switched off in the key), the kept range rings
`salt_range_rings`, and Settings > Units, `salt_units`). The measure tools
(`app/64-map-controls.js`) keep their points in `mapState` and draw in one
group (`measureLayer`), so the line to the pointer is redrawn alone
(`refreshMeasure`) rather than the whole map. Lengths, areas and speeds are
read out by `formatDistance`, `formatArea` and `formatSpeed` in
`core/45-measure.js`, in metric or imperial, for a class (`vehicle`,
`dismount`, `aircraft`); `movementClass` takes the class from the
equipment catalogue's roles, and `marchRates` a report's rate of march from
its versions (each leg from leaving one grid to reaching the next, and
overall), leaving out a leg under a minute, with a time that can't be read,
or faster than `MARCH_MAX_KMH` allows. Tracks, heat and dots come from
`reportTracks`, `heatPoints` and `reportPositions` in `core/40-map.js`: tracks are a
report's versions in reported order; heat and dots are each report once at its
latest grid (*Latest grids*), or every saved version at its grids (*All
reports*, `all = true`). The
basemap is requested only for the part of the view inside the map's area
(`tilesFor`, `wmsUrl`). The browser fetches it straight from the service; the
server only stores the list of services, and which one is shown is kept per
browser. A WMS is added from its capabilities (read by the page, or through
`/api/wms_fetch` when the service doesn't allow that), which give its GetMap
address, version, formats and each layer's projections; `pickWmsCrs` takes
Web Mercator when every chosen layer has it, else latitude / longitude, which
the map stretches to its Mercator box (true to well under a pixel over a
training area).

The map sits under the Report Log in one pager (`#homePager`): the two
panes are stacked and the pager slides between them with a CSS transform, so
nothing is laid out again; the pane out of sight is hidden and inert once
the slide ends. The Map view (`app/85-mapview.js`) is built around that map.
After each drawing the map tells it (`mapState.drawnHook`) what it showed: the
view box, the reports and their tracks. Once the view settles, the view
counts what is on the map and fills the table from that. A click that didn't
drag (`mapState.clickHook`) is a report (its card), an axis of advance within ten
pixels (its card, with Remove for editors), an NAI or OBJ it falls in, or a
phase line within ten pixels (the table narrows to it). The picked report,
axis and place, and the grid gone to (*Go to a grid*, an X while its box is
open), are plain variables the next drawing reads; nothing about them is
stored or synced.

The one place a report's text is changed for it: on Log and Update,
`locationPlan` lists the places its grids are in that the box doesn't name,
and typed names the grids disagree with; the operator settles each of those
(`askChoice`), and `editLocation` writes the result into the Location before
it is saved, like anything else typed there.

### FMV mode and the drones

FMV mode (`fmv`, Settings) shows the drones, their menu and the report
form's Observer. A report seen from a drone carries its name as `observer`
(a string of at most 40 characters, `''` for none once it has been set; a
history entry keeps the version's), which the page saves on Log, Edit and
Update, shows under the time and in the map's card, and the CSV export puts
in a last *Observer* column when any report has one or FMV mode is on; the
copied SALT text and the report format leave it out. With FMV mode on, each
drone's view points at its `look` grid, else at the newest report on the map
whose observer it is, else nowhere; a drone with `offStation` is left off the
map and out of the Observer list. With FMV mode off, a report keeps its
observer through an Edit or Update.

### The narrative

The Narrative summary (`narrativeLines` in `core/80-narrative.js`) is rules, not a model:
the same reports always give the same words, and nothing leaves the page.
Each report's Size (after destroyed BDA, `sizeAfterBda`) is split into elements and looked up in
`EQUIPMENT_CATALOGUE` (`lookupEquipment`: a name with a digit matches the
start of a type, T-72 matching T-72B3 but not T-720; a word matches a whole
word, and the helicopter letters AH, UH, CH and OH only alone or with a model
number, never as a grid's 100 km square; the longest name wins), which gives each element a role (armor,
artillery, air defense, engineers and so on), an origin (Russian, Chinese,
or any army) and how it moves (`gear`, from `CATALOGUE_GEAR` by the type's
first name: tracked, wheeled, towed, portable, foot, air or static; aviation
and people go by their role, and a type made both ways has none).
`ECHELONS` turns a count into an approximate unit size.
`narrativeJudgments` runs the fixed rules (`NARRATIVE_RULES`) over those facts
per place and across the period; each judgment carries an ICD 203 likelihood
(never past *very likely*), the reports behind it, and what would make it
firmer. Where a judgment's reports hold Russian or Chinese equipment, its
wording and the `DOCTRINE` line under it come from that army's doctrine.
`CAPABILITIES` says what equipment can do (bridging, breaching, a UAV) and
the words in a report that say the same. How strong each rule's judgment is
(EVEN plus steps, `levelBy` thresholds) is written above `narrativeJudgments`,
and a table in `tests/js/core.test.js` fires every rule from a minimal set of
reports and pins its level and the reports behind it.

The enemy's way of march, the direction they move in, is the AO's (`toward`
in the settings) or, within `AXIS_NEAR_METERS` (10 km) of an axis of
advance, the direction of the axis's nearest segment as drawn
(`wayOfMarchAt`, with `nearestSegment` in `core/30-geography.js`). A report
that moves (the heading in its Activity, else its track's last leg of at
least 100 m) is along it, back along it or across it (`wayRelation`: within
60 degrees, beyond 120, between), kept on its facts as `sense`. Back along
it is withdrawing, so not advancing; some rules take the others as signs of
their own (the comment above `narrativeJudgments` lists them). With no way
of march anywhere no report has a sense and no rule adds such a sign, so
the narrative is what it was without them: a random corpus of a thousand
report sets, run through the core before and after, gave the same bytes.

The text is laid out for the reader, the bottom line first: a BLUF (the
strongest judgment, and the strongest of another group no more than a step
weaker, so a defense here and an attack there read as one picture; the
force's largest sighting, the activity and its trend, the latest report,
what to watch for, the first gap), then 1. SITUATION and 2. ENEMY FORCES
(what the reports say), 3. ASSESSMENT (one line a judgment, grouped as
`NARRATIVE_RULES` groups the rules, a group where its strongest judgment
is), 4. WATCH FOR, 5. GAPS AND COLLECTION, and ANNEX A. JUDGMENT DETAIL
(each judgment's basis, doctrine, unit and confidence). The layout only
arranges what `narrativeJudgments` gives: the judgments, their levels and
the reports behind them are the same.

What is happening now comes from the reports' running gear and tracks:
`gearCounts` (how each report's equipment moves, from `CATALOGUE_GEAR`),
`mobilityRead`, a report's overall rate of march (`marchRates`) read
against its gear by `speedRead` (`ROAD_KMH`, `TRACKED_MAX_KMH`,
`SLOW_KMH`), the phase lines its track crosses (`crossingsOf`, with
`segmentsCross` in `core/30-geography.js`), each OBJ's nearest report and
whether its track closed on it (`objectivesOf`, `metersToOverlay`), and the
tempo (`tempoOf`). These are said in the bottom line, Situation and Enemy
forces; the road march rule (`column`) and the logistics rule's sign for
wheeled supply behind tracked forces read them too.

The ground comes from the heights the page gives (`terrain`, in the
summary's options: `{on, heights, note}`, heights by `terrainKey` as the
sync server's `/api/elevation` answered them for `terrainPoints`). `groundAt`
reads a report's height, the slope round it and the rise ahead along the way
of march; a report is on high ground 30 m over the middle height of the
reports within 5 km (`HIGH_GROUND_METERS`, `HIGH_NEAR_METERS`), overlooking
the nearest NAI or OBJ within 3 km. The bottom line's Terrain, the places'
ground, columns on steep slopes (`slopeRead`, `STEEP_PCT`), artillery behind
a crest (`CREST_METERS`), high ground, and the rule `highground` read them.
Line of sight runs from each observer (`observes`) to the `LOS_AREAS` NAIs
or OBJs nearest it within `LOS_MAX_METERS` (`losTargets`), along a line to
each one's nearest edge and to its middle, its heights read every 100 m
(200 m past 2 km, `losSamples`); `losCheck` puts the eye and the target 2 m
up, allows for the earth's curve with refraction, and says seen, hidden (by
how much, where), no data (the source has no height at an end: the page
keeps `null` for that) or waiting (a height not in yet). `terrainPoints` asks the heights of those lines
for observers, and for direct-fire weapons in position out to their reach
(at most `REACH_LOS_MAX_METERS`), and the page works the list out again only
when the reports, overlays or settings change.
Reach comes from the catalogue: `CATALOGUE_REACH` (70-catalogue.js) gives a
type's meters by its first name or a variant's own, and `REACH_KIND` makes
armor, mech and atgm direct, fires indirect and ad air defense; the team's
entries may give their own in km (`REACH_MAX_KM`). `reachRead` gives each
report's reach into the NAIs and OBJs (direct fire through `sightOf`, the
rest by `areasWithin`), `threatsOf` the areas under threat for the bottom
line. The map draws the same for a picked report from `sightPicture` (its
lines with `losCheck`'s answer and the point the ground hides them at, its
reach rings, its words, and the heights it reads), and the Line of sight
tool's line from `losBetween`; the page asks those heights as well as the
narrative's (`askTerrainFor`, app/81-narrative.js).
With no heights, none of it is said, and the narrative is what it was but
for one line under Gaps and collection saying there is no elevation source.

`summaryDetail` (`core/60-statistics.js`) is `summaryReport` with what is
behind the text: for each judgment shown, its rule, level, the last line of
its entry in the assessment, the lines of its detail in the annex and the
reports behind it by id; and the annex's lines. The page ends each entry with
a *Details* button that opens that detail and *From* with those reports as
buttons, and folds the annex into one line (`showSummaryText` in
`app/80-summary.js`); the text it copies, saves and prints is
`summaryReport`'s alone, the same bytes, the annex in full. The page asks
once for both (`screen`, the width it shows, beside the 100 columns), so the
narrative is read once (`narrativeLayout` gives its lines at any width), and
builds it again only when what it is built from has changed, putting back
the Details that were open and the keyboard's place.

The team's settings (`{enemy, units, equipment, off, custom, toward}`) are one set per
server, like the overlays: they arrive in `/api/sync` as `narrative`, are kept
in `localStorage` (`salt_narrative`) and saved with `/api/save_narrative`,
which `clean_narrative` trims to known fields and limits. A server from before
them answers 404, and the page says so and keeps them in the browser. Every
backup file carries them (hand exports too); on boot the newest file's set
wins, and importing a backup whose set differs from a non-empty local one
asks first. The team's equipment entries are matched before the catalogue,
so they can add a type or put a built-in one right.

Edited summary text (Edit text) is the one thing about summaries that is
stored: per browser, in `salt_summary_edits`, keyed by workspace and kind.
It is never synced.

## Sync model

The server is the meeting point, not the authority over content.

- **Notify, then pull.** SSE messages carry only a number: every change
  anyone can see (the data, or who is connected and where) takes the next one
  (`broadcast_update`), starting at the boot time in milliseconds so a
  restarted server's are higher still. With the clock set back they start
  instead at the number kept in `change.json` beside the backups (left in
  place by Done with Mission), which every number given out stays below,
  reserved ahead (`start_change_numbers`). On `data: {"v": n}` a client fetches
  `/api/sync`, unless it already has change `n`. One message type keeps the
  protocol trivial, and a client that missed events catches up on its next
  pull. Changes within 150 ms of each other go out as one message.
- **No answer older than what was seen.** A write's reply carries its
  change's number (in the body and the `X-Salt-Change` header), and
  `/api/sync` says the number it is as of. A pull asked for before a save and
  answered after it is older than the save: the page drops it and asks again,
  rather than putting the old state back on screen.
- **Last-modified wins.** Every report carries `lastModified` (epoch
  milliseconds). `_merge_reports` keys reports by `id` (or `displayId` for rows
  that predate UUIDs) and keeps whichever copy is newer; ties go to the incoming
  copy. Merging the same batch twice is a no-op, which is what makes the
  offline replay safe.
- **Soft deletes.** Deleting marks a report `deleted` rather than removing it,
  so the deletion itself merges and propagates like any other edit.
- **Cached sync payload.** The JSON for workspaces, config, profiles, the
  format, overlays, basemaps, drones, narrative settings and tags is serialized
  once and cached as a byte prefix; only the small per-request tail
  (connected users, where they are, the activity list, read-only flag, the
  change number and the server's release) is appended each time. Any mutation
  clears the cache. A client that accepts gzip (every browser) gets
  the body compressed, five to eight times smaller; since every client pulls
  the same state after a change, the compressed form is cached too, one for
  editors and one for viewers (their bodies differ in the read-only flag),
  and one compression of each serves them all; clients that ask at once wait
  for that one rather than each compressing it.

## Persistence

`save_data_to_disk` writes one `{ATO}_{Title}.txt` per workspace into the
backup folder, which defaults to `Auto Backups/` beside the server. Writes are
debounced by 0.5 seconds so a burst of edits becomes one write, and every
mutation marks its workspace dirty (`mark_dirty`) so only changed workspaces
are rewritten. The report format, overlays, basemaps, drones, narrative
settings, tags, config and profiles ride in every file (the format under each
workspace's name, as older versions read it), and a change to any of them
marks all workspaces dirty. On boot the newest file's format is the one used.

A backup file has two parts: a readable summary of every report for a person
to skim, then a JSON block between `##SALT_BACKUP##` and `##SALT_BACKUP_END##`
that the server parses on boot. On startup, `load_data_from_disk` reads every
`.txt` file in the folder, oldest first, and merges them: each file
contributes its workspace, reports merge by `lastModified` when two files hold
the same one, and the newest file's config decides the active workspace. That
is also how files from before 2.4, which held every workspace, still load;
the first save afterwards gives each workspace its own file.

Concurrency is handled in two steps:

1. While `data_lock` is held, `workspace_backup_parts`, a pure function,
   makes each workspace's part of its file (the summary and its reports'
   JSON: reports are changed in place), and the shared settings are taken as
   they are (each is replaced whole when it changes; the profiles are
   copied), giving a consistent snapshot without any I/O. After the lock is
   released, `shared_backup_json` serializes the shared settings once, the
   overlays being megabytes, and `join_workspace_backups` puts each file
   together (`render_workspace_backups` is the two in one). The files are
   byte for byte what serializing each one whole would give.
2. Each text is written to a temporary file, flushed to disk (`fsync`), and
   moved into place with `os.replace`, still without the lock, so request
   handlers are never blocked on the disk and readers never see a partial
   file. A separate `_disk_lock` keeps writes in order. If preparing or writing
   fails (a file held open by antivirus or a sync tool, say), the changes stay
   marked unsaved and the save is retried after 1, 2 and 5 seconds, then every
   30 seconds, with one console line per run of failures.

Stopping (`graceful_drain`, run once whether Ctrl+C or closing the console
window asks; on Windows a console control handler catches the close) first
refuses every write with 503, which the page sends again later, and waits up
to a second for the writes being handled. Then it saves what is pending and
tells the pages, so nothing is answered as saved that never was.

The shared settings (overlays, basemaps, drones, the narrative's settings,
the tags, profiles, the report format, the config) are also written to their own
`Shared settings.json`, so they survive a restart even when no workspace
exists. Workspace files still carry them too, and on boot the newest file
decides.

File names come from the ATO and title. When two workspaces would get the same
name (Windows ignores case, and `A B` and `A_B` both become `A_B`), the one
whose ATO isn't already safe for a file name gets a short hash of its ATO. A
file whose reports have all been rewritten elsewhere (an old title, say) is
moved into `snapshots/` as `Superseded_<time>_<name>`, never deleted, so it
can't merge back in at the next boot. A backup that can't be read is skipped
with a console line naming it, and the startup banner counts them.

The live file is the only copy and it is replaced on every change, so
`write_snapshot` also stores a dated copy of every file under `snapshots/` on
the first save after boot and then at most once an hour
(`SNAPSHOT_INTERVAL_SECONDS`), keeping the newest `SNAPSHOT_KEEP` rounds (one
round is every file from one save, sharing one UTC time). Snapshot names begin
with that time, so a listing is chronological. `load_data_from_disk` reads only
the top level of the backup folder, so snapshots never load on their own;
restoring one is a manual copy.

Every accepted write passes through `_commit`, which also appends a line to
`audit.log` in the backup folder: UTC time, the operator the server knows for
that address (`AB@10.0.0.12`), and what changed. Server start and stop are
logged the same way. The log is append-only and nothing reads it.

Every line the console shows is also written, with its UTC time, to
`Server Logs/server.log` beside the backup folder (`start_log`), with the full
traceback of any error. It is rotated at about 1 MB (`LOG_MAX_BYTES`), three
older ones kept (`LOG_KEEP`). It sits outside the backup folder, as the
mission archive does, so nothing that reads or moves the backups meets it,
and Done with Mission leaves it where it is.

`_commit` also puts a change people would notice on the Activity list
(`note_activity`), in plain words: for a batch of reports, `report_changes`
compares each with the server's copy before the merge (new is *logged*, a
deleted flag set or cleared is *deleted* or *restored*, anything else but
`lastModified` and `user` is *updated*; a copy older than the server's, or
the same, is nothing), and an import counts them. A write that changes
nothing adds nothing.

Unloading a workspace removes it from memory and leaves its file in place:
unload is "from view", and a restart reloads the file. That is documented
behavior, not a limitation.

Refresh (`refresh_from_disk`) reads a file put in the backup folder while the
server runs, without a restart. The server notes each file's size and
modification time as it reads it at boot and as every save writes it
(`_file_seen`), so Refresh reads only the files that differ: dropped in, or
changed by hand. Their workspaces are merged in as the boot would (a new one's
source is its file), but their shared settings are not, so a file from
elsewhere can't replace the team's overlays or format. An unloaded workspace's
file, unchanged, stays unloaded.

### Missions

The server is on one mission at a time, kept in `Shared settings.json` as
`mission`: a random id, when it began, and the ids of the missions finished
before it. A server with none (new, or from before missions) makes one at
boot and writes it at once (`ensure_mission`), so a restart doesn't make
another. `/api/sync` sends the id and the finished ones, and every write
names the mission it is from (`X-Salt-Mission`).

Done with Mission (`finish_mission`, POST `/api/finish_mission` with
`confirm: "DONE"`) holds the disk and data locks throughout. It writes every
workspace and the shared settings as they are, moves everything in the backup
folder but `tls/`, `terrain.json` and `change.json` (`MISSION_KEEP`) into
`Mission Archives/<YYYY-MM-DD HHMMZ> <title>/` (beside the backup folder) with
a `mission.json` summing it up, and starts the next
mission with nothing but the basemaps. It is all or nothing: a file that can't
be moved has what was moved put back, and the request fails with nothing
reset.

A page keeps the id it is on (`salt_mission`). A sync naming a new id while
the page's is among the finished ones, or a write refused with 409 because it
named a finished mission, makes the page leave it (`leaveFinishedMission` in
`app/92-mission.js`). Reports the server never got are first offered as a
backup file. The page then loads again, and its first step, before anything
else reads storage, clears every `salt_` key but the access code, the mission,
the basemaps and the preferences it puts by (`salt_prefs_before`), so nothing
the old page was writing as it unloaded survives. An id the page has never
seen and that isn't a finished one's (a server that lost its settings file) is
simply taken: no page is cleared without the server saying its mission ended.

`/api/missions` lists the archive's folders, from each `mission.json` or, for
a folder put there by hand, by reading its backups as the boot does
(`read_backups`). `/api/recall_settings` takes chosen settings from one
(`recalled`: lists and profiles merged by name, the format, narrative and FMV
replaced, each checked by its save route's validator), and
`/api/load_mission` merges chosen workspaces into the current one. A mission
is named by its folder's exact name, checked against a listing of the archive,
so no other path is ever read from a request.

## Access control

Both ports speak HTTPS unless the server runs with `--no-https`. Python's `ssl`
module does the encryption, but the standard library can't make a
certificate, so `tls_files()` makes one: a 2048-bit RSA key from `secrets` and
Miller-Rabin, and a self-signed X.509 v3 certificate written out in DER by hand
(about 150 lines) for this machine's names and addresses. It lives in the
backup folder's `tls/`, beside a small JSON note of its expiry and addresses,
and is made again when it nears expiry or the address changes. `--cert` and
`--key` load a certificate of your own instead.

Each connection is handled on its own thread: the listener peeks at the first
byte, wraps the socket in TLS when it is a handshake record (`0x16`), and
otherwise answers the plain request with a `307` to the `https://` address. The
access-code cookie is marked `secure` on HTTPS pages.

The editor port is gated by a 10-character code generated at launch from an
alphabet without look-alike characters (no `0/O`, `1/I/l`, `5/S`), so it can be
read aloud over a radio. Clients send it as a cookie; the server compares it in
constant time. Requests from the machine running the server pass automatically,
which is how the host's browser gets in without typing.

The viewer port has no code; its protection is that every POST returns `405`.

Every POST is also rate-limited per IP with a token bucket (60-request burst,
refilling at 5 per second), validated against a hand-written schema for its
endpoint, and capped at 16 MB. A POST must be `application/json` (else `415`),
and one another site sends (`Sec-Fetch-Site: cross-site`, or an `Origin` that
isn't this server) is refused with `403`, so a web page open on the host can't
write through the host's free pass. Wrong or missing access codes drain a
bucket of their own per IP (30, refilling at 1 per second), on GET as well as
POST; while it's empty every request from that address is refused before its
code is checked, and a request with the right code never touches it, so a
burst of saves can't block reading. Map images through `/api/basemap` have their own per-IP limit
on both ports. Connections are kept alive (HTTP/1.1), so a page's tiles,
syncs and saves go down the few connections its browser holds rather than a
new connection and TLS handshake each; every reply carries its exact
`Content-Length`, and the event stream, which has none, closes its connection
when it ends. A connection that goes quiet for 30 seconds, between requests or
in the middle of one, is closed (event streams excepted), and every reply
forbids framing and content sniffing. A refused request's body is read and
dropped before the reply, so the client receives the error rather than a
connection reset, and the connection is closed after it (`Connection:
close`), as it is after any request whose body isn't read to its end, so no
part of a body is ever read as the next request. The `user` on a report and
the initials in `audit.log` are what the page says; only the address in
`audit.log` is observed by the server.

See [SECURITY.md](../SECURITY.md) for what this model does and does not protect
against.

## Threading

| Lock | Guards |
| --- | --- |
| `data_lock` | `DATA_STORE`, `workspace_sources`, `unloaded_workspaces`, the sync cache |
| `_sync_gz_locks` | one per view (editor, viewer): its last `/api/sync` body and gzip form |
| `_version_lock` | the change number and how far ahead it is reserved in `change.json` |
| `_notice_lock` | the timer that sends changes within 150 ms as one SSE message |
| `sse_lock` | `sse_clients`, `client_initials`, `client_workspace` |
| `SSEClient._lock` | one per SSE connection: whole writes to that client's stream |
| `_disk_lock` | ordering of backup writes |
| `terrain_lock` | the heights kept for `/api/elevation` (`terrain.json`) and what is being asked |
| `_writes` | a condition: the POSTs being handled, and whether the server is stopping |
| `_drain_lock` | stopping (`graceful_drain`) runs once |
| `_save_timer_lock` | the debounce timer |
| `_workbench_html_lock` | the cached page (`index.html` and its mtime) |
| `_audit_lock` | appends to `audit.log` |
| `_activity_lock` | `activity_log`, the Activity list |
| `_rate_lock` | rate-limit buckets |

Each SSE connection holds a thread that waits in `select()` with a timeout of
`SSE_HEARTBEAT_SECONDS` (15): the socket becoming readable means the client
left, and a timeout means it's time to send a heartbeat. Broadcasts copy the
client list under `sse_lock` and write outside it, so one stalled client can't
block the others. A write to a stream may wait `SSE_WRITE_TIMEOUT_SECONDS`
(10); a client that holds its connection but stops reading is then dropped,
so the clients after it are told at most that much later, once.

## Build

`scripts/build.py` replaces the page's single `<link rel="stylesheet">` and
`<script src>` tags with inline copies of `styles.css`, the core and the
`src/app/` scripts, in page order, writes
`dist/index.html`, and copies the server and the Windows launcher beside it.
The page's `<script src="core.js">` names no file: in its place go the parts
in `src/core/`, joined in name order with a newline between parts
(`core_source`), and the build stops if a `src/core.js` exists beside them, so
a stale copy can't ship. The launcher is written with CRLF line endings whatever the checkout used,
because cmd.exe misparses batch files with bare LF endings. The build fails if
either placeholder is missing rather than shipping a broken page. The page's
favicon is an inline data URI for the same reason everything else is inline:
the file has to work with no network at all.
