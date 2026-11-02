# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- **A broken character no longer stops the backups.** Half of an emoji (left
  when one is cut in two) in any field was accepted, and from then on every
  save of the backups failed; one in a title or workspace name also left that
  change unsaved and unanswered. Now it is refused at once, saying which field
  holds it, and a file is always written whatever it holds.
- **A pulled USB stick keeps the changes.** With the backup folder gone, the
  changes waiting to be saved were dropped without a word, and the health
  check still said ok. Now it says `Error saving`, keeps them, and saves them
  when the folder is back, as the manual promised.
- **Stopping says when the changes weren't saved.** It said they were flushed
  to disk even when the save had failed. Now it says `Changes NOT saved` and
  why, and the launcher's window stays open on it.
- **Pages keep updating after a restart with the clock set back.** Open pages
  (viewers' especially) stopped showing changes until reloaded. The server now
  numbers its changes on from the last run's, whatever the clock says.
- **Snapshots with the clock set back.** With rounds already named later than
  the clock (the clock put right backwards), each new round was pruned as soon
  as it was written, and `--restore latest` brought back the old state. New
  rounds are now named after the newest there, and a snapshot is written whole
  or not at all, so a full disk can't leave a cut-off one to restore.
- **Heights from an elevation source that is down.** Each point waited 15
  seconds, so a long list took half an hour and stopping the server could
  wait minutes; a reply that couldn't be read left its point waiting for good.
  Now the points still queued fail at once while the source is down (and are
  asked again later, as before), stopping drops them, a tile can't unpack past
  its own size, the oldest heights make way past the limit instead of new
  ones being asked again, and an `http://` address to an HTTPS port says the
  reply was not HTTP.
- **Impossible report times are refused.** A time such as
  `2026-13-40T25:00:00Z` was taken and then broke the ArcGIS export. Backups,
  imports and earlier versions keep the times they hold, as before.
- **The audit log says when it works again**, after saying it couldn't be
  written, and never stops a change being answered.
- **Errors leave a record.** The server's messages were only in its minimized
  window, without times, and an error showed one line. Every line the console
  shows is now also kept, with its time in UTC, in `Server Logs/server.log`
  beside `Auto Backups` (about 1 MB, then three older ones), with the full
  detail of any error; Done with Mission leaves it alone. Running the server
  has a new part, Sending a problem report, on what to send.
- **The manual names every folder to copy.** After Done with Mission, the
  reports, the audit log and the snapshots are in `Mission Archives`, so
  upgrading and the end of the operation now say to copy it with
  `Auto Backups`.
- **Reports kept while the server couldn't take them now go on their own.**
  Reports logged while the server was unreachable, or busy for a moment,
  were sent only when someone else next saved something, so on a quiet
  network they stayed on the one laptop while the bar said they would be
  sent. They now go as soon as the connection is back, and are tried again
  every few seconds until the server takes them.
- **Restore, settling a Check tag, and deleting history rows now save
  whatever syncs meanwhile.** A sync landing while one of these asked, or
  while history rows were being deleted, made the change go nowhere, though
  the page said it was done. Now it is saved, or, when someone changed the
  report in the meantime so it no longer applies, the page says so and
  changes nothing. Settling a Check tag says it is updated once it is saved.
- **A fault drawing the screen after a sync no longer shows Offline.** The
  dot turned red with nothing said, and the sync was not tried again. The
  fault is now said, the dot stays green, and the next sync tries again.
- **An empty workspace is no longer unloaded by a save.** A save from a
  workspace with nothing logged yet asked the server to unload it, with
  whatever others had logged there meanwhile.
- **A request the server never answers now gives up.** A save stuck on a
  dropped connection held back every update from the others with nothing
  said. Requests now give up after 20 seconds (longer for large backups,
  services asked through the server, and missions) and are treated as the
  server being unreachable: the reports are kept and sent again.
- **A save refused for a reason that isn't the reports is asked once.** The
  page split the save to find the bad report whatever the refusal, so one
  that wasn't about the reports (a wrong address, say) became a burst of
  requests that ran into the server's rate limit. Now only a refusal of the
  reports' content or size is split; any other marks the reports "Not
  saved" with the server's reason, as before.
- **Imported names are no longer cut in the middle of an emoji.** Names
  shortened to fit (graphics from KML, GeoJSON or a shapefile, and basemaps)
  could end on half of a character, which the server refuses.
- **Line of sight over water.** Where the elevation source has no height at
  an end of a line (water, or the edge of its coverage), the line no longer
  waits for ever: the narrative, a picked report's card and the Line of sight
  tool say "No height here from the elevation source". When heights aren't
  coming at all (the source failing, or the page opened as a file), the map
  says "Heights not available" and why, instead of asking.
- **Reports with no time.** A report whose time is empty or can't be read
  no longer counts as 1 January 1970 in Statistics (no more per-day chart
  from 1970), the Excel workbook and the summaries, and no longer stops the
  ArcGIS exports: it is a report with no time, as an empty one always was.
- **Statistics, Summary Reports and the Narrative with many overlays.** With
  2,000 reports and 2,000 overlays, each now draws in well under a second
  (the Narrative about 0.15 to 0.4 s, where it took 3 to 6 s), and a sync
  that changes nothing they show costs almost nothing. A date or time typed
  in their windows draws once typing pauses, not on every key.
- **The Narrative keeps its place.** A sync no longer closes the Details
  that are open or loses the keyboard's place in the report; when the report
  does change, they come back where the same judgment is.
- **No dashes for "none".** The map's BDA assessed tile says None, and the
  CSV import's column picker says (None).
- **The keyboard keeps its place in panels drawn again.** After a basemap's
  Check, Layers or Edit in Manage > Map, and after the Narrative settings'
  tabs, + Add, Back or opening a row, it was left at the top of the page. Now
  it stays on the button pressed, goes to Back when a row or + Add opens, and
  comes back to that row (or + Add) on Back or Escape.
- **The map's menus take the keyboard when opened.** Basemap, Save or print
  and Drones now start on their first control, as Go to a grid does (Tab
  passed every button in the column first); Escape still goes back to the
  button, and Save as PNG or Print goes back to Save or print.
- **The Narrative settings say which tab is shown**, to screen readers too,
  as the Report buttons above the summary do.
- **Save as PNG says it is working, and can't hang.** It showed nothing for a
  second or more with many graphics, and a basemap tile that never came held
  it up for good. Now a toast says it is saving and the button says
  Saving... until it is done; the basemap's images are asked for together,
  and one not in after 8 seconds is left out, which the toast and the image
  say.
- **The saved and printed map's scale bar follows Settings > Units**: yards
  and miles in imperial, as every other measure.

## [2.41.0] - 2026-11-01

### Added

- **Line of sight on the map.** A picked report that observes, or fires
  direct from a position, draws its lines of sight to the NAIs and OBJs near
  it (green where it sees; where ground hides it, an X there and red past it)
  and a ring for each kind of its weapons' reach, with Sight and Reach on its
  card. A new measure tool, Line of sight, checks any two points (up to
  20 km): seen, or where the ground hides it and by how much. Both need an
  elevation source.

## [2.40.0] - 2026-11-01

### Added

- **Weapon reach.** The equipment catalogue now knows how far 117 types'
  main weapons reach, and 28 variants that reach further (the published
  maximum effective range: a tank's gun or the missile it fires through it,
  a gun's standard shell, an air defense system's engagement range), and the
  team can give its own under Equipment
  (Reach, in km). The Narrative's Enemy forces says what each report's
  weapons reach: direct fire (tanks, IFVs, antitank weapons) from a position
  covers the NAIs and OBJs it is in or can see within its reach, using the
  line of sight; indirect fire and air defense reach every area within range,
  from anywhere but on the move. The bottom line gains Threat, the areas most
  under the enemy's weapons; the gaps list types that fight whose reach isn't
  known. No figure is guessed: a type without a trusted one has none.

## [2.39.0] - 2026-11-01

### Added

- **Line of sight.** With an elevation source, the Narrative works out what
  each enemy observer (reconnaissance, air defense, a command post or a UAV
  team, halted or observing) can see: into the three NAIs or OBJs nearest it
  within 5 km, along a line to each one's nearest edge and to its middle,
  with the eye and the target 2 m up and the earth's curve allowed for. Enemy
  forces says, per observer, what it is in, sees into, or what is hidden by
  ground (where, and how far above the sightline); the bottom line's Terrain
  says how many observers can see into which areas; High ground held is a
  step firmer when the observer can see into the area. The heights along the
  lines come through the server like the rest, kept once asked.

### Removed

- VME-203 and VME-102-40 from the equipment catalogue (and the recovery
  vehicles the narrative knows): no real source knows them; the only trace
  found was a video-game mod. A report naming them now lists them as not in
  the catalogue, and the team can add them under Equipment if they are real.

## [2.38.0] - 2026-11-01

### Added

- **Terrain: the Narrative settings take an elevation source.** A new
  Terrain tab picks a saved basemap that holds heights: a WMS layer that
  answers GetFeatureInfo with a number (a DEM), or elevation tiles in
  Terrarium or Mapbox Terrain-RGB encoding, in meters or feet. *Test as
  elevation* asks it the height at a grid and says what came back. The sync
  server asks the source (`/api/elevation`), once a point, for everyone, and
  keeps the heights in `terrain.json` beside the backups, through Done with
  Mission.
- **The Narrative reads the ground.** With an elevation source, the bottom
  line adds *Terrain* (the heights the reports are at, how many are on high
  ground, columns on slopes too steep for them, artillery behind a crest).
  *Latest by place* adds the ground's height there and its steepest slope;
  Columns say when they are on a slope too steep for what they are (over 30%
  mostly wheeled, 60% mostly tracked); Enemy forces adds artillery *behind a
  crest* (the ground 10 m higher 500 m ahead along the way of march) and
  *high ground* (30 m over the middle height of the reports within 5 km).
  Gaps and collection says when there is no elevation source, or heights
  haven't come in.
- **Rule 58, High ground held:** observers, air defense, radars or command
  vehicles halted on high ground within 3 km of an NAI or OBJ, with Russian
  and PLA doctrine. On by default; it needs an elevation source.

## [2.37.0] - 2026-11-01

### Added

- **The equipment catalogue knows how each type moves:** tracked, wheeled,
  towed, carried, on foot, flying or fixed, for every Russian and Chinese
  system and plain word in it (a type made both ways, such as Pantsir, or a
  word that doesn't say, such as APC, is left unsaid rather than guessed).
  *Look up a type* in the Narrative settings says it, and the team's own
  types have a *Moves on* choice.
- **The Narrative reads how the enemy moves and what is happening now.**
  The bottom line adds *Mobility* (tracked against wheeled, and what that
  means for where they can go) and *Closest* (the objective a report is
  nearest, and whether it is closing on it), and the tempo. Situation adds
  the tempo, phase lines crossed (from a report's track) and reported at,
  each objective's nearest report, what is new against the period before,
  and *Latest by place* in place of *By place*. Enemy forces adds how it all
  moves and the columns seen moving, with their rate of march checked
  against their running gear (road-march speed, faster than tracked
  vehicles go, or slow).
- **Rule 57, Road march column:** six or more vehicles moving, mostly
  wheeled or at road-march speed, with Russian and PLA doctrine. On by
  default, like the others.

### Changed

- The logistics pushing forward rule counts one more sign: wheeled supply
  moving along the way of march within 6 hrs after tracked forces.

## [2.36.0] - 2026-10-31

### Changed

- **The Narrative puts the bottom line first and reads simply.** It opens
  with a BLUF: the strongest judgment and, beside it, the strongest of another
  kind (a defense in one place while they attack in another), each with its
  confidence; the force's largest sighting with the support seen with it; the
  activity and whether it is up or down on the period before; the latest
  report; what to watch for; and the first gap. Then come 1. Situation and
  2. Enemy forces as short items, 3. Assessment with one line a judgment
  grouped as Maneuver, Defense, Fires and Support, 4. Watch for (each sign
  once, with the judgments it would firm up), 5. Gaps and collection (places
  gone quiet, in one line, to re-task collection to; judgments resting on low
  confidence; reports without a grid; types to add to the catalogue), and
  Annex A with each judgment in full. On screen, Details at the end of a
  judgment opens its basis, doctrine, unit and reports, and the annex is one
  line; Copy, Save .txt and Print have it all. The judgments themselves, their
  levels and the reports behind them, are unchanged.

### Fixed

- The page opened as a file (offline, without the server) no longer fills the
  browser's console with errors: it asked the server it doesn't have for
  every sync and save, and the browser logged each refused request. It now
  knows there is no server and doesn't ask; it works as before.

## [2.35.0] - 2026-10-31

### Changed

- **Python 3.11.8 or newer.** The server, the launcher and the packed `.txt`
  now need Python 3.11.8, what the operators' machines have, instead of 3.10
  (end of life since 2026-10-01). An older Python is told so plainly, as
  before. CI tests every change on 3.11.8 exactly, on Linux and Windows, as
  well as 3.12 to 3.15.

### Fixed

- Checking a WMS address that answers with an error (a 404, say) closes the
  connection at once instead of leaving it for Python to clean up.

## [2.34.0] - 2026-10-31

### Added

- **Done with Mission.** A button in Manage > Workspaces ends the mission and
  starts the next from nothing, once you type `DONE`. Your browser downloads
  a backup of every workspace; the server moves everything it saved into a
  folder of its own in `Mission Archives`, beside `Auto Backups`, deleting
  nothing; then the workspaces, overlays, tags, drones, narrative settings,
  report format, FMV mode and operators' initials are cleared for everyone,
  and every browser starts again at the startup box, its preferences put by.
  The basemaps stay. A browser holding reports the server never got offers
  to save them to a file first, and the server won't take them into the new
  mission.
- **Previous Missions.** The finished missions are listed under the
  workspaces. *Recall Settings* brings back the overlays, tags, drones,
  initials, report format, narrative settings or FMV mode you tick, and your
  own display preferences; *Load* brings back the workspaces you tick.
- **Refresh.** A button in Manage > Workspaces has the server read the
  backup files put in its `Auto Backups` folder since it started (or changed
  by hand), without a restart, and merge their workspaces in. Only their
  reports: a dropped file can't replace the team's overlays or settings.
- **The narrative reads tracked and wheeled vehicles.** A report that gives
  only how many vehicles were tracked or wheeled (`10x wheeled vics, 2x
  tracked`, `1x wheeled, 10x tracked`) is read by its mix: mostly tracked
  is armor or mechanized forces with their support vehicles, mostly wheeled
  a supply or motorized column with an armored escort, and a mix a
  mechanized force with its supply vehicles. Observed adds them up under
  one name each and gives their mix; the rules read them as they read a
  probable type, a step weaker than a named one; and a 56th rule, *A force
  read from its vehicles*, judges them from as little as one report, never
  above likely.

### Changed

- **Activity takes less room.** In Manage > Workspaces and the viewers'
  sidebar, the Activity box is four rows tall at the foot of the panel,
  down from about eight, and the workspace list gets the space. It still
  scrolls through the last 50 changes.

## [2.33.1] - 2026-10-30

### Fixed

- **A report whose save failed for a moment could be lost.** When the
  server was busy or the connection dropped as a report was logged, the
  page kept it to send again; but a sync asked for just before, answered
  after, put the server's copy in its place, and the report was gone from
  the log, from the browser's saved copy and, in the end, from the server.
  Such an answer is now set aside, and the next sync sends the report
  first.

## [2.33.0] - 2026-10-30

### Added

- **MGRS Lock checks a grid as you type it**: a part of Location that looks
  meant as a grid but isn't one (an odd number of digits, more than 10, two
  numbers of different lengths, or, typed in full, a zone, band or square that
  doesn't exist) gets an orange *Not a grid* chip under Location saying why,
  and Log and Update ask: *Fix it*, or *Log as typed*. A grid after a lead
  word (`vic 39697 06762`; also *vicinity of*, *IVO*, *near*, *nr*, *grid*,
  *approx*, *at*) is checked too, and given the locked zone and square like
  digits alone. Place names and numbers with words (`Hill 205`) never are.
- **MTI Export for ArcGIS points and tracks**: two files, `_tracked` and
  `_wheeled`, read from Size as the CSV's MTI Export reads it, with Size as
  the count and its number in a new `vehicles` field.
- **Every version for ArcGIS points**: a point for each saved version of a
  report at that version's grids, with its own words, numbered in `version`
  and marked `latest`.
- **The narrative and catalogue know more words**: *logistics* (logistics)
  and *maneuver* (armor and mechanized forces) as forces ("3x logistics
  vics", "2x maneuver elements"); AH, UH, CH and OH as attack, utility, cargo
  and observation helicopters (`AH-64`, `CH47`), not inside a word or as a
  grid's 100 km square; a bare *ZBL*; *mine layer* in two words; and the
  GBL-132 mine layer.
- **Tabs slide in**: a short slide and fade from the tab's side in Manage,
  the Map tab's Graphics and Basemaps, the Summary Reports' kinds and the
  Narrative settings' tabs; none with reduced motion.
- **Go to a grid**: a target button among the map's buttons opens a small
  box. Type or paste an MGRS grid (MGRS Lock's zone and square go with its
  digits), and Enter or Go puts a yellow X on the map there, with **Zoom to
  it**; a grid that can't be read is said in the box. Closing the box takes
  the X away. Per browser, not kept.
- **Remove an axis of advance from the map**: clicking an axis opens its
  card, with its name and length; editors have **Remove**, which asks in
  place, then removes it for everyone, with Undo. Viewers see its name.

### Changed

- **The Excel workbook outlines its tables**: every cell of each table (the
  headline numbers, each chart's table, the reports), header included, has a
  thin border.
- **MTI Export** shows with the formats that have it: Reports for Excel,
  ArcGIS points and ArcGIS tracks.
- **Destroyed BDA comes off the Size**: a report of `20x tanks` with 3
  assessed Destroyed reads `17x tanks`, with *BDA: 3x tanks destroyed* small
  under it in the Report Log and the map's card. Only Destroyed counts;
  Damaged and the other effects leave the Size as it is. Each assessment
  comes off the element of its type, as partial BDA pairs them; the rest of
  the Size stays as written (counts, plurals, *possible*); an element
  destroyed to none is dropped, and a Size with nothing left reads
  *None left*. The stored Size is not changed: the form, backups and history
  keep it as logged, and deleting, undoing or changing an assessment brings
  the count back. Copied text says `S: 17x tanks (BDA: 3x tanks destroyed)`;
  the map's tooltips and table, the Statistics counts, the summaries and
  narrative, and the CSV, MTI, ArcGIS and Excel exports use what is left.
  The CSV and the Excel *Reports* sheet add a *Size (as logged)* column when
  BDA has taken from any report; the ArcGIS points and tracks always carry
  `size_logged`. A hedge before the count (`poss 3x APCs`) is now read as
  three in the BDA checklist too, as the Statistics read it.
- **Names on the map don't overlap**: the names of graphics, tracks, drones,
  the grid gone to and the measure tools are placed in order (the measures,
  then what is picked, then axes and phase lines, then places with reports,
  then the rest) and one that would fall on another is left off. A
  graphic's name shows only when the graphic is big enough on screen to
  hold it, so hundreds of NAIs zoomed out show their shapes, not a wall of
  text.
- **2,000 graphics**: the shared overlays hold up to 2,000 graphics (500
  before). Graphics wholly off screen are left out of a drawing, so the map
  stays quick with them all.
- **Show all** has an icon of its own, four arrows out to the corners, drawn
  like the buttons round it.
- **The map's controls are as solid as the Settings menu**: the layer
  buttons, the window, Latest Grids / All Reports, the buttons down the
  side, the key, the cards and the boxes have its background, and a control
  switched on is drawn opaque, so it reads the same over any basemap.

### Removed

- The ArcGIS **.json (Esri JSON)** and **.geojson** exports for points and
  tracks, and the code behind them: points export as a Shapefile or CSV,
  tracks as a Shapefile.

### Fixed

- **The map's sidebar hides with the map**: its top could show as an empty
  box below the Report Log, under some layouts.
- **The map follows a workspace switch at once**: an editor setting another
  workspace, or a viewer picking one in their sidebar, saw the map keep the
  last workspace's reports until something else drew it again (for a
  viewer, until the next change on the server).


## [2.32.1] - 2026-10-29

### Removed

- The standard march rates the time-distance tool no longer offers, from
  the core.

### Fixed

- **Drones follow Settings > Units**: a drone's range, its ring, and the
  distance beside its view read in miles with Imperial, and its range is
  typed in miles there; it is still kept in km for everyone.
- **Focus after a question closes**: when the Report Log was drawn again
  while a question was open (a sync came in), closing it with Escape left
  the keyboard on the hidden question instead of the button that asked.
  It now goes back to that button, found again.

## [2.32.0] - 2026-10-29

### Added

- **Draw an axis of advance on the map** (editors): *Draw axis* among the
  ruler's tools. Click from where the enemy comes from to where it heads,
  finish with a double-click or Enter, name it and Save: it is saved for
  everyone like an imported axis, with Undo.
  The ruler's tools now sit in two rows of three, to cover less of the map.
- **A folder named as one of your tags** (or a layer or file: "Routes" or
  "Route" for the tag Routes) puts its graphics in that tag when imported.
- **FMV mode**: a team-wide switch in Settings, *FMV Mode: On / Off*. On, the
  map has its drone button, menu and drones, and the report form an
  **Observer**: the drone the report was seen from, one on station or none.
  The observer is saved on the report and its history (kept through Edit and
  Update), shown small under its time and in its map card, written in backups
  and as the CSV export's last column; it is not in the copied SALT text, and
  the Report Builder doesn't offer it. Off, there are no drones on the map and
  no Observer, and reports keep the observers they have. Until someone sets
  it, it is on when the team has drones and off when it has none, so a team
  already using drones sees no change. Shared like the drones
  (`/api/save_fmv`, `fmv` in `/api/sync` and every backup file); an older
  server keeps it in the browser and says so.
- **Drones on or off station**: a switch on each drone, for everyone. Off
  station, it stays in the drone list but leaves the map and the Observer
  list. The Activity list says *put drone GE 1 on station* and *took drone
  GE 1 off station*, and *turned FMV mode on* or *off*.
- **The enemy's way of march**: *Enemy moves toward* in the Narrative
  settings (none, or N, NE, E, SE, S, SW, W, NW) is the direction the enemy
  moves in the AO, shared like the other narrative settings (`toward` in
  `/api/save_narrative`; settings without it read as none, and an older page
  keeps it when it saves).
- **Axis of advance**, a built-in line tag (`AXIS`): drawn in dark red on a
  white edge with an arrowhead at its end, from where the enemy comes from to
  where it heads, with a switch in the map's key while there is one. A line
  named *AXIS ...*, *AOA ...* or *Axis of advance ...* (or in a folder or
  layer called *Axes of advance*, *Axis* or *AOA*) imports as one, and any
  graphic can be given the tag. It names no place. Within 10 km of an axis,
  the direction of its nearest part is the way of march, over the AO's.
- **The Narrative judges which way reports move**: a report heading
  somewhere (its Activity, else its track between updates) is along the way
  of march (within 60 degrees), back along it (beyond 120) or across it.
  Combat forces moving back along it are withdrawing, as if the report said
  so, and no longer count as advancing; moving along it is a sign for
  preparing an offensive and for logistics pushing forward, and a step
  firmer for a forward detachment, several axes, an exploitation and a
  pursuit; moving across it is a step firmer for an envelopment. The Basis
  names the sign with its direction (*moving along the way of march (W)*),
  and Observed says the way of march and how many reports went each way.
  With no way of march set and no axis, the Narrative is word for word as
  before.
- **Sort graphics while importing**: the import's review has a checkbox on
  each shape (Shift-click checks a run of them) and, while some are checked,
  a bar to use them all as one tag: NAI, OBJ, PL, Axis of advance, one of
  yours, Unknown, or Skip. Each shape's own *Use as* is still beside it.

### Changed

- **Manage > Map has two tabs**, Graphics and Basemaps, one at a time. It
  opens on Graphics; the map's basemap button goes straight to Basemaps.
- **The Narrative settings' Rules tab** starts with your own rules, with
  **+ Add a rule** as a button at the right of their heading; the built-in
  rules follow.
- **Time-distance is simpler**: type a speed and pick its unit, then click
  along the route. The units are those of Settings > Units (km/h or m/min on
  Metric; mph or knots on Imperial), the box is empty the first time, and
  this browser keeps the last speed and unit. The list of standard rates is
  gone.
- **The version number** sits at the foot of the right-hand panel, centered,
  in the same place on every view (Report Log, map, Manage, Statistics,
  Summary), and the views reach further down.
- **The Activity list** in Manage > Workspaces has one height from the start
  and scrolls, instead of growing with each change.
- **Add Nearby Places off** shows the nearby places in grey without a **+**:
  nothing to add them with.
- **Updating a report** says only "Updating ALPHA012" under the form's title,
  without the line of the report's identifier and contents.
- **AXIS is built in**: `/api/save_overlays` takes it as a graphic's type,
  and a tag of the team's can't be named *AXIS* or *Axis of advance*.
- **Each drone looks at its own reports**: with no grid to look at, a drone's
  view points at its own newest report (one logged with it as the Observer),
  not at everyone's newest, so several drones aren't all looking at the same
  grid. A drone that has seen no report on the map shows no view.
- **A smaller drone menu**: one row per drone (station switch, its name to
  zoom to it, its grid, and More for where it's looking, its range and
  Remove), the two switches on one line, and adding a drone behind **+**.
- **The Tags box is one row**, however many tags there are: a list of your
  tags (it says how many) with the one picked beside it (its color, name,
  count of graphics and delete, which still asks in place and has Undo), and
  **+ New tag**, which opens the new tag's name, color and Add Tag in the
  same row.
- **Unknown graphics**: a shape the import's name and folder rules don't
  recognize (an area or point whose name, folder or file doesn't say NAI,
  OBJ, PL or axis) no longer waits for a choice: it is added with no tag, in
  the **Unknown** group (once *No tag*), now first in the list, open, with
  its count, to be sorted with the same pickers and bar. Unknown graphics
  aren't drawn on the map, in its key, a saved PNG or a print, and don't
  name reports, until they have a tag. Lines with no name or folder to go by
  are still phase lines.

### Fixed

- **Shapes with no name** are numbered as they are imported (UNNAMED,
  UNNAMED 2...), past those already there, so each is a graphic of its own
  instead of all being one.
- **MGRS Lock when updating a report**: its grids in the locked zone and
  square go back in the form as their digits, the zone and square staying in
  the lock's box, instead of the whole grid landing in Location. Saved
  untouched, the Location stays as it was written.
- **The drone menu's switches** draw their knob inside the track, and its
  **+** is centered.

## [2.31.0] - 2026-10-29

### Added

- **Your own tags for graphics**: in Manage > Map, make a tag (a name and a
  color), rename it, recolor it, or delete it (asked in place, with Undo; its
  graphics stay, with no tag). NAI, OBJ and PL stay built in. Tags are shared
  with every editor through the server, kept in every backup, and offered in
  an import's *Use as* list too.
- **Sort graphics into tags**: check graphics in the list (Shift-click for a
  run of them) and add them to a tag or take them out of theirs, or pick any
  one's tag beside it: NAI, OBJ, PL, one of yours, or none. A shape the
  import's name rules missed is one pick from being an NAI, OBJ or PL. A
  graphic has one tag; a built-in tag names it by one word, as an import does
  ("NAI 3" as an OBJ is OBJ 3).
- **Your tags on the map and in reports**: their areas are filled in the tag's
  color and outlined, their lines drawn in it on a black edge, their points as
  diamonds. Each tag in the map's key (NAI, OBJ and PL too) is a switch that
  hides or shows its graphics in this browser; a saved or printed map's key
  leaves out the ones switched off. A report logged inside an area of one of
  your tags gets that area's name in its Location, as with an NAI, and the map
  view's busiest places and place filter know them. Statistics and the
  Narrative still count NAI, OBJ and PL only.

### Changed

- **Overlays may have any tag**: `/api/save_overlays` takes a tag's id, or
  none, as a graphic's type, and `/api/save_tags` saves the tags. A page from
  before tags saves only the NAIs, OBJs and PLs it knows, and the graphics it
  never saw are kept.

## [2.30.0] - 2026-10-29

### Added

- **Measure tools slide out of the ruler**: pressing it opens a toolbar with
  *Distance* (the two-point tool as before), *Path* (each leg's distance and
  bearing, and the total), *Area* (area and perimeter), *Range ring* (a
  center, then a radius clicked or dragged out; *Keep ring on the map* keeps
  it in this browser, listed with a remove button and *Clear all*) and
  *Time-distance* (a route at a standard rate, vehicles on a road march,
  dismounts on a road or across country, a helicopter, or a speed typed:
  how long it takes). Double-click or Enter finishes a path, area or route;
  Escape puts the tools away. From the keyboard, Space puts a point at the
  crosshair in the map's middle.
- **Units: Metric / Imperial** in the Settings menu, per browser: km and m
  or miles and yards, dismounts in m or yd, aircraft in km or nautical
  miles, areas in km² or mi², speeds in km/h, mph, or knots for aircraft.
  The measure tools, track hovers and rates of march follow it.
- **Rate of march**: a report whose track has times shows its rate overall
  and for each leg on its map card, and under each time in its updates in
  the Report Log, in the unit for what it is (aircraft, dismounts or
  vehicles, from the equipment catalogue). A leg with no time between its
  updates, a time that can't be read, or a speed nothing of its kind could
  make is left out. The core gives the units, areas, class and rates
  (`core/45-measure.js`).

## [2.29.0] - 2026-10-29

### Added

- **Probability words in Size are understood**: "2x possible tanks", "3x poss
  APCs", "1x probable heli", "2x likely a heli" and "susp 2x Mi-8" are read as
  the equipment with how sure the observer was. The equipment is counted as
  usual and the reports keep the word; in the Narrative a sign seen only in
  such reports still lets a rule fire but adds no strength, and its reports
  are cited as "possible T1 250100Z". "Heli" is now a helicopter.
- **The R-330 jammers** (plain R-330, R-330T, R-330K, with R-330Zh and
  R-330BMV as before) are electronic warfare.
- **"PC-12344" names an NAI**: an overlay named PC and a number (PC-12344,
  PC 12344) loads as that NAI, and the name typed in a Location names it too.
  A grid in the PC 100 km square stays a grid.
- **Add Nearby Places** (Settings menu, per browser): off, Log and Update no
  longer write the NAI, OBJ or PL a grid is in or near into the Location; the
  chips under it still offer them, to add with a click.

### Changed

- **The version number** moved from the top bar to the bottom center, under
  the Report Log and the map.
- **Import / Export picks the format from a pop-up menu**, as on a Mac:
  grouped as Reports, ArcGIS points and ArcGIS tracks, the picked one
  checked, with the arrow keys, Enter and first letters.

## [2.28.0] - 2026-10-28

### Added

- **Each Narrative judgment shows the reports behind it**: under it on screen,
  *From* lists them by number (eight, then *and N more*), and a tap shows that
  report in the Report Log, its row in view and flashing. Copy, Save .txt and
  Print stay the text alone; the lists are hidden while the text is edited.
  The core gives them with the text (`summaryDetail`), and a test fires each of
  the 55 built-in rules from a minimal set of reports and checks the reports
  behind it.

### Changed

- **A reserve needs contact somewhere named**: the *second echelon or reserve*
  judgment counts contact in another NAI, OBJ, phase line or grid square, and
  no longer counts contact with no place at all, which could have been in the
  reserve's own area.

### Fixed

- **The Narrative's counterattack and logistics rules cite all they read**: a
  counterattack seen as armor arriving after contact now cites that contact
  too, at the same strength; a logistics point counts "tankers" as fuel
  vehicles, as the other rules already did.

## [2.27.0] - 2026-10-28

### Added

- **Who changed what, lately**: Manage > Workspaces has an Activity list of
  the last 50 changes on the server, newest first ("CD logged ALPHA012 · 2 min
  ago", "AB moved to BRAVO", "imported 40 reports"); viewers see it in their
  sidebar. It is kept in memory only, so it starts empty when the server does,
  and holds no addresses. While a report is open for Edit or Update, a line
  under its name says when someone else saves it ("CD updated this report
  just now"); the question at submit is unchanged.

## [2.26.0] - 2026-10-28

### Added

- **The map can be saved and printed**, for briefs: Save as PNG gives the view
  with a title block, north arrow, scale bar and key (the basemap too where
  its service lets the page copy its images, else it says it was left out);
  Print lays out the same on a landscape page, basemap included, and can save
  a PDF.

## [2.25.0] - 2026-10-28

### Added

- **A measure tool on the map**: the ruler button, then two clicks, gives the
  distance and bearing between them ("2.4 km, 047° NE") with both ends' grids.
- **Play on the map's time slider** walks the window from the first report to
  now in about ten seconds, the map following; Pause holds it.
- **Drones say how old their position is**: "GE 1 · moved 6h ago".

### Changed

- **Report dots have a white center**, so they show on the red of a busy heat
  map.
- **Dragging the map is smooth**: the picture slides with the pointer and is
  drawn afresh once, when you let go, instead of every frame.

### Fixed

- **INSTALL.md says what a rebuild gives**: the files inside the zip and the
  one-file `.txt` are the same bytes wherever a tag is built, but the zip
  itself can differ with the machine's zlib. Each release is built once, by the
  Release workflow, so its checksums never change.

## [2.24.0] - 2026-10-28

### Added

- **Releases are built and published by a workflow** when a version tag is
  pushed: it builds the downloads from the tag, publishes them with the
  CHANGELOG section as the notes, and checks what it published.
  `python scripts/bump.py X.Y.Z` (or `make release VERSION=X.Y.Z`) writes a
  new version everywhere it appears and dates the CHANGELOG.
- **A check on pull request titles**: `type(optional scope): summary`.

### Changed

- **CI covers what operators run**: Python 3.11 too, Python 3.10 on Windows, and
  the browser tests on Windows as well as Linux.
- **The development tools are pinned** to exact versions and hashes
  (`requirements-dev.txt`, `requirements-browser.txt`, installed with
  `--require-hashes`), the pre-commit hooks to commits, and CI's Node to
  `.node-version`. Dependabot proposes updates to the tools as it does to the
  CI actions.

### Fixed

- **A release built on Windows is the same bytes as one built on Linux.** The
  build wrote the page with Windows line endings there, and the zip recorded
  the system that made it, so the release workflow's build differed from one
  made by hand. The page is written with LF and the zip says Unix wherever it
  is made.

## [2.23.0] - 2026-10-28

### Changed

- **One way to count and to mark a time.** Every "3 reports" / "1 report" comes
  from one `plural()`, and every L or Z after a time from one `zoneMark()`, both
  in the core. The page says "workspace" where two messages still said "ATO
  board", and its text uses American spelling throughout (meters, center,
  colors, canceled, gray zone).
- **Names in the code say what things are.** The map's 26 settings are one
  `mapState` object; names left from before Manage (`openExportView`,
  `el.exp`, `switchWorkspacesTab`, ...) say Manage; names use American
  spelling; every element id is camelCase; and the server's checks are named
  by what they return. These commits are listed in `.git-blame-ignore-revs`.

### Fixed

- **A change to a shared list is no longer undone by a sync arriving while it
  is being saved.** A sync answer from just before the save put the old list
  back on screen for a moment, and a change made from it then lost the one
  being saved (a drone moved right after its range was set lost the range).
  Syncs now wait for those saves, as they already did for reports.

## [2.22.0] - 2026-10-28

### Changed

- **The map's code is in five files** (its state, drawing, basemaps, drones,
  and its controls) instead of one of 1,500 lines, and the page's scripts are
  numbered in the order they load (two shared a number). Tests check the
  order, that each script is loaded once, and that no two declare one name.
  Nothing the page does changed: the built page holds the same code, moved.
- **The page's logic is in parts.** The 3,800-line `src/core.js` is now twelve
  files in `src/core/`, one per subject (dates, reports, geography, the map,
  exports, statistics, the equipment catalogue, doctrine, the narrative,
  sync). The build joins them in name order into the same single script, so
  the page works exactly as before; the Node tests load them the same way.
- **The server describes each shared setting and each route once.** The
  settings every workspace shares are one list (`SHARED_SECTIONS`) that the
  stored data, `/api/sync`, the backup files, the boot load and the save routes
  all follow, so a new shared list is one entry; every path is one entry in a
  route table that says its handler, its validator and who may use it; and the
  file opens with a table of contents. Nothing it answers, writes or prints
  changes.

## [2.21.0] - 2026-10-28

### Changed

- **The shared lists save one way.** Overlays, basemaps, drones and the
  narrative's settings show a change at once and put it back, saying why,
  when the server refuses it or can't be reached (the overlays used to stay
  changed, and every list said it was "saved in this browser" though nothing
  sent it later). Every refusal reads "Not saved: <reason>".
- **One wording per situation.** Reports kept to send later always say
  "Saved here; it's sent once the server can be reached." Buttons are in Title
  Case throughout (Show in Table, Latest Grids, Edit Text, ...), and no text
  in the page, the docs or the downloads uses an em dash (an empty value shows
  "-").
- **Screen readers hear which button is on** for Statistics' scope, the
  Summary Reports kinds, the map's hours and the welcome screen's presets (they
  showed it by their look alone); one helper sets a control's look and what it
  says together. Buttons that aren't meant to submit a form say so.
- **The server answers every refusal the same way**: JSON with a one-sentence
  message, including an unknown `/api` address and a map image it won't fetch
  (both were plain text or an HTML page). A request missing what it needs, such
  as a blank workspace name, is refused by its endpoint's validator and says
  `Validation failed: ...`. Console lines follow one rule (`[!]` a problem,
  `[+]` done, `[*]` information), and no server text uses em dashes.
- **Colours come from one set of tokens.** Every colour in the stylesheet is
  now named once at its top: each system colour has a soft, hover and strong
  tint, plus a few colours with one job (shadows, text on a coloured button,
  the error red). The many near-identical tints were merged, so some
  backgrounds and borders are a shade lighter or darker. A test keeps new
  colours to the tokens and checks every token is defined and used.

## [2.20.0] - 2026-10-28

### Added

- **Tools for whoever runs the server.** `docs/OPERATIONS.md` covers the day
  to day. The console lists the connected machines (initials, address,
  workspace) as they come and go. `/api/health` says, without the code,
  whether the server is saving, since when, and how many machines are
  connected. `--restore <round>` (or `latest`, or `list`) puts a snapshot
  round back with the server stopped, keeping the backups it replaces in
  `snapshots/before-restore-<time>/`.
- **The page says when something needs attention**: a red **Not saving** bar
  when changes have waited more than 30 seconds for the server, a bar with
  **Reload** when the page and the server are different versions, and a
  message for any unexpected error. Closing the tab with changes not yet sent
  asks first. The version shows beside the connected-users count and on the
  server console.

### Changed

- **Fewer, smaller syncs.** The server numbers every change. A page that
  already has the newest one doesn't pull again, and changes within 150 ms of
  each other send one notice instead of one each.
- **One way to remove things, everywhere.** Deleting reports or a BDA
  assessment, removing an overlay, basemap, drone or narrative setting, and
  unloading overlays or a workspace all ask first in place, with no pop-up:
  the first press turns the button (or the name beside it) into "... for
  everyone?", so nothing moves, and a second press removes. Any other button
  lets the question go. The message that follows has **Undo** for ten
  seconds, which puts back what was removed, for everyone; an unloaded
  workspace's reports go back to the server with their own authors, and you
  are back in it if it was yours.

### Fixed

- **A sync answer that left the server before a save no longer undoes it on
  screen.** A pull asked for before a change and answered after it put the old
  state back (a drone just added disappeared, say), and the next change saved
  from that. The page now drops an answer older than a change it has seen and
  asks again.
- **A click on the Workspaces list is no longer lost to a sync.** Every sync
  drew the list anew, so a button could be replaced between pressing and
  releasing it; an unchanged list is now left as it is.

## [2.19.0] - 2026-10-28

### Added

- **Duplicate report numbers are flagged.** Two reports logged with one number
  (at once on two machines, or one while the server couldn't be reached) are
  both marked **Duplicate**, and **Renumber** gives either one the next free
  number in its workspace.
- **Who is where.** The Workspaces list shows the initials of the editors in
  each workspace, and pointing at the connected-users count lists them.

### Changed

- **Each editor has their own workspace.** Setting or picking one moves only
  you; the others keep theirs. Viewers are shown the last workspace an editor
  switched to. An editor whose workspace someone else unloads is told, and
  sets one to keep logging.
- **Importing a backup or CSV switches only you**, not everyone.
- **An Edit is saved once**, through the edit route alone, instead of twice.
  The server stamps the editor on every report that is new or changed, by
  either route; a report only deleted or put back keeps its author, and an
  import keeps its reports' own.
- **A chosen `--access-code` must be at least 6 characters** (the generated
  one is 10).

### Fixed

- **The welcome screen no longer moves the cursor out of a box being typed
  in.** A moment after opening it puts the cursor in the first empty box; when
  a sync had filled in the ATO by then, the rest of an ATO being typed went
  into the Title box, and the editor started in the workspace viewers are
  shown instead of the one typed.

## [2.18.0] - 2026-10-28

### Added

- **Troubleshooting** in INSTALL.md and README.txt: the Windows Firewall
  prompt, a port already in use, a missing Python, the certificate warning,
  and "my reports are gone" (the wrong folder).
- **Keyboard and screen reader access.** The Report Log's rows, sort headers,
  history and BDA work from the keyboard; the map's table rows open with
  Enter, and the map pans with the arrow keys and zooms with + and -; dialogs
  take the focus and give it back; the Settings menu works with the arrow
  keys; toasts are announced. Switches, chips, the time slider and the chart
  buttons say what they are.

### Changed

- **Upgrading says plainly to copy the `Auto Backups` folder** (a new zip
  unpacks into a new folder), in INSTALL.md, the README and README.txt.
- **Secondary text, switches and ticked boxes are easier to read**: each now
  meets the contrast it should against the dark panels.
- **Reduced motion** shortens every animation and transition, not just some.
- **The overlay ×** asks "Remove for everyone?" in its row before it removes,
  as a basemap's Remove does.
- **The narrative's Remove** is red when it asks, like a basemap's.
- **Fixed-wing aircraft no longer suggest a helicopter refueling point or an
  air assault**; those judgments need helicopters.
- **Console lines** from the server, the launcher and the scripts all start
  `[+]`, `[*]` or `[!]` with no leading space.

### Fixed

- **Saving:**
  - A report whose title or number wasn't text stopped every backup for the
    rest of the session, silently. Such reports are refused, and a backup
    that can't be prepared or written is retried until it is.
  - Basemaps, overlays, drones, the narrative's settings and the format set up
    before any workspace existed were lost at the next restart. They now have
    their own `Shared settings.json`.
  - A backup file that couldn't be read was skipped without a word; it is now
    named, and the startup banner counts them.
  - Two workspaces whose names made the same file name (`A B` and `A_B`) lost
    one on restart; a renamed workspace's old file merged back in at every
    start. Names now never collide, and an old file is moved into `snapshots/`.
  - Snapshots kept two days only with one workspace; they're now kept by
    round, two days whatever the number of workspaces.
- **Sync:**
  - A save the server refused (or a workspace switch, unload, profile, format
    or narrative change) still said it was saved. It now says why it wasn't.
  - An editor whose clock ran behind had their edits quietly dropped.
  - Edit or Update wrote over a teammate's newer change without asking; it
    now asks whether to keep theirs or overwrite.
  - Importing a backup replaced whole workspaces here instead of merging
    report by report, and its prompt didn't say what else it changes.
  - A teammate's sync emptied the workspace fields while you were changing
    them, and the start screen could move everyone to a stale workspace.
  - A sync that landed while a workspace switch was being saved, or was asked
    for just before it, brought the old workspace back, and the next report
    logged copied all its reports into the new workspace.
  - Checked rows, the row being edited and opened cells were lost at every
    sync.
  - "Send to ATO" could lose reports when the destination refused them.
  - "Copied" was shown even when the browser blocked the clipboard.
  - A shared list the server refused (basemaps, drones, the narrative's
    settings) stayed changed here; it's now put back. Removing or editing a
    narrative entry or a drone acts on that entry, even if a sync moved it.
  - Statistics rebuilt (closing open tables) at every sync, even when nothing
    changed.
- **Reading reports:**
  - "moving 120 trucks" read as a heading of 120 degrees, "new" as a
    direction, and "heading 360" as nothing.
  - "objective area" and "phase line of the advance" became places (OBJ AREA,
    PL OF).
  - Impossible spreadsheet times (31 NOV, 30 FEB, 2500Z) rolled into another
    day, and a time without its month could land in the future.
  - A spaced grid was split across the BDA checklist's elements.
  - BDA and Statistics read the same Size differently ("2x BUSES" against
    "1x bus", "T-72 x4"), and a team's own types weren't folded in Statistics.
  - "fire support position" and "launch site" counted as Firing in Statistics
    and on the map.
  - One broken overlay (too few points, an unknown type) stopped every
    analysis; it's now left out. Overlay names are matched as typed names are
    (`NAI 01` is `NAI 1`).
  - A damaged shapefile could hang the page; it's now refused in words.
  - The ArcGIS exports changed a field's type with the data, so appending to
    an existing layer failed.
  - "0" vanished from the page and CSV exports; a missing or invalid time
    printed as "NaN"; the narrative wrote "trackeds" and "2x bus".
- **The map:**
  - The heat map stopped counting at about three reports in one place.
  - A WMS image asked for before the basemap changed could still land.
  - Full screen kept room for the sidebar it leaves behind.
  - Escape didn't close the map's menus or report card, and Escape in the
    narrative's settings also cancelled a report being edited.
- The Summary's charts counted reports without a time when Statistics didn't.
- The page didn't start in a browser that blocks storage, and opened as a
  file it retried the server's events forever.
- `make lint` passed a syntax error in any script but the last, and tests and
  `release.py` overwrote the developer's `dist/`; `make run` kept its data in
  `dist/`, where `make clean` deleted it.

### Security

- **The host's browser can't be used to write from another site.** The
  server refuses POSTs that aren't JSON or that come from another site, and
  every reply forbids being framed.
- **Connections that stall are closed** after 30 seconds (the event stream
  excepted), and a request with an unreadable length or deeply nested JSON
  gets a plain error.
- **Wrong access codes are throttled on GETs too**, in a limit of their own,
  so a burst of saves never blocks reading; map images and event streams
  have per-address limits.
- **Synced colors and overlay types can't add markup or styles** to the page.
- **The server stops** instead of falling back to plain HTTP when Python has
  no `ssl` module, and tells an older Python plainly that it needs 3.10.
- **SECURITY.md** now says exactly what is protected: initials on a report are
  what the page says, only the address in `audit.log` is the server's own.

## [2.17.2] - 2026-10-28

### Changed

- **"Logistics" is now "logistics and support"** wherever the kinds of
  equipment are named: the narrative's equipment line and the narrative
  settings. It is the same kind as before, so saved settings carry over.
- **Plurals in any case are one type with their singular.** "4X VICS",
  "2X TRUCKS", "5X APCS" and "6X TANKS" typed in capitals now count with
  "vic", "truck", "APC" and "tank" (the narrative said "4x tanks, 2x tanks"
  for "4X TANKS, 2x tank"), and so do "lorries", "buses", and two-word types
  such as "RADIO RELAYS" and "BRIDGE LAYERS". A name that ends in S stays as
  it is (MANPADS), and so does a variant (T-72S). "Bus" joins the light
  vehicles.

## [2.17.1] - 2026-10-28

### Changed

- **Removing a basemap is one row away.** In Manage's Map tab each basemap's
  row has **Remove** beside Check and Layers (or Edit), so there's no opening
  its layers and scrolling to the bottom. The first press asks "Remove for
  everyone?" in the basemap's name, so nothing on the row moves; a second
  press removes it, and any other button lets it go. The Remove at the bottom
  of an opened basemap is gone.

## [2.17.0] - 2026-10-28

### Added

- **Drones on the map.** A drone button under the basemap button: add a drone
  (a Gray Eagle, say) by name and grid, move it by typing a new grid, remove it.
  Each is drawn in orange with its name. **Its view** is a cone from the drone,
  narrow at the drone and widening to a rounded end round the newest report on
  the map, with the sightline down its middle, a box round the report, and the
  distance and direction; it follows newer reports, the time slider and the
  filters. **Zoom** centres the map on a drone. **Looking at** points a
  drone's view at a grid instead of the newest report, and **Range** (km)
  rings the drone and turns its view red, with how far out of range, when the
  target is past it. The drones are shared with everyone; showing them and
  their view is each browser's choice.
- **Grab a grid.** Shift + click on the map copies the ten-digit grid there;
  while Shift is held, the grid under the pointer shows beside it.
- **General terms in the narrative**: vic, vehicle, tracked, wheeled, support,
  fueler, engineer and their mixes. A vehicle of no given type is counted as
  *other vehicles*; the more specific word wins.
- More EW in the catalogue: SPN-2, SPN-3, SPN-4 and SPN-30 radar jammers,
  Tobol, Divnomorye, Samarkand, the Mi-8MTPR-1 helicopter, the Khibiny pod, the
  Volnorez and Saniya vehicle jammers, the Pishchal drone gun, and the J-15D.

### Changed

- **Workspaces is now Manage**, as it holds more than workspaces. Its Overlays
  tab is now **Map**: the ops graphics and the basemaps (added, checked,
  changed and removed there). The map's basemap button only switches between
  them, with a link to Manage.
- The NAI, OBJ and phase-line lists fold away, closed to start with; two icon
  buttons open or close them all.
- Basemaps are named for themselves (a WMS by its title, a tile service by its
  host); the name boxes are gone.
- The map's sidebar box reaches up round its button.
- Sizes: "and", "&" and "with" separate elements, a count can follow its type
  ("vics 10x"), and "total of", "approx" and the like are left out.

### Fixed

- A total with its breakdown was misread: "Total of vics 10x: 5x tanks and 5x
  APC" was one unknown type, and "Total 10 vics, 5x tanks, 5x APC" counted 20.
  Now the breakdown is counted, and what it leaves of the total.
- MGRS Lock's zone and square disappeared from beside Location after each
  report, though the lock still applied.
- The note that the basemap service didn't answer came up when only a few
  tiles were missing (a service with no imagery for part of the area), even
  though Check passed; now it shows only when nothing in view came back.
- A WMS whose capabilities give an http:// address that sends everything on
  to https:// (EOX Maps, for one) drew no map on an HTTPS page while Check
  passed: the server's basemap fetch followed no redirects. It now follows a
  redirect on the same host (never to another), and a WMS linked over https
  is saved with its https:// address, so the browser asks it directly.
- Enter in MGRS Lock's box tried to log the report ("Please fill in: Size,
  Activity, Location"); now it sets the zone and square and goes on to
  Location.

## [2.16.0] - 2026-10-27

### Added

- `--cert` and `--key` to use your own certificate, and `--no-https` for plain
  HTTP.

### Changed

- **The README is rewritten** to be read in two minutes: the Report Log first,
  each main feature with a screenshot (new ones of Statistics and BDA), then
  quick start, usage, and flags. Install details and backups move to
  `docs/INSTALL.md`, and the file tree to `docs/ARCHITECTURE.md`. Screenshots
  are about a third of their old size.

### Removed

- `CODE_OF_CONDUCT.md`.

### Security

- **The server speaks HTTPS by default**, on both ports, so someone watching the
  network can no longer read the reports or the access code, or copy the code
  to edit. It makes its own certificate on first start (kept in
  `Auto Backups/tls/`) and prints its fingerprint. Each browser warns once;
  choose Advanced, then Proceed. Old `http://` addresses are sent on to
  `https://`. Images from `http://` basemaps come through the server, from the
  hosts of saved basemaps only.
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
- Manual, README, architecture and security notes and the shipped README
  brought up to date. The Map has its own section in the manual, and the
  README has new screenshots.

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

### Removed

- The busiest grid squares chart and its 10 km / 1 km switch, from
  Statistics. The Most Trafficked summary still lists grid squares.

### Fixed

- A To time now takes in the whole of its minute: a report logged in the last
  second of it was left out of exports, statistics and summaries.

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

- Each release carries one checksum file, `SHA256SUMS.txt`,
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

## [2.3.0] - 2026-10-24

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

### Fixed

- A browser whose storage is full keeps working. Every browser mirrors every
  workspace, with history, into the ~5 MB a browser allows, and when that
  ran out the client went silently offline. It now says so once and carries
  on from memory.
- Starting the server a second time on Windows failed to fail: both copies
  printed the banner and split the traffic between them. The second start now
  stops with "port already in use".
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

### Security

- Report ids are escaped wherever they land in the page, and the server
  accepts only the characters the app generates, so a tampered backup file
  can't carry markup into everyone's browser.

## [2.2.0] - 2026-10-24

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
- The access-code box accepts codes longer than 10 characters, so a custom
  `--access-code` can be typed in.
- "Send to ATO" from the IMPORT workspace never pushed the destination
  workspace, so the moved reports were lost on the next sync.
- The MTI export finds counts written "4x tracked" (and "4 x tracked"), not
  only "4 tracked".

### Security

- Server: an oversized or refused upload gets its error reply instead of a
  connection reset, a negative `Content-Length` is refused at once, and a
  cookie with non-ASCII characters is denied instead of getting no response.
- Server: `HEAD` requests no longer report the size and date of files beside
  the server.
- Server: `--access-code` refuses a blank value, which used to open the editor
  port to anyone, and characters a browser cookie can't carry.

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

### Added

- Brand identity: logo, monochrome variants, avatar, README banners, social
  preview, and an inline favicon.
- A 54-test suite covering merge rules, backup round trips, validation, rate
  limiting, access control, and live HTTP behavior.
- CI: lint, tests on Python 3.10–3.13 and on Windows, and a build smoke test.
- Ruff, pre-commit, EditorConfig, and a Makefile.
- README, architecture notes, and contributing, security, and conduct guides.

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

[Unreleased]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.41.0...HEAD
[2.41.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.40.0...v2.41.0
[2.40.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.39.0...v2.40.0
[2.39.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.38.0...v2.39.0
[2.38.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.37.0...v2.38.0
[2.37.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.36.0...v2.37.0
[2.36.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.35.0...v2.36.0
[2.35.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.34.0...v2.35.0
[2.34.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.33.1...v2.34.0
[2.33.1]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.33.0...v2.33.1
[2.33.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.32.1...v2.33.0
[2.32.1]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.32.0...v2.32.1
[2.32.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.31.0...v2.32.0
[2.31.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.30.0...v2.31.0
[2.30.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.29.0...v2.30.0
[2.29.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.28.0...v2.29.0
[2.28.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.27.0...v2.28.0
[2.27.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.26.0...v2.27.0
[2.26.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.25.0...v2.26.0
[2.25.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.24.0...v2.25.0
[2.24.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.23.0...v2.24.0
[2.23.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.22.0...v2.23.0
[2.22.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.21.0...v2.22.0
[2.21.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.20.0...v2.21.0
[2.20.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.19.0...v2.20.0
[2.19.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.18.0...v2.19.0
[2.18.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.17.2...v2.18.0
[2.17.2]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.17.1...v2.17.2
[2.17.1]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.17.0...v2.17.1
[2.17.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.16.0...v2.17.0
[2.16.0]: https://github.com/MaymiPR/SaltReportWorkbench/compare/v2.15.0...v2.16.0
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
