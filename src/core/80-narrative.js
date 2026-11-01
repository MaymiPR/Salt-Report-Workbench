// SPDX-License-Identifier: AGPL-3.0-only
// The narrative: facts, the rules' judgments, and the written lines. The build joins the src/core/ parts in name order inside one function, so they share one scope.

const HOUR = 3600000;
const OBSTACLE = /\b(obstacles?|mines?|minefields?|wire|berms?|ditch(es)?|abatis|tank traps?|dragon'?s teeth|trench(es)?|pyramids|hedgehogs|concrete blocks?)\b/i;
const WITHDRAW = /\b(withdraw(s|n|ing|al)?|retreat(s|ed|ing)?|pull(s|ed|ing)? back|fall(s|ing)? back|fell back|break(s|ing)? contact|disengag(e|es|ed|ing))\b/i;

// How a type reads in the narrative, in the reports' own style: a designation
// as reported (15x T-72, 6x PAX), a plain word in lower case and plural
// (31x trucks).
const TYPE_ACRONYMS = new Set(['PAX', 'IFV', 'APC', 'MBT', 'BMP', 'BTR', 'BRDM', 'SAM', 'ADA', 'AAA', 'MANPADS', 'UAV', 'UAS',
    'ATGM', 'MLRS', 'MRL', 'SPG', 'AVLB', 'POL', 'CP', 'HQ', 'C2', 'EW', 'ATV', 'UTV', 'SUV', 'ATZ', 'AH', 'UH', 'CH', 'OH']);
const NO_PLURAL = new Set(['personnel', 'people', 'men', 'infantry', 'ammo', 'fuel', 'water', 'cargo', 'artillery', 'arty', 'recon', 'supply']);
const PLURALS = { man: 'men', person: 'people' };
// A bare "tracked" or "wheeled" reads as the vehicle it describes.
const BARE_ADJECTIVE = new Set(['TRACKED', 'WHEELED']);
const typeCount = (type, n, kit) => {
    if (!kit || kit.origin || /\d/.test(type) || TYPE_ACRONYMS.has(type)) return `${n}x ${type}`;
    const words = (BARE_ADJECTIVE.has(type) ? kit.name : type).toLowerCase().split(' '), last = words.pop();
    const many = n === 1 || NO_PLURAL.has(last) ? last
        : PLURALS[last] || (/(s|x|z|ch|sh)$/.test(last) ? `${last}es` : last.replace(/([^aeiou])y$/, '$1ie') + 's');
    return `${n}x ${[...words, many].join(' ')}`;
};

// The enemy's way of march, the direction they move in, where a point is:
// along the nearest axis of advance within AXIS_NEAR_METERS of it, by the
// direction of that line's nearest segment as drawn (from where they come
// from to where they head); else the AO's, from the narrative settings
// (`toward`, one of HEADINGS_8); else none. { deg, dir (of HEADINGS_8),
// axis (the axis's name, or '' for the AO's) }, or null. `axes` are axesOf's.
const AXIS_NEAR_METERS = 10000;
const wayOfMarchAt = (pt, axes = [], toward = '') => {
    let best = null;
    if (pt) {
        axes.forEach(a => a.lines.forEach(l => {
            const s = nearestSegment(pt.lon, pt.lat, l);
            if (s && s.meters <= AXIS_NEAR_METERS && (!best || s.meters < best.meters)) best = { ...s, axis: a.key };
        }));
    }
    if (best) return { deg: best.bearingDeg, dir: HEADINGS_8[Math.round(best.bearingDeg / 45) % 8], axis: best.axis };
    const i = HEADINGS_8.indexOf(toward);
    return i >= 0 ? { deg: i * 45, dir: toward, axis: '' } : null;
};
// The axes of advance among some overlays, each by its name with its lines.
const axesOf = (overlays) => (overlays || []).filter(o => overlayOk(o) && o.type === 'AXIS' && /LineString/.test(o.geometry.type))
    .map(o => ({ key: overlayKey(o), lines: o.geometry.type === 'LineString' ? [o.geometry.coordinates] : o.geometry.coordinates }));
// A direction of movement (degrees) against the way of march: within 60
// degrees of it is along it (advancing), more than 120 is back along it
// (withdrawing), and between is across it (flanking, or moving laterally).
const wayRelation = (deg, wayDeg) => {
    const d = Math.abs((((deg - wayDeg) % 360) + 540) % 360 - 180);
    return d <= 60 ? 'along' : d > 120 ? 'back' : 'across';
};
// Which way a report moves, in degrees: the heading its Activity gives, else
// its track's last leg, from the latest earlier grid at least
// MOVE_MIN_METERS from its latest (so a grid typed again a few meters off is
// no move); null when it says none and hasn't moved.
const MOVE_MIN_METERS = 100;
const movementDeg = (f) => {
    if (f.act.headingDeg !== null) return f.act.headingDeg;
    const t = reportTracks([f.r])[0];
    if (!t || !t.moved) return null;
    const end = t.points[t.points.length - 1];
    for (let i = t.points.length - 2; i >= 0; i--) if (metersBetween(t.points[i], end) >= MOVE_MIN_METERS) return bearingBetween(t.points[i], end);
    return null;
};

// Vehicles reported only by their running gear, as MTI reports give them
// ("10x wheeled vics, 2x tracked"): the catalogue's name for each, and the
// role it is read as. Tracked vehicles are read as armor or mechanized
// forces; wheeled ones as supply vehicles or a motorized column.
const RUNNING_GEAR = { 'tracked vehicle': 'tracked', 'wheeled vehicle': 'wheeled' };
const GEAR_ROLE = { tracked: 'mech', wheeled: 'logistics' };
// Mostly one or the other: at least two thirds of them.
const gearMix = (tracked, wheeled) => (tracked >= 2 * wheeled ? 'tracked' : wheeled >= 2 * tracked ? 'wheeled' : 'mixed');

// What the narrative needs about a report, beyond the summaries' facts: its
// equipment (from its Size after BDA, the facts' `size`), the roles in it, its size by kind, and the areas it counts in
// (its NAIs and OBJs, else its 10 km square, else none). With a way of
// march (`march`: { axes, toward }), the way of march where it is (`way`,
// wayOfMarchAt at its first grid) and, when it moves, how (`sense`: along,
// back or across, wayRelation); without one, both null.
// Tracked and wheeled vehicles with no type given count in its roles and
// sizes as RUNNING_GEAR reads them (`gear`: { tracked, wheeled, mix }, else
// null); a report with nothing surer than that, or than hedged types, is a
// `guess`, which the rules weigh as a hedged one.
const narrativeFacts = (f, team, march = null) => {
    const els = sizeElements(f.size, team).map(e => ({ ...e, kit: lookupEquipment(e.type, team) }));
    const groups = {}, gear = { tracked: 0, wheeled: 0 };
    els.forEach(e => {
        const g = e.kit && RUNNING_GEAR[e.kit.name];
        if (g) gear[g] += e.count;
        const k = e.kit && ECHELON_KIND[g ? GEAR_ROLE[g] : e.kit.role];
        if (k) groups[k] = (groups[k] || 0) + e.count;
    });
    const geared = gear.tracked + gear.wheeled > 0;
    const sq = f.a.points.length ? gridSquare(f.a.points[0].mgrs, 1) : null;
    const way = march ? wayOfMarchAt(f.a.points[0] || null, march.axes, march.toward) : null;
    const deg = way ? movementDeg(f) : null;
    return {
        ...f, els, groups, way, sense: deg === null ? null : wayRelation(deg, way.deg),
        // Every element seen as possible, probable or likely ("2x poss T-72"): the
        // least sure of those words, else empty;
        // a weaker sign (see judge in narrativeJudgments).
        hedged: els.length > 0 && els.every(e => e.hedge) ? ['possible', 'probable', 'likely'].find(h => els.some(e => e.hedge === h)) : '',
        gear: geared ? { ...gear, mix: gearMix(gear.tracked, gear.wheeled) } : null,
        guess: geared && els.every(e => e.hedge || (e.kit && RUNNING_GEAR[e.kit.name])),
        roles: new Set(els.filter(e => e.kit).map(e => (RUNNING_GEAR[e.kit.name] ? GEAR_ROLE[RUNNING_GEAR[e.kit.name]] : e.kit.role))),
        areas: f.places.length ? f.places : sq ? [sq.replace(/ (\d) (\d)$/, ' $1$2')] : [],
        id: f.r.displayId || f.r.id || '',
        who: (f.r.user && f.r.user.initials) || '',
    };
};
const isManeuver = (f) => f.roles.has('armor') || f.roles.has('mech');
const byTime = (list) => [...new Set(list)].sort((x, y) => x.ms - y.ms || x.id.localeCompare(y.id));
// The most reports among `list` (in time order) inside any `span` of time.
const densest = (list, span) => {
    let best = [];
    list.forEach((f, i) => { const w = list.slice(i).filter(g => g.ms - f.ms <= span); if (w.length > best.length) best = w; });
    return best;
};

// Lines of at most `width`, the first starting with `first`, the rest with `rest`.
const wrapText = (text, first, rest = first, width = 100) => {
    const lines = [];
    let line = first;
    String(text).split(' ').forEach(w => {
        if (line.trim() && (line + w).length > width) { lines.push(line.trimEnd()); line = rest; }
        line += `${w} `;
    });
    lines.push(line.trimEnd());
    return lines;
};

// A team rule's words ("bridge, ferry, PMP") as one whole-word pattern.
const ruleWords = (words) => new RegExp(`\\b(${String(words).split(',').map(w => w.trim()).filter(Boolean)
    .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')).join('|')})\\b`, 'i');

// What some equipment can do, by catalogue name, and the words in a report
// that say the same ("bridging", "jamming").
const capability = (names, words) => ({ names: new Set(names), words });
const ATTACK_HELOS = ['Mi-24', 'Mi-35', 'Mi-28', 'Ka-50', 'Ka-52', 'Z-10', 'Z-19', 'Z-21', 'attack helicopter'];
const LIFT_HELOS = ['Mi-8', 'Mi-17', 'Mi-26', 'Ka-29', 'Z-8', 'Z-18', 'Z-20', 'S-70C2', 'utility helicopter', 'cargo helicopter'];
const CAPABILITIES = {
    uav: capability(['Orlan-10', 'Zala', 'Eleron-3', 'Forpost', 'Granat', 'Takhion', 'Supercam', 'Merlin-VR', 'ASN-206', 'ASN-207', 'ASN-209',
        'BZK-005', 'BZK-006', 'BZK-007', 'BZK-008', 'BZK-009', 'WZ-7', 'TB-001', 'CH-3'],
    /\b(uavs?|uas|drones?|quadcopters?|mavic|dji)\b/i),
    cbRadar: capability(['1L219', '1L271', '1L227', 'ARK-1', '1B75', 'AZK-7', 'SLC-2', 'Type 704'], /\bcounter[- ]?(battery|fire)\b/i),
    mrl: capability(['BM-21', '2B26', 'BM-27', '9K512', 'BM-30', 'Tornado-G', 'Tornado-S', 'Tornado', '9K59', 'TOS-1', 'TOS-2', 'TOS-3',
        'PHL-03', 'PHL-16', 'PHL-11', 'PHZ-11', 'PHZ-89', 'PHL-81', 'PHL-90', 'PHL-20', 'PHL-21', 'PH-63', 'WZ-303', 'AR-1', 'AR-2', 'AR-3',
        'SR-5', 'WS-1', 'WS-2', 'WS-3', 'WS-22', 'WS-32', 'WS-33', 'WS-35', 'SY-300', 'SY-400', 'A-200', 'A-300', 'WM-40', 'WM-80'],
    /\b(mlrs|mrl|rocket launchers?)\b/i),
    deep: capability(['BM-27', '9K512', 'BM-30', 'Tornado-S', 'Iskander', 'Tochka', 'Luna-M', 'K-300P', 'Kalibr', 'Kh-59', 'Kh-101', 'Kh-22',
        'Kh-32', 'Kinzhal', 'PHL-03', 'PHL-16', 'AR-1', 'AR-3', 'WS-2', 'WS-3', 'SY-400', 'WS-600L', 'DF-11', 'DF-12', 'DF-15', 'DF-16',
        'DF-17', 'DF-21', 'DF-26', 'DF-27', 'CJ-10', 'CJ-100', 'CJ-1000'], /\b(ballistic missiles?|cruise missiles?|missile launch\w*|tels?)\b/i),
    thermobaric: capability(['TOS-1', 'TOS-2', 'TOS-3', 'BMO-T', 'RPO-A', 'MRO-A', 'RShG-1', 'RShG-2', 'PF-97', 'FHJ-01', 'FHJ-84', 'FPH-01', 'FPH-02'],
        /\b(thermobaric|flamethrowers?|shmel)\b/i),
    loitering: capability(['Lancet', 'Geran-2', 'Kub-BLA', 'Gerbera', 'Garpiya', 'Italmas', 'Molniya', 'KVN', 'VT-40', 'Skalpel', 'FPV',
        'CH-901', 'ASN-301', 'CM-501XA', 'WS-43'], /\b(loitering|kamikaze|fpvs?|one[- ]way attack|fib(er|re)[- ]?optic)\b/i),
    // Aircraft, rotary-wing apart from fixed-wing: only helicopters fly from
    // a FARP or carry an air assault. Attack aviation is either, and armed UAVs.
    attackHelo: capability(ATTACK_HELOS, /\b(gunships?|attack helicopters?)\b/i),
    liftHelo: capability(LIFT_HELOS, /\b(transport helicopters?|lift helicopters?)\b/i),
    helo: capability([...ATTACK_HELOS, ...LIFT_HELOS, 'Mi-2', 'Ka-226', 'Ka-27', 'Ansat', 'Z-9', 'Z-11', 'H120', 'SA342', 'observation helicopter'],
        /\b(helicopters?|helos?|gunships?)\b/i),
    attackAir: capability([...ATTACK_HELOS, 'Su-24', 'Su-25', 'Su-34', 'Yak-130', 'JH-7',
        'CH-4', 'CH-5', 'KDV002', 'Wing Loong', 'GJ-11', 'Orion', 'Forpost-R', 'Okhotnik', 'Altius'],
    /\b(gunships?|attack helicopters?|close air support|air ?strikes?)\b/i),
    vdv: capability(['BMD-1', 'BMD-2', 'BMD-3', 'BMD-4', 'BTR-D', 'BTR-MD', 'BTR-ZD', 'BTR-RD', '2S9', '2S25', '2S42', 'ZBD-03'], /\b(vdv|paratroop\w*)\b/i),
    airlanding: capability([], /\b(air ?assault|airborne landing|heliborne|landing zone|lz|parachut\w*|air ?drop\w*|landed by helicopter)\b/i),
    amphibious: capability(['ZBD-05', 'ZTD-05', 'ZSD-05', 'Type 63A', 'PT-76', 'K-61'], /\b(amphibious|beach(ed|ing)?|landing craft|naval infantry|marines?|swimming)\b/i),
    bridging: capability(['MTU-20', 'MTU-72', 'MTU-90', 'MT-55', 'TMM', 'PMP', 'PP-91', 'PP-2005', 'PPS-84', 'PMM-2', 'GSP', 'PTS',
        'WZ-621', 'GQL-110', 'GQL-111', 'GQL-120', 'GQL-321', 'GQL-410', 'GZM-003', 'GQC-003'],
    /\b(bridg\w*|ferr(y|ies|ying)|pontoons?|fording|ford)\b/i),
    breaching: capability(['UR-77', 'UR-67', 'UR-07', 'BMR-3', 'KMT-7', 'KMT-8', 'IMR-2', 'IMR-3', 'Uran-6', 'Prokhod-1', 'GCZ-110', 'GCZ-112',
        'GPZ-111', 'GSL-110', 'GSL-111', 'GSL-130', 'GSL-131', 'GSL-132', 'GSL-133', 'GSL-134', 'GSL-211', 'GSL-411', 'GSL-430', 'GBP-126', 'GPJ221'],
    /\b(breach\w*|mine[- ]?clear\w*|clearing (mines|obstacles|a lane)|demining|miclic|line charges?)\b/i),
    minelaying: capability(['GMZ-3', 'PMZ-4', 'UMZ', 'Zemledeliye', 'GBL-120', 'GBL-130', 'GBL-132'],
        /\b(mine[- ]?lay\w*|laying mines|scatter(able|ed) mines?|remote(ly)?[- ](laid |delivered )?min(es?|ing)|cluster mines?|pfm-1|ptm-\d|pom-\d)\b/i),
    cbrn: capability(['RKhM-4', 'RKhM-6', 'RPM-2', 'BRDM-2RKh', 'TMS-65', 'ARS-14', 'UTM-80M', 'TDA-2K', 'TDA-3', 'MRK-46', 'Type 14', 'CBRN'],
        /\b(rkhbz|chemical (defen[cs]e|troops|recon\w*)|decontaminat\w*|decon|cbrn|nbc|smoke (generators?|screens?|pots?))\b/i),
    sead: capability(['ASN-301', 'Kh-31', 'Kh-58'], /\b(anti-?radiation|sead|(radars?|sams?|air defen[cs]e) (struck|hit|destroyed))\b/i),
    glideBomb: capability(['UMPK', 'FAB-500', 'KAB-500', 'LS-6'], /\b(glide bombs?|guided bombs?|kabs?|fabs?|umpk|aerial bombs?)\b/i),
    recovery: capability(['BREM', 'BREM-L', 'BREM-K', 'BREM-D', 'BREM-80U', 'REM-KL', 'REM-KS', 'BTS-2', 'BTS-4', 'ZJX-93', 'WZ-653', 'VME-203',
        'VME-102-40', 'Type 90-II ARV'], /\b(recover(y|ing|ed)|tow(ed|ing)|arvs?|wrecker)\b/i),
    medevac: capability(['BMM-80', 'Linza', 'CSZ-181', 'ambulance'],
        /\b(casevac|medevac|ambulances?|stretchers?|wounded|casualt(y|ies)|evacuat\w* (the )?(wounded|casualties|injured))\b/i),
    c2: capability([], /\b(command posts?|headquarters|antennas?|radio masts?|generators?)\b/i),
    ew: capability([], /\b(jam(s|med|ming|mers?)?|interference|spoof\w*|gps (denied|jammed|loss|lost)|direction finding)\b/i),
    deception: capability(['Gerbera'], /\b(decoys?|dumm(y|ies)|inflatables?|mock[- ]?ups?|fakes?|camouflag\w*|camo|netting|concealed|maskirovka|thermal (blankets?|capes?|camouflage))\b/i),
    smoke: capability(['TDA-2K', 'TDA-3'], /\bsmoke\b/i),
    atPosition: capability([], /\b(at (ambush|positions?)|atgm (team|positions?)|antitank positions?|ambush\w*)\b/i),
};
const textOf = (f) => `${f.size} ${f.r.activity || ''}`;
const can = (f, cap) => f.els.some(e => e.kit && CAPABILITIES[cap].names.has(e.kit.name)) || CAPABILITIES[cap].words.test(textOf(f));
// Firing words that aren't contact are NOT_CONTACT, with the activity tags.
const FIRING_WORDS = ACTIVITY_TAGS.find(([t]) => t === 'Firing')[1];
// Words some rules look for in a report.
const LIGHT_WORDS = /\b(motorcycles?|motorbikes?|dirt ?bikes?|buggies|buggy|atvs?|quads?|quad bikes?|utvs?|scooters?|civilian (cars?|vans?|vehicles?))\b/i;
const URBAN = /\b(towns?|villages?|buildings?|houses?|streets?|urban|basements?|high-?rises?|apartments?|city|cities)\b/i;
const FLANK = /\b(flank\w*|envelop\w*|encircl\w*|surround\w*|pincers?|bypass\w*|cut(ting)? off|kotel|kotyol|cauldron)\b/i;
const RAIL = /\b(rail\w*|trains?|flatcars?|wagons?)\b/i;
const DRONE_DROP = /\b(drones?|uavs?|quadcopters?)\b.{0,30}\b(drop\w*|deliver\w*|resuppl\w*|supplies|carr(y|ies|ying))\b/i;
const FARP = /\b(farps?|forward (arming|refuel\w*)|helipads?|landing sites?)\b/i;
const C2_TARGETS = /\b(command posts?|headquarters|hq|radars?|antennas?|relays?|comms|communications|starlink)\b/i;
const ROUTES = /\b(roads?|routes?|msr|asr|supply|convoys?|vehicles?|trucks?|logistics|bridges?|crossings?)\b/i;
const STRUCK = /\b(struck|strikes?|striking|hit|hits|destroyed)\b/i;
const INDIRECT = /\b(indirect|closed positions?|from (a )?distance|long range|hull[- ]down)\b/i;
const FUEL_AMMO = /\b(fuel|tankers?|pol|ammo|ammunition|atz)\b/i;
const GATHER = /\b(tree ?lines?|gather\w*|accumulat\w*|massing|basements?|hiding|hidden)\b/i;
const PURSUIT = /\b(pursu\w*|chasing)\b/i;
const COUNTER = /\b(counter[- ]?attack\w*|retook|retaking|recaptur\w*)\b/i;
const SCOOT = /\b(displac\w*|relocat\w*|reposition\w*|shoot and scoot|roving)\b/i;
// A 10 km square as the narrative names it (11S NV 31): zone and square, easting and northing digit.
const SQUARE = /^(\d{1,2}[C-X] [A-Z]{2}) (\d)(\d)$/;
const SHELLING = /\b(shelling|shelled|barrage|fire missions?|impacts?|incoming|artillery fire|rocket fire|indirect fire)\b/i;
const has = (f, ...tags) => tags.some(t => f.act.tags.includes(t));
const levelBy = (n, likely, veryLikely) => (n >= veryLikely ? VERY_LIKELY : n >= likely ? LIKELY : EVEN);
const kindsOf = (signs) => signs.filter(([, l]) => l.length).length;
// The place most of some reports are in.
const mostIn = (list) => {
    const n = new Map();
    list.forEach(f => f.areas.forEach(a => n.set(a, (n.get(a) || 0) + 1)));
    return [...n].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]?.[0] || null;
};

// The judgments the reports support: each with its ICD 203 level, what is
// judged (said of the enemy or a unit: "are preparing a defense in NAI 1";
// some say it in the terms of the army whose equipment it is: { RU, CN, '' }),
// the places it is about, the signs seen (and the reports behind them), and
// the signs that would make it firmer. Every rule looks only at the reports
// given; rules in `off` are skipped, and the team's `custom` rules run too.
//
// How strong a judgment is (its level, an index into ICD203): a rule that
// fires is at least roughly even chance (EVEN), and `judge` caps it at very
// likely (VERY_LIKELY). Each rule raises it one of three ways, tuned per rule:
//   - EVEN + steps: one for each thing beyond the minimum that makes it
//     firmer (antitank: two or more ATGM positions +1; obstacles or tanks in
//     hides with them +1).
//   - levelBy(n, likely, veryLikely): n is a count, of reports (deception),
//     of places (axes, fortline) or of the kinds of signs seen (kindsOf:
//     crossing, cp), sometimes plus one for a bonus (assembly: armor halted
//     in five reports or more); at `likely` it is likely, at `veryLikely`
//     very likely.
//   - The same thresholds written out (defense, logistics, offense, firing,
//     withdrawal).
// The table of rules in tests/js/core.test.js fires each one from a minimal
// set of reports and pins the level it gets, so a change to the tuning shows
// there.
//   - A sign seen only in hedged reports ("2x possible T-72") still lets a
//     rule fire, but adds no strength: each such sign takes a step off the
//     level, down to roughly even chance at least.
// The way of march (wayOfMarchAt: an axis of advance near a report, else the
// AO's direction in the settings) gives a moving report a sense (along it,
// back along it, across it), and some rules a sign of their own, named with
// the way of march ("moving along the way of march (W)"). With no way of
// march anywhere, no report has a sense and no rule shows that sign, so the
// narrative is word for word what it was before. With one:
//   - Back along it is withdrawing, as the word is: such a report is not
//     advancing (`advancing`), so the rules that look for forces advancing
//     leave it out. Withdrawal fires on combat forces moving back along it,
//     reported as withdrawing or not, and its level counts both kinds of
//     report together (one even chance, two likely, three very likely);
//     reconnaissance in force takes them moving back within 3 hrs of the
//     probe as it takes pulling back.
//   - Along it: a kind of sign for offense (kindsOf, so +1 step at most),
//     and with it logistics pushing forward fires on supply vehicles
//     moving along it with no armor massing or fuel and ammunition (+1 kind
//     besides); +1 step for a forward detachment, several axes, an
//     exploitation and a pursuit whose forces move along it.
//   - Across it: +1 step for an envelopment whose forces move across it.
// The tests' table of rules fires each one from the same minimal reports
// with a way of march too, to pin those steps.
// The judgments are sorted by level, then by how many reports are
// behind them, then by NARRATIVE_RULES' order; the narrative shows ten.
const narrativeJudgments = (facts, cite, { off = new Set(), custom = [] } = {}) => {
    const out = [];
    const byArea = new Map();
    facts.forEach(f => f.areas.forEach(a => { if (!byArea.has(a)) byArea.set(a, []); byArea.get(a).push(f); }));
    const on = (rule) => !off.has(rule);
    // A sign about the way of march, only when there is one somewhere:
    // named with its directions where the reports are, most first ("(W)",
    // "(W, SW)"), or without them while none is seen.
    const marchKnown = facts.some(f => f.way);
    const marchSign = (what, list) => {
        if (!marchKnown) return [];
        const n = new Map();
        list.forEach(f => n.set(f.way.dir, (n.get(f.way.dir) || 0) + 1));
        const dirs = [...n].sort((x, y) => y[1] - x[1] || HEADINGS_8.indexOf(x[0]) - HEADINGS_8.indexOf(y[0])).map(([d]) => d);
        return [[dirs.length ? `${what} (${dirs.join(', ')})` : what, list]];
    };
    const along = (f) => f.sense === 'along';
    // Fighting forces, as against supply, command or support vehicles.
    const combat = (f) => isManeuver(f) || (f.groups.infantry || 0) > 0 || f.roles.has('light');
    // `guessed`: its level already allows for reports read from their
    // running gear alone, so only the hedged ones take a step off.
    const judge = (rule, level, what, signs, places = null, guessed = false) => {
        const seen = signs.filter(([, l]) => l.length);
        const list = byTime(seen.flatMap(([, l]) => l));
        const unsure = seen.filter(([, l]) => l.every(f => f.hedged || (f.guess && !guessed))).length;
        out.push({
            rule, order: RULE_ORDER[rule] ?? NARRATIVE_RULES.length, level: Math.max(Math.min(level, VERY_LIKELY) - unsure, Math.min(level, EVEN)), what,
            key: typeof what === 'string' ? what : what[''],
            places: places || [...new Set(list.flatMap(f => f.areas))],
            basis: seen.map(([s, l]) => `${s} (${cite(l)})`).join('; '),
            list, watch: signs.filter(([, l]) => !l.length).map(([s]) => s),
        });
    };
    // Contact: firing words that aren't about fire support or a firing position.
    const shot = (f) => has(f, 'Firing') && FIRING_WORDS.test(String(f.r.activity || '').replace(NOT_CONTACT, ' '));
    // Moving, but not away: a withdrawal isn't an advance, nor is moving
    // back along the way of march.
    const advancing = (f) => has(f, 'Moving') && !WITHDRAW.test(f.r.activity || '') && f.sense !== 'back';
    const after = (list, f, span) => list.some(e => f.ms > e.ms && f.ms - e.ms <= span);
    const firing = (f) => (f.roles.has('fires') && shot(f)) || SHELLING.test(f.r.activity || '');
    const ewOf = (f) => f.roles.has('ew') || can(f, 'ew');
    // A small dismounted group: up to 12 people, on foot or in light vehicles, with antitank weapons at most.
    const smallGroup = (f) => f.roles.size > 0 && [...f.roles].every(r => r === 'infantry' || r === 'atgm' || r === 'light')
        && (f.groups.infantry || 0) > 0 && (f.groups.infantry || 0) <= 12;

    for (const [area, list] of byArea) {
        const at = (test) => list.filter(test);
        const smoke = at(f => can(f, 'smoke'));
        const obst = at(f => OBSTACLE.test(f.r.activity || '') || can(f, 'minelaying'));
        const atgm = at(f => (f.roles.has('atgm') && has(f, 'Stationary', 'Emplacing', 'Observing')) || can(f, 'atPosition'));
        // Preparing a defense: digging in, obstacles, engineers, antitank weapons, vehicles holding.
        const dig = at(f => has(f, 'Emplacing') && !OBSTACLE.test(f.r.activity || ''));
        if (on('defense') && (dig.length || obst.length)) {
            const signs = [
                ['digging in or fortifying', dig], ['obstacles or mines', obst],
                ['engineer equipment', at(f => f.roles.has('engineer'))], ['antitank weapons in position', atgm],
                ['combat vehicles halted in position', at(f => has(f, 'Stationary') && (isManeuver(f) || f.roles.has('fires') || f.roles.has('ad')))],
            ];
            const kinds = kindsOf(signs), n = byTime(signs.flatMap(([, l]) => l)).length;
            judge('defense', kinds >= 3 && n >= 4 ? VERY_LIKELY : kinds >= 2 || n >= 3 ? LIKELY : EVEN,
                `are preparing a defense in ${area}`, signs, [area]);
        }
        // Antitank positions: ATGMs set up, covering obstacles, tanks in hides.
        if (on('antitank') && atgm.length) {
            const tanks = at(f => f.roles.has('armor') && has(f, 'Stationary'));
            judge('antitank', EVEN + (atgm.length >= 2 ? 1 : 0) + (obst.length || tanks.length ? 1 : 0), `have antitank positions in ${area}`,
                [['antitank weapons in position', atgm], ['obstacles or mines they cover', obst], ['tanks in hide positions', tanks]], [area]);
        }
        // Reconnaissance, then armor or mechanized forces within 6 hours.
        const scouts = at(f => f.roles.has('recon') || has(f, 'Observing') || can(f, 'uav'));
        const pairs = scouts.map(s => [s, list.filter(m => m !== s && isManeuver(m) && m.ms > s.ms && m.ms - s.ms <= 6 * HOUR)]).filter(([, l]) => l.length);
        if (on('recon') && pairs.length) {
            const lead = byTime(pairs.map(([s]) => s)), after = byTime(pairs.flatMap(([, l]) => l));
            const support = at(f => f.roles.has('fires') || f.roles.has('ad') || f.roles.has('engineer'));
            judge('recon', EVEN + (lead.length >= 2 || after.length >= 2 ? 1 : 0) + (support.length ? 1 : 0),
                `are scouting a route through ${area} for armor or mechanized forces`,
                [['reconnaissance', lead], ['armor or mechanized forces within 6 hrs after it', after],
                    ['artillery, air defense or engineers in the same area', support]], [area]);
        }
        // UAVs, then artillery within the hour: a reconnaissance-fire (or -strike) link.
        const uavs = at(f => can(f, 'uav'));
        const fireAfter = at(f => (firing(f) || can(f, 'loitering')) && uavs.some(u => u !== f && f.ms >= u.ms && f.ms - u.ms <= HOUR));
        if (on('reconfire') && uavs.length && fireAfter.length) {
            const radar = at(f => can(f, 'cbRadar'));
            judge('reconfire', EVEN + (uavs.length >= 2 ? 1 : 0) + (radar.length || fireAfter.length >= 2 ? 1 : 0), {
                RU: `are spotting for artillery with UAVs over ${area} (a reconnaissance-fire complex)`,
                CN: `are spotting for rockets and artillery with UAVs over ${area} (reconnaissance-strike)`,
                '': `are spotting for artillery with UAVs over ${area}`,
            }, [['UAVs overhead', uavs], ['artillery, shelling or loitering munitions within an hour after', fireAfter], ['counter-battery radar', radar]], [area]);
        }
        // An assembly area: armor halted with supply or command vehicles.
        const still = densest(at(f => isManeuver(f) && has(f, 'Stationary')), 12 * HOUR);
        const backing = at(f => f.roles.has('logistics') || f.roles.has('c2') || has(f, 'Resupplying'));
        if (on('assembly') && still.length >= 2 && backing.length) {
            const signs = [['armor or mechanized forces halted', still], ['supply or command vehicles, or resupply', backing],
                ['artillery or air defense with them', at(f => (f.roles.has('fires') || f.roles.has('ad')) && has(f, 'Stationary'))]];
            judge('assembly', levelBy(kindsOf(signs) + (still.length >= 5 ? 1 : 0), 3, 4), {
                RU: `are in an assembly area in ${area}, preparing to attack (an assault detachment's assembly area)`,
                CN: `are in an assembly area in ${area}, preparing to attack (combined-arms battalions forming assault groups)`,
                '': `are in an assembly area in ${area}, preparing to attack`,
            }, signs, [area]);
        }
        // A combined-arms group on the move: armor with artillery, air defense or engineers within 2 hours.
        const movers = at(f => isManeuver(f) && advancing(f));
        const escorts = at(f => (f.roles.has('fires') || f.roles.has('ad') || f.roles.has('engineer')) && advancing(f)
            && movers.some(m => Math.abs(m.ms - f.ms) <= 2 * HOUR));
        if (on('forward') && escorts.length) {
            const alongside = movers.filter(m => escorts.some(e => Math.abs(m.ms - e.ms) <= 2 * HOUR));
            const big = Math.max(...alongside.map(m => m.groups.maneuver || 0), 0) >= 10 || alongside.length >= 3;
            const ahead = byTime([...alongside, ...escorts]).filter(along);
            judge('forward', EVEN + (big ? 1 : 0) + (ahead.length ? 1 : 0), {
                RU: `are moving a combined-arms group through ${area}, possibly a forward detachment or advance guard`,
                CN: `are moving a combined-arms group through ${area}, possibly a vanguard ahead of the main body`,
                '': `are moving a combined-arms group through ${area}`,
            }, [['armor or mechanized forces moving', alongside], ['artillery, air defense or engineers moving with them', escorts],
                ...marchSign('moving along the way of march', ahead)], [area]);
        }
        // A water obstacle or gap: bridging or ferries, smoke, cover, armor waiting.
        const bridge = at(f => can(f, 'bridging'));
        if (on('crossing') && bridge.length) {
            const signs = [['bridging or ferry equipment, or a crossing reported', bridge], ['smoke', smoke],
                ['air defense covering it', at(f => f.roles.has('ad'))], ['armor or mechanized forces waiting', at(f => isManeuver(f) && has(f, 'Stationary'))],
                ['amphibious vehicles', at(f => can(f, 'amphibious'))]];
            judge('crossing', levelBy(kindsOf(signs), 2, 3), `are preparing to cross a water obstacle or gap in ${area}`, signs, [area]);
        }
        // A breach: mine clearing, smoke, fire support, armor nearby.
        const breach = at(f => can(f, 'breaching'));
        if (on('breach') && breach.length) {
            const signs = [['mine clearing or breaching equipment, or a breach reported', breach], ['smoke', smoke],
                ['thermobaric weapons or artillery fire', at(f => can(f, 'thermobaric') || firing(f))], ['armor or mechanized forces nearby', at(isManeuver)]];
            judge('breach', levelBy(kindsOf(signs), 2, 3), `are preparing to breach obstacles in ${area}`, signs, [area]);
        }
        // A command post: command vehicles or antennas, with air defense, EW or many vehicles halted.
        const c2 = at(f => f.roles.has('c2') || can(f, 'c2'));
        const adStill = at(f => f.roles.has('ad') && has(f, 'Stationary'));
        if (on('cp') && c2.length) {
            const halted = at(f => has(f, 'Stationary'));
            const signs = [['command vehicles, antennas or a command post reported', c2], ['air defense in place', adStill],
                ['electronic warfare', at(ewOf)], ['three or more vehicles halted there', halted.length >= 3 ? halted : []]];
            judge('cp', levelBy(kindsOf(signs), 2, 3), `have a command post in ${area}`, signs, [area]);
        }
        // Air defense over a key site: in place with command, artillery or supply vehicles.
        const sites = at(f => has(f, 'Stationary') && (f.roles.has('c2') || f.roles.has('fires') || f.roles.has('logistics')));
        if (on('adsite') && adStill.length && sites.length) {
            judge('adsite', EVEN + (adStill.length >= 2 ? 1 : 0) + (sites.length >= 2 ? 1 : 0), `are protecting a key site in ${area} with air defense`,
                [['air defense in place', adStill], ['command, artillery or supply vehicles in place', sites]], [area]);
        }
        // Deception: decoys, dummies, camouflage.
        const dec = at(f => can(f, 'deception'));
        if (on('deception') && dec.length) {
            judge('deception', levelBy(dec.length, 2, 3), {
                RU: `are using camouflage and deception (maskirovka) in ${area}`, CN: `are using camouflage and deception in ${area}`,
                '': `are using camouflage and deception in ${area}`,
            }, [['decoys, dummies, camouflage or concealment reported', dec], ['the force the decoys stand in for, concealed nearby', []]], [area]);
        }
        // Amphibious: amphibious vehicles or landings, with smoke, ferries or cover.
        const amph = at(f => can(f, 'amphibious'));
        if (on('amphibious') && amph.length) {
            const signs = [['amphibious vehicles or a landing reported', amph], ['smoke', smoke], ['bridging or ferries', bridge],
                ['air defense or artillery covering', at(f => f.roles.has('ad') || f.roles.has('fires'))]];
            judge('amphibious', levelBy(kindsOf(signs), 2, 3), `are preparing or conducting an amphibious landing or crossing near ${area}`, signs, [area]);
        }
        // Air assault: transport helicopters or landings, with airborne vehicles or escorts.
        // Transport aircraft (Il-76, Y-20) alone are not one: they fly supplies too.
        const lift = at(f => can(f, 'liftHelo')), landing = at(f => can(f, 'airlanding'));
        if (on('airassault') && (lift.length || landing.length)) {
            const signs = [['transport helicopters', lift], ['an air assault or landing reported', landing],
                ['airborne (VDV) vehicles or paratroopers', at(f => can(f, 'vdv'))], ['attack helicopters escorting', at(f => can(f, 'attackHelo'))]];
            judge('airassault', levelBy(kindsOf(signs), 2, 3), {
                RU: `are conducting or preparing an air assault or airborne landing near ${area} (VDV or air-assault forces)`,
                CN: `are conducting or preparing an air assault near ${area} (an air-assault brigade)`,
                '': `are conducting or preparing an air assault near ${area}`,
            }, signs, [area]);
        }
        // A force read from its vehicles: tracked and wheeled vehicles with
        // no type given, by their mix (RUNNING_GEAR): mostly tracked, armor or
        // mechanized forces; mostly wheeled, a supply or motorized column; else
        // both. Never above likely: the running gear alone can't say more,
        // and a sign seen only in hedged reports takes a step off, as ever.
        const geared = at(f => f.guess);
        if (on('vehicles') && geared.length) {
            const tracked = geared.reduce((n, f) => n + f.gear.tracked, 0), wheeled = geared.reduce((n, f) => n + f.gear.wheeled, 0);
            const mix = gearMix(tracked, wheeled);
            const big = geared.filter(f => f.gear.tracked + f.gear.wheeled >= 10);
            const again = geared.filter(f => geared.some(g => g !== f && g.gear.mix === f.gear.mix && Math.abs(g.ms - f.ms) <= 6 * HOUR));
            const moving = geared.filter(advancing).length, halted = geared.filter(f => has(f, 'Stationary')).length;
            const how = moving && moving >= halted ? ['are moving', 'through'] : halted ? ['have', 'halted in'] : ['have', 'in'];
            const size = mix === 'wheeled' ? '' : ` of approximately ${echelonOf('maneuver', Math.max(...geared.map(f => f.gear.tracked)) || 1)} size`;
            const force = {
                tracked: `an armored or mechanized force${size}${wheeled ? ' with its support vehicles' : ''}`,
                wheeled: `a supply or motorized column${tracked ? ' with an armored escort' : ''}`,
                mixed: `a mechanized force${size} with its supply vehicles`,
            }[mix];
            judge('vehicles', Math.min(EVEN + (big.length || again.length ? 1 : 0), LIKELY), `${how[0]} ${force} ${how[1]} ${area}`,
                [[`${andList([tracked && plural(tracked, 'tracked vehicle'), wheeled && plural(wheeled, 'wheeled vehicle')].filter(Boolean))}`
                    + ` with no type given, ${mix === 'mixed' ? 'a mix' : `mostly ${mix}`}`, geared],
                    ['10 vehicles or more in one report (about a company)', big], ['a second report like it within 6 hrs', again],
                    ['the type of vehicle (tank, BMP, truck)', []]], [area], true);
        }
        // A logistics site: supply vehicles halted or resupplying, again and again.
        const supply = densest(at(f => (f.roles.has('logistics') && has(f, 'Stationary')) || has(f, 'Resupplying')), 12 * HOUR);
        if (on('logistics') && supply.length >= 2) {
            judge('logistics', supply.length >= 5 ? VERY_LIKELY : supply.length >= 3 ? LIKELY : EVEN,
                `have a logistics or resupply point in ${area}`,
                [['supply vehicles halted or resupplying within 12 hrs', supply],
                    ['fuel or ammunition vehicles', supply.filter(f => FUEL_AMMO.test(textOf(f)))]], [area]);
        }
        // Counter-battery: radar or counter-battery fire, or drones on guns, with artillery here.
        const cb = at(f => can(f, 'cbRadar'));
        const onGuns = at(f => can(f, 'loitering') && /\b(howitzers?|guns?|batter(y|ies)|artillery|mortars?|mlrs|mrl)\b/i.test(f.r.activity || ''));
        const firesHere = at(firing);
        if (on('counterbattery') && (cb.length || onGuns.length) && (firesHere.length || onGuns.length)) {
            const signs = [['counter-battery radar or counter-battery fire', cb], ['artillery or rocket fire here', firesHere],
                ['loitering munitions or drones striking guns', onGuns]];
            judge('counterbattery', levelBy(kindsOf(signs) + (byTime(signs.flatMap(([, l]) => l)).length >= 4 ? 1 : 0), 3, 4),
                `are conducting counter-battery fire around ${area}`, signs, [area]);
        }
        // Shoot and scoot: artillery firing, then the same type moving within the hour (or displacing as it fires).
        const gunsFiring = at(f => f.roles.has('fires') && shot(f));
        const sameGuns = (a, b) => a.els.some(x => x.kit && x.kit.role === 'fires' && b.els.some(y => y.kit && y.kit.name === x.kit.name));
        const displaced = at(f => f.roles.has('fires') && ((has(f, 'Moving') && gunsFiring.some(g => sameGuns(g, f) && f.ms > g.ms && f.ms - g.ms <= HOUR))
            || (shot(f) && SCOOT.test(f.r.activity || ''))));
        if (on('shootscoot') && displaced.length) {
            judge('shootscoot', levelBy(displaced.length, 2, 3), {
                RU: `are firing and quickly displacing artillery around ${area} ("roving" guns)`,
                CN: `are firing and quickly displacing artillery around ${area}`,
                '': `are firing and quickly displacing artillery around ${area} (shoot and scoot)`,
            }, [['artillery or rockets firing', gunsFiring], ['the same moving within the hour after, or displacing', displaced]], [area]);
        }
        // Mines laid remotely or quickly: minelayers or scatterable mines, with rockets or artillery.
        const mines = at(f => can(f, 'minelaying'));
        if (on('remotemine') && mines.length) {
            const signs = [['minelaying systems or remote mining reported', mines], ['rocket or artillery fire here', firesHere],
                ['armor or mechanized forces nearby', at(isManeuver)]];
            judge('remotemine', levelBy(kindsOf(signs) + (mines.length >= 2 ? 1 : 0), 2, 3), `are laying minefields in ${area}`, signs, [area]);
        }
        // Chemical-defense troops: their vehicles, decontamination, smoke generators.
        const chem = at(f => can(f, 'cbrn'));
        if (on('cbrn') && chem.length) {
            const signs = [['chemical-defense vehicles, decontamination or smoke generators', chem], ['smoke', smoke.filter(f => !chem.includes(f))],
                ['thermobaric weapons', at(f => can(f, 'thermobaric'))]];
            judge('cbrn', levelBy(kindsOf(signs) + (chem.length >= 2 ? 1 : 0), 2, 3), {
                RU: `have chemical-defense (RKhBZ) troops in ${area}, screening with smoke or decontaminating`,
                CN: `have chemical-defense troops in ${area}, screening with smoke or decontaminating`,
                '': `have chemical-defense troops in ${area}, screening with smoke or decontaminating`,
            }, signs, [area]);
        }
        // A counterattack: reported as one, or armor arriving after contact here.
        const contactHere = at(shot);
        const firstContact = at(f => shot(f) && !isManeuver(f)).map(f => f.ms);
        const t0 = firstContact.length ? Math.min(...firstContact) : null;
        const arrivals = t0 === null || at(f => isManeuver(f) && f.ms < t0).length ? []
            : at(f => isManeuver(f) && (advancing(f) || shot(f)) && f.ms > t0 && f.ms - t0 <= 6 * HOUR);
        const counter = at(f => COUNTER.test(f.r.activity || ''));
        if (on('counterattack') && (counter.length || arrivals.length)) {
            const signs = [['a counterattack reported', counter], ['armor or mechanized forces arriving within 6 hrs after contact here', arrivals],
                ['artillery fire in support', firesHere]];
            // The contact the armor arrived after is cited too, though, as in
            // regroup, it adds no strength: the arrivals already count it.
            const last = arrivals.length ? Math.max(...arrivals.map(f => f.ms)) : null;
            const contactBefore = last === null ? [] : at(f => shot(f) && !isManeuver(f) && f.ms <= last);
            judge('counterattack', levelBy(kindsOf(signs), 2, 3),
                counter.length ? `are counterattacking in ${area}` : `are reinforcing or counterattacking in ${area}`,
                [signs[0], ['contact here', contactBefore], ...signs.slice(1)], [area]);
        }
        // Casualty evacuation: ambulances or wounded, after fighting here.
        const cas = at(f => can(f, 'medevac'));
        if (on('casevac') && cas.length) {
            const before = contactHere.filter(c => cas.some(f => f.ms >= c.ms && f.ms - c.ms <= 12 * HOUR));
            judge('casevac', levelBy(cas.length + (before.length ? 1 : 0), 2, 3), `are evacuating casualties from ${area}, a sign of heavy fighting there`,
                [['ambulances, MEDEVAC or wounded reported', cas], ['fighting here within 12 hrs before', before]], [area]);
        }
        // Assault groups in a town: small dismounted groups fighting among buildings, with support.
        const inTown = URBAN.test(area) ? list : at(f => URBAN.test(f.r.activity || ''));
        const stormers = inTown.filter(f => (f.groups.infantry || 0) > 0 && (shot(f) || advancing(f) || has(f, 'Dismounted')));
        if (on('urban') && stormers.length) {
            const signs = [['dismounted groups fighting or moving among buildings', stormers],
                ['tanks, thermobaric weapons or artillery supporting', at(f => f.roles.has('armor') || can(f, 'thermobaric') || firing(f))],
                ['drones overhead', uavs]];
            judge('urban', levelBy(kindsOf(signs) + (stormers.length >= 3 ? 1 : 0), 2, 3), {
                RU: `are assaulting built-up areas in ${area} with small assault groups (shturmovye gruppy)`,
                CN: `are assaulting built-up areas in ${area} with small assault teams`,
                '': `are assaulting built-up areas in ${area} with small assault groups`,
            }, signs, [area]);
        }
        // Reconnaissance in force: a platoon or more firing, then pulling back.
        const probes = at(f => shot(f) && ((f.groups.maneuver || 0) >= 3 || (f.groups.infantry || 0) >= 8));
        const pulled = at(f => WITHDRAW.test(f.r.activity || '') && (probes.includes(f) || after(probes, f, 3 * HOUR)));
        const pulledBack = at(f => f.sense === 'back' && combat(f) && (probes.includes(f) || after(probes, f, 3 * HOUR)));
        if (on('reconforce') && probes.length && (pulled.length || pulledBack.length)) {
            const struck = at(f => firing(f) && after([...pulled, ...pulledBack], f, 6 * HOUR));
            judge('reconforce', EVEN + (struck.length ? 1 : 0) + (probes.length >= 2 ? 1 : 0), {
                RU: `are conducting reconnaissance in force (razvedka boyem) in ${area}, to make friendly positions show themselves`,
                CN: `are conducting reconnaissance in force in ${area}, to make friendly positions show themselves`,
                '': `are conducting reconnaissance in force in ${area}`,
            }, [['a platoon or more firing', probes], ['pulling back within 3 hrs', pulled],
                ...marchSign('moving back along the way of march within 3 hrs', pulledBack), ['artillery on the place within 6 hrs after', struck]], [area]);
        }
        // Infantry building up: small groups halted or hidden here, again and again.
        const lurk = densest(at(f => smallGroup(f) && (has(f, 'Stationary', 'Observing', 'Dismounted') || GATHER.test(f.r.activity || '')) && !advancing(f)), 48 * HOUR);
        if (on('buildup') && lurk.length >= 3) {
            judge('buildup', levelBy(lurk.length, 4, 6), {
                RU: `are building up infantry in ${area}, gathering small groups near the line for an assault`,
                CN: `are building up infantry in ${area}, concentrating small teams near a weak point`,
                '': `are building up small infantry groups in ${area}`,
            }, [['small dismounted groups halted or hidden within 48 hrs', lurk],
                ['gathering in tree lines or buildings', lurk.filter(f => GATHER.test(f.r.activity || ''))],
                ['drones resupplying them', at(f => DRONE_DROP.test(textOf(f)))]], [area]);
        }
        // Delivering an assault group: armor dropping infantry, the infantry going on.
        const drops = at(f => isManeuver(f) && has(f, 'Dismounted'));
        const foot = at(f => (f.groups.infantry || 0) > 0 && (advancing(f) || shot(f)) && drops.some(d => f.ms >= d.ms && f.ms - d.ms <= 2 * HOUR));
        if (on('dismount') && drops.length && foot.length) {
            const cover = at(f => isManeuver(f) && shot(f) && after(drops, f, 2 * HOUR));
            judge('dismount', EVEN + (cover.length ? 1 : 0) + (foot.length >= 2 ? 1 : 0), {
                RU: `are delivering assault infantry by armored group (bronegruppa) in ${area}`,
                CN: `are delivering assault teams by infantry fighting vehicle in ${area}`,
                '': `are delivering assault infantry by armored vehicle in ${area}`,
            }, [['armored vehicles dropping infantry', drops], ['infantry moving or fighting within 2 hrs after', foot],
                ['the vehicles staying to support by fire', cover]], [area]);
        }
        // A strongpoint: two of armor, infantry and antitank weapons holding here for 12 hrs or more.
        const holding = at(f => has(f, 'Stationary', 'Emplacing') && !advancing(f));
        const hArmor = holding.filter(isManeuver), hInf = holding.filter(f => (f.groups.infantry || 0) > 0), hAt = holding.filter(f => f.roles.has('atgm'));
        const held = holding.length ? Math.max(...holding.map(f => f.ms)) - Math.min(...holding.map(f => f.ms)) : 0;
        if (on('strongpoint') && [hArmor, hInf, hAt].filter(l => l.length).length >= 2 && held >= 12 * HOUR) {
            const signs = [['armor or mechanized forces holding', hArmor], ['infantry holding', hInf], ['antitank weapons in position', hAt],
                ['obstacles or mines', obst]];
            judge('strongpoint', levelBy(kindsOf(signs), 3, 4), {
                RU: `are holding a company strongpoint (opornyy punkt) in ${area}`, CN: `are holding a strongpoint in ${area}`,
                '': `are holding a strongpoint in ${area}`,
            }, signs, [area]);
        }
        // Tanks as fire support: firing from halted positions, with no armor advancing here.
        const tankFire = at(f => f.roles.has('armor') && shot(f) && (has(f, 'Stationary') || INDIRECT.test(f.r.activity || ''))
            && !list.some(m => m !== f && isManeuver(m) && advancing(m) && Math.abs(m.ms - f.ms) <= 2 * HOUR));
        if (on('tankfire') && tankFire.length) {
            const assault = at(f => (f.groups.infantry || 0) > 0 && (shot(f) || advancing(f)) && after(tankFire, f, 6 * HOUR));
            judge('tankfire', levelBy(tankFire.length + (assault.length ? 1 : 0), 2, 3), {
                RU: `are using tanks as fire support from halted positions in ${area}, rather than to break through`,
                CN: `are supporting assault groups with tank fire from halted positions in ${area}`,
                '': `are using tanks as fire support from halted positions in ${area}`,
            }, [['tanks firing from halted positions', tankFire], ['infantry assaulting within 6 hrs after', assault]], [area]);
        }
        // Drones cutting the routes: strikes on vehicles or roads here.
        const cuts = densest(at(f => (can(f, 'loitering') || can(f, 'uav')) && ROUTES.test(f.r.activity || '')
            && (shot(f) || STRUCK.test(f.r.activity || ''))), 24 * HOUR);
        if (on('interdict') && cuts.length) {
            judge('interdict', levelBy(cuts.length, 2, 4), {
                RU: `are cutting the routes through ${area} with drones and FPVs`, CN: `are striking the routes and vehicles in ${area} with drones to isolate it`,
                '': `are striking vehicles on the routes through ${area} with drones`,
            }, [['drones or FPVs striking vehicles or roads within 24 hrs', cuts]], [area]);
        }
        // Persistent surveillance: UAVs again and again, with no fire yet.
        const watch = densest(uavs, 12 * HOUR);
        const struckAfter = watch.length && at(f => (firing(f) || can(f, 'loitering')) && !watch.includes(f)
            && f.ms >= watch[0].ms && f.ms <= watch[watch.length - 1].ms + HOUR).length;
        if (on('isr') && watch.length >= 3 && !struckAfter) {
            judge('isr', levelBy(watch.length, 4, 6), `are keeping ${area} under drone surveillance, building up a target for fires or an assault`,
                [['UAVs over it within 12 hrs', watch], ['artillery or strikes following', []]], [area]);
        }
        // Resupply by drone.
        const dropped = at(f => DRONE_DROP.test(textOf(f)) || (can(f, 'uav') && has(f, 'Resupplying')));
        if (on('droneresupply') && dropped.length) {
            judge('droneresupply', levelBy(dropped.length, 2, 3), `are resupplying forward groups in ${area} by drone`,
                [['drones dropping or carrying supplies', dropped], ['small groups holding there', at(f => smallGroup(f) && !advancing(f))]], [area]);
        }
        // A railhead: armor, artillery or supplies on trains here.
        const trains = at(f => RAIL.test(f.r.activity || '') && (isManeuver(f) || f.roles.has('fires') || f.roles.has('logistics') || f.roles.has('ad')));
        if (on('railhead') && trains.length) {
            const unloading = trains.filter(f => has(f, 'Resupplying'));
            judge('railhead', levelBy(trains.length + (unloading.length ? 1 : 0), 2, 3), `are moving forces or supplies by rail through ${area}`,
                [['armor, artillery or supplies on trains or at a railhead', trains], ['loading or unloading', unloading]], [area]);
        }
        // A helicopter refueling point: helicopters on the ground with fuel, or a FARP reported.
        // Fixed-wing aircraft refueling (Su-25s at an airfield) are not one.
        const helos = at(f => can(f, 'helo') && (has(f, 'Stationary', 'Resupplying') || /\b(landed|on the ground)\b/i.test(f.r.activity || '')));
        const farpSaid = at(f => FARP.test(f.r.activity || ''));
        const fuel = at(f => (f.roles.has('logistics') && FUEL_AMMO.test(textOf(f))) || has(f, 'Resupplying'));
        if (on('farp') && ((helos.length && fuel.length) || farpSaid.length)) {
            const signs = [['helicopters on the ground', helos], ['fuel or supply vehicles, or rearming', fuel], ['a FARP or landing site reported', farpSaid],
                ['air defense in place', adStill]];
            judge('farp', levelBy(kindsOf(signs), 3, 4), `have a forward arming and refueling point for helicopters in ${area}`, signs, [area]);
        }
        // Regrouping: halted, resupplying or recovering vehicles within 24 hrs after contact here.
        const later = at(f => after(contactHere, f, 24 * HOUR));
        const regroup = [['armor or infantry halted', later.filter(f => (isManeuver(f) || (f.groups.infantry || 0) > 0) && has(f, 'Stationary'))],
            ['resupplying', later.filter(f => has(f, 'Resupplying'))], ['vehicles recovered or towed', later.filter(f => can(f, 'recovery'))]];
        if (on('regroup') && kindsOf(regroup) >= 2) {
            judge('regroup', levelBy(kindsOf(regroup) + (byTime(regroup.flatMap(([, l]) => l)).length >= 4 ? 1 : 0), 3, 4),
                `are regrouping in ${area} after the fighting there`, [['contact here', contactHere], ...regroup], [area]);
        }
        // The team's own rules: their words, often enough, in one place.
        custom.forEach(c => {
            const re = ruleWords(c.words);
            const hits = densest(at(f => re.test(textOf(f))), c.hours * HOUR);
            if (hits.length < c.min) return;
            judge('custom', EVEN + (hits.length >= c.min + 1 ? 1 : 0) + (hits.length >= c.min + 3 ? 1 : 0), `${c.what} in ${area}`,
                [[`reports of ${c.words.split(',').map(w => w.trim()).filter(Boolean).join(', ')} within ${c.hours} hrs`, hits]], [area]);
        });
    }

    // Preparing an offensive: artillery, air defense moving, armor massing,
    // engineers moving, EW, contact; at least two of them, one being
    // artillery or the massing.
    let focus = null, mass = [];
    for (const [area, list] of byArea) {
        const m = densest(list.filter(isManeuver), 12 * HOUR);
        if (m.length > mass.length) { mass = m; focus = area; }
    }
    if (mass.length < 3) { mass = []; focus = null; }
    const fires = facts.filter(f => f.roles.has('fires'));
    const ewAll = facts.filter(ewOf);
    const offense = [
        ['artillery or rockets', fires],
        ['air defense moving', facts.filter(f => f.roles.has('ad') && has(f, 'Moving'))],
        [focus ? `armor or mechanized forces massing in ${focus} within 12 hrs` : 'armor or mechanized forces massing', mass],
        ['engineers moving, or breaching and bridging', facts.filter(f => (f.roles.has('engineer') && has(f, 'Moving')) || can(f, 'breaching') || can(f, 'bridging'))],
        ['electronic warfare', ewAll],
        ['contact by armor or mechanized forces', facts.filter(f => isManeuver(f) && shot(f))],
        ...marchSign('armor or mechanized forces moving along the way of march', facts.filter(f => isManeuver(f) && advancing(f) && along(f))),
    ];
    const kinds = kindsOf(offense);
    if (on('offense') && kinds >= 2 && (fires.length || mass.length)) {
        judge('offense', kinds >= 4 ? VERY_LIKELY : kinds === 3 ? LIKELY : EVEN,
            `are preparing offensive operations${focus ? `, centered on ${focus}` : ''}`, offense);
    }
    // Several axes: armor or mechanized forces moving in two or more places within 6 hours.
    const moving = facts.filter(f => isManeuver(f) && advancing(f) && f.areas.length);
    let axes = [];
    moving.forEach(f => {
        const w = moving.filter(g => g.ms >= f.ms && g.ms - f.ms <= 6 * HOUR);
        if (new Set(w.flatMap(g => g.areas)).size > new Set(axes.flatMap(g => g.areas)).size) axes = w;
    });
    const axisNames = [...new Set(axes.flatMap(g => g.areas))];
    if (on('axes') && axisNames.length >= 2) {
        const named = axisNames.slice(0, 4).join(', ');
        const onward = axes.filter(along);
        judge('axes', levelBy(axisNames.length + (onward.length ? 1 : 0), 3, 4), {
            RU: `are advancing on more than one axis (${named}), likely a main effort and supporting attacks`,
            CN: `are advancing in more than one direction (${named}), likely converging assault groups`,
            '': `are advancing on more than one axis (${named})`,
        }, [['armor or mechanized forces moving in different places within 6 hrs', axes], ...marchSign('moving along the way of march', onward)], axisNames);
    }
    // Small dismounted groups moving or observing, again and again.
    const small = densest(facts.filter(f => smallGroup(f) && has(f, 'Moving', 'Observing', 'Dismounted')), 12 * HOUR);
    if (on('infiltration') && small.length >= 2) {
        const where = mostIn(small);
        judge('infiltration', levelBy(small.length, 3, 5), {
            RU: `are infiltrating small dismounted groups${where ? ` through ${where}` : ''} (assault groups seeping through gaps, or sabotage-reconnaissance groups, DRG)`,
            CN: `are infiltrating small dismounted groups${where ? ` through ${where}` : ''} (special operations or reconnaissance teams)`,
            '': `are infiltrating small dismounted groups${where ? ` through ${where}` : ''}`,
        }, [['small dismounted groups moving or observing within 12 hrs', small]]);
    }
    // A second echelon or reserve: armor halted in one place during contact in another.
    // Elsewhere is a named place (NAI, OBJ, phase line) or a grid square other
    // than the reserve's; contact with no place at all could be anywhere, so
    // it doesn't count.
    const contact = facts.filter(f => shot(f));
    const elsewhere = (c, area) => { const where = [...c.areas, ...c.pls]; return where.length > 0 && !where.includes(area); };
    let reserve = [], reserveAt = null;
    for (const [area, list] of byArea) {
        const held = list.filter(f => isManeuver(f) && has(f, 'Stationary')
            && contact.some(c => elsewhere(c, area) && Math.abs(c.ms - f.ms) <= 6 * HOUR));
        if (held.length > reserve.length) { reserve = held; reserveAt = area; }
    }
    if (on('reserve') && reserve.length) {
        const fights = contact.filter(c => elsewhere(c, reserveAt) && reserve.some(f => Math.abs(c.ms - f.ms) <= 6 * HOUR));
        const big = reserve.reduce((n, f) => n + (f.groups.maneuver || 0), 0) >= 10 || reserve.length >= 2;
        judge('reserve', EVEN + (big ? 1 : 0), {
            RU: `are holding a second echelon or reserve in ${reserveAt}`,
            CN: `are holding a reserve in ${reserveAt}, ready to exploit or counterattack`,
            '': `are holding a reserve in ${reserveAt}`,
        }, [['contact elsewhere', fights], ['armor or mechanized forces halted away from it', reserve]], [reserveAt]);
    }
    // Massed fires: artillery or rocket fire twice or more in 3 hours; an
    // assault following makes it a preparation.
    const salvo = densest(facts.filter(firing), 3 * HOUR);
    if (on('artillery') && salvo.length >= 2) {
        const last = salvo[salvo.length - 1].ms;
        const follow = facts.filter(f => isManeuver(f) && has(f, 'Moving') && f.ms >= salvo[0].ms && f.ms - last <= 6 * HOUR);
        const where = mostIn(salvo), centered = where ? `, centered on ${where}` : '';
        judge('artillery', levelBy(salvo.length + (follow.length ? 1 : 0), 3, 4), follow.length ? {
            RU: `are conducting an artillery preparation ahead of an assault${centered}`, CN: `are conducting a fire strike ahead of an assault${centered}`,
            '': `are firing to prepare an assault${centered}`,
        } : {
            RU: `are conducting massed artillery fires${centered}`, CN: `are conducting a fire strike with artillery and rockets${centered}`,
            '': `are conducting massed artillery fires${centered}`,
        }, [['artillery or rocket fire within 3 hrs', salvo], ['rocket launchers among them', salvo.filter(f => can(f, 'mrl'))],
            ['armor or mechanized forces moving after it', follow]]);
    }
    // Long-range strikes, loitering munitions, attack aviation, EW: how often they're reported.
    const deep = facts.filter(f => can(f, 'deep'));
    if (on('deep') && deep.length) {
        judge('deep', levelBy(deep.length, 2, 3), {
            RU: 'are preparing or conducting deep strikes with long-range rockets or missiles',
            CN: 'are preparing or conducting long-range strikes as part of a joint fire strike',
            '': 'are preparing or conducting long-range strikes',
        }, [['long-range rockets or missiles', deep], ['UAVs finding targets in depth', facts.filter(f => can(f, 'uav'))]]);
    }
    const drones = facts.filter(f => can(f, 'loitering'));
    if (on('drones') && drones.length) {
        judge('drones', levelBy(drones.length, 2, 4), 'are striking with loitering munitions or drones',
            [['loitering munitions, FPV or armed drones', drones], ['UAVs finding targets for them', facts.filter(f => can(f, 'uav'))]]);
    }
    const air = facts.filter(f => can(f, 'attackAir'));
    if (on('aviation') && air.length) {
        judge('aviation', levelBy(air.length, 2, 4), 'are supporting ground forces with attack aviation',
            [['attack helicopters, ground-attack aircraft or armed UAVs', air], ['a ground attack at the same time', facts.filter(f => isManeuver(f) && shot(f))]]);
    }
    if (on('ew') && ewAll.length) {
        const where = mostIn(ewAll), near = where ? ` near ${where}` : '';
        judge('ew', levelBy(ewAll.length, 2, 4), {
            RU: `are jamming communications, GPS and drones${near}`,
            CN: `are attacking command, communications and sensors with electronic warfare${near}`,
            '': `are conducting electronic warfare${near}`,
        }, [['EW systems or jamming reported', ewAll],
            ['an attack following it', facts.filter(f => isManeuver(f) && (advancing(f) || shot(f)) && ewAll.some(e => f.ms > e.ms && f.ms - e.ms <= 6 * HOUR))]]);
    }
    // Withdrawal, when reports say so, or forces move back along the way of march.
    const back = facts.filter(f => WITHDRAW.test(f.r.activity || ''));
    const backAlong = facts.filter(f => f.sense === 'back' && combat(f));
    if (on('withdrawal') && (back.length || backAlong.length)) {
        const n = byTime([...back, ...backAlong]).length;
        judge('withdrawal', n >= 3 ? VERY_LIKELY : n === 2 ? LIKELY : EVEN, 'are withdrawing',
            [['withdrawal or breaking contact reported', back], ...marchSign('moving back along the way of march', backAlong),
                ['covering forces left behind', []], ['obstacles or demolitions behind them', []]]);
    }
    // Firing: probing with small elements, or attacking with a company or more.
    const shots = facts.filter(f => shot(f));
    const bigShots = shots.filter(f => (f.groups.maneuver || 0) >= 10 || (f.groups.infantry || 0) >= 30);
    if (on('firing') && bigShots.length) {
        judge('firing', bigShots.length >= 2 ? VERY_LIKELY : LIKELY, 'are attacking with company-sized or larger elements',
            [['firing by a company or more', bigShots], ['artillery fire in support', []]]);
    } else if (on('firing') && shots.length >= 2) {
        judge('firing', shots.length >= 4 ? VERY_LIKELY : shots.length === 3 ? LIKELY : EVEN,
            'are probing friendly positions with small elements',
            [['firing by elements smaller than a company', shots], ['larger elements following up', []], ['artillery fire in support', []]]);
    }
    // Fixing: contact in one place while armor moves in another within 3 hrs.
    let fixAt = null, fixMovers = [], fixContact = [];
    for (const [area, list] of byArea) {
        const c = list.filter(shot);
        const m = facts.filter(f => isManeuver(f) && advancing(f) && f.areas.length && !f.areas.includes(area)
            && c.some(x => Math.abs(x.ms - f.ms) <= 3 * HOUR));
        if (m.length > fixMovers.length) { fixMovers = m; fixAt = area; fixContact = c.filter(x => m.some(f => Math.abs(x.ms - f.ms) <= 3 * HOUR)); }
    }
    if (on('fixing') && fixMovers.length) {
        const main = mostIn(fixMovers);
        const signs = [[`contact in ${fixAt}`, fixContact], ['armor or mechanized forces moving elsewhere within 3 hrs', fixMovers],
            [`artillery fire on ${fixAt}`, (byArea.get(fixAt) || []).filter(firing)]];
        judge('fixing', levelBy(kindsOf(signs) + (fixMovers.reduce((n, f) => n + (f.groups.maneuver || 0), 0) >= 10 ? 1 : 0), 3, 4), {
            RU: `are fixing friendly forces in ${fixAt}, with armor moving through ${main} at the same time`,
            CN: `are fixing friendly forces in ${fixAt} ('one point, two sides'), with armor moving through ${main} at the same time`,
            '': `are fixing friendly forces in ${fixAt}, with armor moving through ${main} at the same time`,
        }, signs, [fixAt, main]);
    }
    // Exploitation: contact in one place, then armor through it and on into places quiet until then.
    let exp = null;
    for (const [area, list] of byArea) {
        list.filter(shot).forEach(c => {
            const through = list.filter(f => isManeuver(f) && advancing(f) && f.ms > c.ms && f.ms - c.ms <= 12 * HOUR);
            if (!through.length) return;
            const t1 = Math.min(...through.map(f => f.ms));
            const quiet = (a) => a !== area && !(byArea.get(a) || []).some(g => g.ms < c.ms);
            const beyond = facts.filter(f => isManeuver(f) && advancing(f) && f.ms >= t1 && f.ms - t1 <= 12 * HOUR && f.areas.some(quiet));
            const fresh = [...new Set(beyond.flatMap(f => f.areas.filter(quiet)))];
            if (fresh.length && (!exp || fresh.length > exp.fresh.length)) exp = { area, c, through, beyond, fresh };
        });
    }
    if (on('exploit') && exp) {
        const into = exp.fresh.slice(0, 3).join(', ');
        const onward = byTime([...exp.through, ...exp.beyond]).filter(along);
        judge('exploit', levelBy(exp.fresh.length + (onward.length ? 1 : 0), 2, 3), {
            RU: `are exploiting a breakthrough at ${exp.area}, pushing armor on into ${into} (a forward detachment or second echelon)`,
            CN: `are exploiting a breakthrough at ${exp.area}, pushing depth-attack groups on into ${into}`,
            '': `are exploiting a breakthrough at ${exp.area}, pushing armor on into ${into}`,
        }, [[`contact in ${exp.area}`, [exp.c]], [`armor moving through ${exp.area} within 12 hrs`, exp.through],
            ['armor moving on into places with no reports before it', exp.beyond], ...marchSign('moving along the way of march', onward)], [exp.area, ...exp.fresh]);
    }
    // Envelopment: flanking reported, or forces pressing in three or more 10 km squares around one.
    const flanking = facts.filter(f => FLANK.test(f.r.activity || ''));
    const pressing = facts.filter(f => (isManeuver(f) || (f.groups.infantry || 0) > 0) && (advancing(f) || shot(f)));
    let ring = null;
    pressing.forEach(f => {
        const cells = new Map();
        pressing.filter(g => g.ms >= f.ms && g.ms - f.ms <= 24 * HOUR).forEach(g => g.areas.forEach(a => {
            const m = SQUARE.exec(a);
            if (!m) return;
            if (!cells.has(a)) cells.set(a, { zone: m[1], e: +m[2], n: +m[3], list: [] });
            cells.get(a).list.push(g);
        }));
        const all = [...cells.values()];
        all.forEach(c0 => {
            for (let e = Math.max(0, c0.e - 1); e <= Math.min(9, c0.e + 1); e++) {
                for (let n = Math.max(0, c0.n - 1); n <= Math.min(9, c0.n + 1); n++) {
                    const around = all.filter(c => c.zone === c0.zone && Math.max(Math.abs(c.e - e), Math.abs(c.n - n)) === 1);
                    const center = `${c0.zone} ${e}${n}`;
                    if (around.length >= 3 && (!ring || around.length > ring.around.length || (around.length === ring.around.length && center < ring.center))) {
                        ring = { center, around };
                    }
                }
            }
        });
    });
    if (on('encircle') && (flanking.length || ring)) {
        const where = ring ? ring.center : mostIn(flanking);
        const around = ring ? byTime(ring.around.flatMap(c => c.list)) : [];
        // Across the way of march: of the forces around it, or pressing within 24 hrs of the flanking reported.
        const across = (ring ? around : pressing.filter(f => flanking.some(g => Math.abs(g.ms - f.ms) <= 24 * HOUR))).filter(f => f.sense === 'across');
        judge('encircle', EVEN + (ring && ring.around.length >= 4 ? 1 : 0) + (ring && flanking.length ? 1 : 0) + (across.length ? 1 : 0), {
            RU: `are enveloping or encircling${where ? ` ${where}` : ' friendly positions'}, to cut it off (a pocket, kotyol)`,
            CN: `are splitting and encircling${where ? ` ${where}` : ' friendly positions'}, to isolate it`,
            '': `are enveloping or encircling${where ? ` ${where}` : ' friendly positions'}`,
        }, [['flanking, envelopment or encirclement reported', flanking],
            [ring ? `forces moving or fighting in ${ring.around.length} squares around ${ring.center} within 24 hrs` : 'forces moving or fighting on several sides of one place', around],
            ...marchSign('moving across the way of march', across)],
        where ? [where] : null);
    }
    // Pursuit, when reports say so.
    const chase = densest(facts.filter(f => PURSUIT.test(f.r.activity || '') && (isManeuver(f) || f.roles.has('light') || (f.groups.infantry || 0) > 0)), 6 * HOUR);
    if (on('pursuit') && chase.length) {
        const where = mostIn(chase), onward = chase.filter(along);
        judge('pursuit', levelBy(chase.length + (onward.length ? 1 : 0), 2, 4), `are pursuing${where ? ` through ${where}` : ''}`,
            [['pursuit reported within 6 hrs', chase], ...marchSign('moving along the way of march', onward)]);
    }
    // A fortified line: digging in, obstacles or engineers in three or more places within 48 hrs.
    const works = densest(facts.filter(f => has(f, 'Emplacing') || OBSTACLE.test(f.r.activity || '') || (f.roles.has('engineer') && has(f, 'Stationary'))), 48 * HOUR);
    const workAreas = [...new Set(works.flatMap(f => f.areas))];
    if (on('fortline') && workAreas.length >= 3) {
        const line = workAreas.slice(0, 4).join(', ');
        judge('fortline', levelBy(workAreas.length, 4, 5), {
            RU: `are building a fortified line in depth across ${line}`, CN: `are preparing a positional defense in depth across ${line}`,
            '': `are building a fortified line across ${line}`,
        }, [['digging in, obstacles or engineers within 48 hrs', works],
            ["tank ditches, dragon's teeth or trenches", works.filter(f => /\b(ditch(es)?|dragon'?s teeth|trench\w*|pyramids|hedgehogs)\b/i.test(f.r.activity || ''))]],
        workAreas);
    }
    // A screen: reconnaissance or small groups halted or observing in two or more places within 6 hrs.
    const lookouts = facts.filter(f => (f.roles.has('recon') || smallGroup(f)) && !can(f, 'uav') && has(f, 'Stationary', 'Observing') && !advancing(f) && f.areas.length);
    let scr = [];
    lookouts.forEach(f => {
        const w = lookouts.filter(g => g.ms >= f.ms && g.ms - f.ms <= 6 * HOUR);
        if (new Set(w.flatMap(g => g.areas)).size > new Set(scr.flatMap(g => g.areas)).size) scr = w;
    });
    const scrAreas = [...new Set(scr.flatMap(g => g.areas))];
    if (on('screen') && scrAreas.length >= 2) {
        const behind = facts.filter(f => (has(f, 'Emplacing') || OBSTACLE.test(f.r.activity || '')) && f.areas.some(a => !scrAreas.includes(a))
            && f.ms >= scr[0].ms - 12 * HOUR && f.ms <= scr[scr.length - 1].ms + 12 * HOUR);
        const along = scrAreas.slice(0, 4).join(', ');
        judge('screen', levelBy(scrAreas.length + (behind.length ? 1 : 0), 4, 5), {
            RU: `are holding a security zone along ${along}, ahead of their main defense`,
            CN: `are holding a screen of security elements along ${along}, ahead of their main defense`,
            '': `are holding a screen along ${along}`,
        }, [['reconnaissance or small groups halted or observing in different places within 6 hrs', scr], ['a defense being prepared behind them', behind]], scrAreas);
    }
    // Light vehicles: motorcycles, buggies or cars moving or fighting, again and again.
    const riders = densest(facts.filter(f => (f.roles.has('light') || LIGHT_WORDS.test(textOf(f))) && (advancing(f) || shot(f) || has(f, 'Dismounted'))), 12 * HOUR);
    if (on('lightassault') && riders.length >= 2) {
        const where = mostIn(riders), via = where ? ` through ${where}` : '';
        const signs = [['motorcycles, buggies or light vehicles moving or fighting within 12 hrs', riders],
            ['infantry with them', riders.filter(f => (f.groups.infantry || 0) > 0)],
            ['drones overhead', facts.filter(f => can(f, 'uav') && riders.some(r => Math.abs(r.ms - f.ms) <= 2 * HOUR))]];
        judge('lightassault', levelBy(riders.length + (kindsOf(signs) >= 3 ? 1 : 0), 3, 5), {
            RU: `are moving assault groups fast on motorcycles, buggies and light vehicles${via}`,
            CN: `are moving fast and dispersed on light vehicles${via}`,
            '': `are moving fast in small groups on light vehicles${via}`,
        }, signs);
    }
    // Thermobaric fires, and an assault after them.
    const therm = facts.filter(f => can(f, 'thermobaric'));
    if (on('thermobaric') && therm.length) {
        const where = mostIn(therm);
        const assault = facts.filter(f => (isManeuver(f) || (f.groups.infantry || 0) > 0) && (advancing(f) || shot(f)) && after(therm, f, 6 * HOUR)
            && (!where || f.areas.includes(where)));
        judge('thermobaric', levelBy(therm.length + (assault.length ? 1 : 0), 2, 3), {
            RU: `are using thermobaric weapons${where ? ` on ${where}` : ''} (TOS or Shmel), usually just before an assault`,
            CN: `are using thermobaric or incendiary weapons${where ? ` on ${where}` : ''} against fortified positions`,
            '': `are using thermobaric weapons${where ? ` on ${where}` : ''}`,
        }, [['thermobaric launchers or flamethrowers', therm], ['an assault there within 6 hrs after', assault]]);
    }
    // Glide bombs, and an assault after them.
    const bombs = densest(facts.filter(f => can(f, 'glideBomb')), 24 * HOUR);
    if (on('glidebomb') && bombs.length) {
        const where = mostIn(bombs);
        const assault = facts.filter(f => (isManeuver(f) || (f.groups.infantry || 0) > 0) && (advancing(f) || shot(f)) && after(bombs, f, 12 * HOUR)
            && (!where || f.areas.includes(where)));
        judge('glidebomb', levelBy(bombs.length + (assault.length ? 1 : 0), 2, 4),
            assault.length ? `are striking${where ? ` ${where}` : ''} with glide bombs ahead of an assault` : `are striking${where ? ` ${where}` : ''} with glide bombs`,
            [['glide or guided bombs within 24 hrs', bombs], ['an assault there within 12 hrs after', assault]]);
    }
    // Strikes on command posts, radars and communications.
    const striking = (f) => firing(f) || can(f, 'deep') || can(f, 'loitering') || can(f, 'attackAir') || can(f, 'glideBomb');
    const blinds = densest(facts.filter(f => striking(f) && C2_TARGETS.test(f.r.activity || '')), 24 * HOUR);
    if (on('c2strike') && blinds.length) {
        judge('c2strike', levelBy(blinds.length, 2, 4), {
            RU: 'are striking command posts, radars and communications, to blind the defense',
            CN: 'are striking command, communications and sensors (system destruction warfare)',
            '': 'are striking command posts, radars and communications',
        }, [['strikes on command posts, radars or communications within 24 hrs', blinds],
            ['EW at the same time', ewAll.filter(e => blinds.some(b => Math.abs(b.ms - e.ms) <= 6 * HOUR))]]);
    }
    // Suppressing air defense: anti-radiation weapons, or strikes on radars and SAMs.
    const suppress = facts.filter(f => can(f, 'sead') || (striking(f) && /\b(radars?|sams?|air defen[cs]e)\b/i.test(f.r.activity || '')));
    if (on('sead') && suppress.length) {
        const jam = ewAll.filter(e => suppress.some(s => Math.abs(s.ms - e.ms) <= 6 * HOUR));
        judge('sead', levelBy(suppress.length + (jam.length ? 1 : 0), 2, 3), 'are suppressing friendly air defense',
            [['anti-radiation weapons, or strikes on radars and air defense', suppress], ['EW at the same time', jam],
                ['decoy drones', facts.filter(f => can(f, 'deception') && (can(f, 'uav') || can(f, 'loitering')))]]);
    }
    // Logistics moving forward, with armor massing or with fuel and ammunition.
    const convoys = densest(facts.filter(f => f.roles.has('logistics') && advancing(f)), 12 * HOUR);
    const fuelAmmo = convoys.filter(f => FUEL_AMMO.test(textOf(f)));
    const forwardOn = convoys.filter(along);
    if (on('logforward') && convoys.length >= 2 && (mass.length || fuelAmmo.length || forwardOn.length)) {
        const signs = [['supply vehicles moving within 12 hrs', convoys], ['fuel or ammunition among them', fuelAmmo],
            [focus ? `armor or mechanized forces massing in ${focus}` : 'armor or mechanized forces massing', mass],
            ...marchSign('moving forward along the way of march', forwardOn)];
        judge('logforward', levelBy(kindsOf(signs) + (convoys.length >= 4 ? 1 : 0), 3, 4), {
            RU: `are pushing fuel and ammunition forward${focus ? ` toward ${focus}` : ''}, as before an attack`,
            CN: `are pushing fuel and ammunition forward${focus ? ` toward ${focus}` : ''}, as before an attack`,
            '': `are pushing supplies forward${focus ? ` toward ${focus}` : ''}`,
        }, signs);
    }
    return out.sort((x, y) => y.level - x.level || y.list.length - x.list.length || x.order - y.order || x.key.localeCompare(y.key));
};

// Which army's equipment some reports hold: vehicles of Russian and of
// Chinese design (identified types only), and which there is more of.
const originCounts = (list) => {
    const n = { RU: 0, CN: 0 };
    list.forEach(f => f.els.forEach(e => { if (e.kit && e.kit.origin in n) n[e.kit.origin] += e.count; }));
    return n;
};
const originOf = (n) => (n.RU || n.CN ? (n.RU >= n.CN ? 'RU' : 'CN') : '');

// The units a judgment can be put down to: those whose places include one
// it is about (none listed: anywhere) and, when kinds are listed, that have a
// kind of equipment in its reports. Places match regardless of case.
const unitsFor = (j, units) => {
    const at = new Set(j.places.map(p => p.toUpperCase()));
    return units.filter(u => (!u.places.length || u.places.some(p => at.has(p.toUpperCase())))
        && (!u.kinds.length || u.kinds.some(k => j.list.some(f => f.roles.has(k)))));
};
// "A, B or C" and "A, B and C".
const wordList = (names, word) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} ${word} ${names[names.length - 1]}`);
const orList = (names) => wordList(names, 'or');
const andList = (names) => wordList(names, 'and');

// The narrative's settings as the rules use them, with what's unset filled
// in. Settings come from a file or the server, so each value is made the
// kind the rules need (a count typed as "2" is 2; words given as a list are
// one comma-separated line), and an entry that still makes no sense is left out.
const narrativeSettings = (s) => {
    s = s && typeof s === 'object' ? s : {};
    const list = (v) => (Array.isArray(v) ? v : []);
    const text = (v) => (Array.isArray(v) ? v.map(String).join(', ') : v == null || typeof v === 'object' ? '' : String(v)).trim();
    return {
        enemy: text(s.enemy) || 'enemy forces',
        units: list(s.units).filter(u => u && text(u.name)).map(u => ({ name: text(u.name), places: list(u.places).map(text).filter(Boolean), kinds: list(u.kinds).map(text).filter(Boolean) })),
        team: teamEquipment(list(s.equipment).filter(e => e && text(e.type) && text(e.role)).map(e => ({ type: text(e.type), role: text(e.role), origin: text(e.origin) }))),
        off: new Set(list(s.off)),
        // The AO's way of march: the direction the enemy moves toward, or '' for none.
        toward: HEADINGS_8.includes(text(s.toward).toUpperCase()) ? text(s.toward).toUpperCase() : '',
        custom: list(s.custom).filter(c => c && typeof c === 'object')
            .map(c => ({ what: text(c.what), words: text(c.words), min: Number(c.min), hours: Number(c.hours) }))
            .filter(c => c.what && c.words.split(',').some(w => w.trim()) && Number.isFinite(c.min) && c.min > 0 && Number.isFinite(c.hours) && c.hours > 0),
    };
};

// Confidence in a judgment, from how many reports and observers support it
// and whether each has a grid: high, moderate, or low.
const confidenceOf = (list) => {
    const who = new Set(list.map(f => f.who).filter(Boolean)).size;
    const level = list.length >= 4 && who >= 2 && list.every(f => f.a.points.length) ? 'high'
        : list.length >= 3 || (list.length >= 2 && who >= 2) ? 'moderate' : 'low';
    return `${level} (${plural(list.length, 'report')}${who ? ` from ${plural(who, 'observer')}` : ''})`;
};

// The groups the assessment shows judgments in, as the settings list the
// rules (Maneuver, Defense, Fires, Support); the team's own rules apart.
const RULE_GROUP = Object.fromEntries(NARRATIVE_RULES.map(([id, , , group]) => [id, group]));
const groupOf = (rule) => RULE_GROUP[rule] || 'Team rules';
const LETTER = (i) => String.fromCharCode(97 + i);
// The combat support the bottom line names beside the force, in short words.
const SUPPORT_WORD = { recon: 'recon', fires: 'artillery', ad: 'air defense', atgm: 'antitank weapons', engineer: 'engineers', c2: 'command vehicles', ew: 'EW', air: 'aviation' };

// The narrative's sections, for the reports in the period (`cur`, in time
// order) and the period before (`prev`, or null). `settings` are the team's
// (what the enemy is called, units, equipment, rules: narrativeSettings).
// `overlays` give the axes of advance. Gives { lines, judgments, annex }:
// the lines; for each judgment shown its rule, the index of the last line
// of its one-line entry in the assessment, the lines of its detail in the
// annex ([from, to), after its first sentence) and the reports behind it
// (summaryDetail); and the annex's lines ([from, to), its heading first),
// or null.
//
// The order is the reader's: a bottom line up front (the strongest
// judgment, and the strongest of another kind in other places, so a
// defense here and an attack there read as one picture; the force's size,
// the activity and its trend, the latest report, what to watch for, the
// first gap), then the situation (what the reports say), the enemy forces
// (what was seen, by kind), the assessment (one line a judgment, grouped),
// what to watch for, the gaps and the collection they call for, and an
// annex with each judgment's basis, doctrine, unit and confidence.
const narrativeLines = (cur, prev, { local, hrs, end, places, settings, overlays = [], width = 100 }) => {
    const set = narrativeSettings(settings);
    const axes = axesOf(overlays);
    const march = set.toward || axes.length ? { axes, toward: set.toward } : null;
    const facts = cur.map(f => narrativeFacts(f, set.team, march));
    const out = [], shown = [];
    const say = (text, first = '   ', rest = first) => out.push(...wrapText(text, first, rest, width));
    const item = (text) => say(text, '   - ', '     ');
    const bluf = (text) => say(text, '      ', '      ');
    const cite = (list, max = 4) => {
        const l = byTime(list);
        return l.slice(0, max).map(f => `${f.hedged ? `${f.hedged} ` : ''}${f.id} ${dayTime(f.ms, local)}`).join(', ') + (l.length > max ? ` and ${l.length - max} more` : '');
    };
    const prevNote = prev ? ` (previous ${hrs} hrs: ${prev.length})` : '';

    if (!facts.length) {
        say(`No reports in this period${prevNote}.`, 'BLUF: ', '      ');
        out.push('', '1. SITUATION');
        say(`No reports in this period${prevNote}.`);
        out.push('', '2. ENEMY FORCES', '   None reported.', '', '3. ASSESSMENT', '   None: no reports to assess.', '');
        return { lines: out, judgments: shown, annex: null };
    }

    // --- What the reports say, worked out first: the bottom line needs it ---
    const who = new Set(facts.map(f => f.who).filter(Boolean)).size;
    const placed = facts.filter(f => f.places.length).length;
    // The equipment, by role, with the types reported and how many.
    const roles = new Map(), unknown = new Map(), kitOf = new Map();
    facts.forEach(f => f.els.forEach(e => {
        if (!e.kit) { unknown.set(e.type, (unknown.get(e.type) || 0) + 1); return; }
        if (!roles.has(e.kit.role)) roles.set(e.kit.role, new Map());
        const types = roles.get(e.kit.role);
        // "10x wheeled vics" and "1x wheeled" are counted as one.
        const type = RUNNING_GEAR[e.kit.name] ? e.kit.name : e.type;
        types.set(type, (types.get(type) || 0) + e.count);
        kitOf.set(type, e.kit);
    }));
    const label = Object.fromEntries(EQUIPMENT_ROLES);
    const roleList = EQUIPMENT_ROLES.map(([r]) => r).filter(r => roles.has(r));
    const origins = originCounts(facts), army = originOf(origins);
    // The largest single sighting of each kind, and the unit size it suggests.
    const largest = Object.keys(ECHELONS).map(kind => {
        const top = facts.filter(f => f.groups[kind]).sort((x, y) => y.groups[kind] - x.groups[kind] || y.ms - x.ms)[0];
        return top && { kind, text: `${ECHELON_LABEL[kind]} approximately ${echelonOf(kind, top.groups[kind])} size (${top.shown}; ${top.id} ${dayTime(top.ms, local)}${top.places.length ? `, ${top.places.join(', ')}` : ''})` };
    }).filter(Boolean);
    const at = (p) => facts.filter(f => f.places.includes(p));

    // The ten strongest judgments, grouped as the settings list the rules;
    // a group comes where its strongest judgment does, so the first is the
    // strongest of all. Each is lettered in the order shown.
    const all = narrativeJudgments(facts, cite, set), top = all.slice(0, 10);
    const groups = [...new Set(top.map(j => groupOf(j.rule)))];
    const judged = groups.flatMap(g => top.filter(j => groupOf(j.rule) === g)).map((j, i) => {
        const [term, pct] = ICD203[j.level];
        // Said of a unit when one to three in the unit list fit, else of the enemy.
        const units = unitsFor(j, set.units);
        const whom = units.length && units.length <= 3 ? `elements of ${orList(units.map(u => u.name))}` : set.enemy;
        const own = originCounts(j.list), mine = originOf(own), o = mine || army;
        const what = typeof j.what === 'string' ? j.what : j.what[o] || j.what[''];
        const confidence = confidenceOf(j.list);
        return { j, letter: LETTER(i), group: groupOf(j.rule), term, pct, units, whom, own, mine, o, what, confidence, sure: confidence.split(' ')[0] };
    });
    // What to watch for, once each, with the judgments it would firm up.
    const watch = new Map();
    judged.forEach(x => x.j.watch.forEach(w => { if (!watch.has(w)) watch.set(w, []); watch.get(w).push(x.letter); }));
    const watchList = [...watch].map(([w, ls]) => `${w} (${ls.join(', ')})`);

    // What the reports leave open, and the collection it calls for: places
    // gone quiet (in a period of 12 hours or more), judgments resting on
    // too little, reports without a grid, types the catalogue doesn't know.
    // The places gone quiet are one gap, the quietest first; the bottom line
    // names three of them.
    const gaps = [];
    let quietBrief = '';
    const span = hrs !== null && hrs !== undefined ? hrs : (end - facts[0].ms) / HOUR;
    if (span >= 12) {
        const quiet = places.map(p => [p.label, at(p.label).pop()]).filter(([, f]) => f && end - f.ms >= 6 * HOUR)
            .sort((x, y) => x[1].ms - y[1].ms || x[0].localeCompare(y[0])).map(([p, f]) => `${p} (since ${dayTime(f.ms, local)})`);
        if (quiet.length) {
            gaps.push(`No reports for 6 hrs or more: ${andList(quiet)}. Re-task collection there.`);
            quietBrief = `No reports for 6 hrs or more: ${quiet.length > 3 ? `${quiet.slice(0, 3).join(', ')} and ${quiet.length - 3} more` : andList(quiet)}. Re-task collection there.`;
        }
    }
    judged.filter(x => x.j.level >= LIKELY && x.sure === 'low').slice(0, 3).forEach(x => {
        gaps.push(`${x.letter}: low confidence (${plural(x.j.list.length, 'report')}); a report from another observer would firm it up.`);
    });
    const noGrid = facts.filter(f => !f.a.points.length);
    if (noGrid.length) gaps.push(`${plural(noGrid.length, 'report')} without a grid: ${cite(noGrid, 6)}. A grid would place ${noGrid.length === 1 ? 'it' : 'them'}.`);
    if (unknown.size) {
        gaps.push(`Not in the equipment catalogue: ${[...unknown].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([t, n]) => `${t}${n > 1 ? ` (${n})` : ''}`).join(', ')}.`
            + ' Add them in the Narrative settings, under Equipment, so the rules can read them.');
    }

    // --- BLUF ---
    // The strongest judgment, and the strongest of another group (a defense
    // beside an attack), no more than a step weaker and at least likely.
    const lead = judged[0];
    if (lead) {
        const also = judged.slice(1).find(x => x.group !== lead.group && x.j.level >= Math.max(LIKELY, lead.j.level - 1));
        say(`${lead.term.toUpperCase()} that ${lead.whom} ${lead.what} (${lead.letter}). Confidence: ${lead.sure}.`
            + (also ? ` At the same time, ${also.term.toUpperCase()} that ${also.whom === lead.whom ? 'they' : also.whom} ${also.what} (${also.letter}). Confidence: ${also.sure}.` : ''),
        'BLUF: ', '      ');
    } else {
        say(`No pattern this tool looks for in ${plural(facts.length, 'report')}; the situation is below.`, 'BLUF: ', '      ');
    }
    // The force: its largest sighting (armor first), and the combat support seen with it.
    const main = largest.find(l => l.kind === 'maneuver') || largest[0];
    const support = roleList.filter(r => r in SUPPORT_WORD).map(r => SUPPORT_WORD[r]);
    if (main) bluf(`Strength: largest single sighting ${main.text}${support.length ? `; with ${andList(support)}` : ''}.`);
    else if (roleList.length) bluf(`Strength: no unit size from the reports; ${andList(roleList.map(r => label[r]))} reported.`);
    const trend = prev ? `, ${facts.length > prev.length ? 'up from' : facts.length < prev.length ? 'down from' : 'the same as'} ${prev.length} in the previous ${hrs} hrs` : '';
    bluf(`Activity: ${plural(facts.length, 'report')}${who ? ` from ${plural(who, 'observer')}` : ''}${trend}`
        + `${places.length ? `; busiest ${places.slice(0, 2).map(p => `${p.label} (${p.value})`).join(', ')}` : ''}.`);
    const last = facts[facts.length - 1];
    const where = last.places.length ? last.places.join(', ') : last.a.points.length ? last.a.points[0].mgrs : (last.r.location || 'no location');
    bluf(`Latest: ${last.id} ${dayTime(last.ms, local)}, ${where}: ${last.shown || '-'}, ${last.r.activity || '-'}.`);
    if (watchList.length) bluf(`Watch for: ${watchList.slice(0, 3).join('; ')}.`);
    if (gaps.length) bluf(`Gap: ${quietBrief || gaps[0]}`);

    // --- 1. SITUATION: what the reports say ---
    out.push('', '1. SITUATION');
    item(`${plural(facts.length, 'report')}${who ? ` from ${plural(who, 'observer')}` : ''}, ${dayTime(facts[0].ms, local)} to ${dayTime(last.ms, local)}`
        + `${prevNote}; ${placed} in an NAI or OBJ`
        + `${places.length ? `, most in ${places.slice(0, 3).map(p => `${p.label} (${p.value})`).join(', ')}` : ''}.`);
    // Where they headed.
    const heads = new Map();
    facts.forEach(f => { if (f.act.heading) { const h = HEADINGS_8[Math.round(f.act.headingDeg / 45) % 8]; heads.set(h, (heads.get(h) || 0) + 1); } });
    if (heads.size) item(`Movement: headed ${[...heads].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, 3).map(([h, n]) => `${h} (${n})`).join(', ')}.`);
    // The way of march, when there is one, and how the reports moving moved against it.
    if (march) {
        const ways = [set.toward && `toward ${set.toward} in the AO`,
            axes.length && `along ${andList(axes.map(a => a.key))} within ${AXIS_NEAR_METERS / 1000} km of ${axes.length === 1 ? 'it' : 'them'}`].filter(Boolean);
        const moved = facts.filter(f => f.sense);
        const n = (s) => moved.filter(f => f.sense === s).length;
        item(`Way of march: ${ways.join('; ')}.${moved.length ? ` Of ${plural(moved.length, 'report')} moving there: ${n('along')} along it, ${n('back')} back along it, ${n('across')} across it.` : ''}`);
    }
    // Any firing, the latest three.
    const shots = facts.filter(f => f.act.tags.includes('Firing'));
    if (shots.length) {
        item(`Firing: ${plural(shots.length, 'report')}: ${shots.slice(-3).reverse().map(f => `${f.id} ${dayTime(f.ms, local)} ${f.shown || '-'}, ${f.r.activity || '-'}`).join('; ')}`
            + `${shots.length > 3 ? `; and ${shots.length - 3} earlier` : ''}.`);
    }
    // Each busy place in a sentence: when, what kinds, what they were doing.
    if (places.length) {
        item('By place:');
        places.slice(0, 6).forEach(p => {
            const list = at(p.label);
            const kinds = EQUIPMENT_ROLES.map(([r]) => r).filter(r => list.some(f => f.els.some(e => e.kit && e.kit.role === r))).map(r => label[r]);
            // Whose area it is, from the unit list (not from the reports).
            const whose = set.units.filter(u => u.places.some(q => q.toUpperCase() === p.label.toUpperCase())).map(u => u.name);
            say(`${p.label}${whose.length ? ` (area of ${andList(whose)})` : ''}: ${plural(list.length, 'report')}, ${dayTime(list[0].ms, local)} to ${dayTime(list[list.length - 1].ms, local)}`
                + `${kinds.length ? `; ${kinds.join(', ')}` : ''}; ${activityLine(list)}.`, '       ', '         ');
        });
    }

    // --- 2. ENEMY FORCES: what was seen, by kind ---
    out.push('', '2. ENEMY FORCES');
    if (roleList.length) {
        item(`Equipment reported: ${roleList.map(r => `${label[r]} (${[...roles.get(r)].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
            .map(([t, n]) => typeCount(t, n, kitOf.get(t))).join(', ')})`).join('; ')}.`);
    } else item('Equipment reported: none the catalogue knows.');
    // Vehicles given only as tracked or wheeled, and how the rules read them.
    const geared = facts.filter(f => f.gear);
    if (geared.length) {
        const tracked = geared.reduce((n, f) => n + f.gear.tracked, 0), wheeled = geared.reduce((n, f) => n + f.gear.wheeled, 0);
        const read = !wheeled ? 'all tracked: read as armor or mechanized forces'
            : !tracked ? 'all wheeled: read as supply vehicles or motorized columns'
                : { tracked: 'mostly tracked: read as armor or mechanized forces, the wheeled as their support',
                    wheeled: 'mostly wheeled: read as supply or motorized columns, the tracked as their escort',
                    mixed: 'a mix: read as mechanized forces with their supply vehicles' }[gearMix(tracked, wheeled)];
        item(`Tracked and wheeled (type not given): ${tracked} tracked, ${wheeled} wheeled in ${plural(geared.length, 'report')}; ${read}.`);
    }
    if (army) {
        item(origins.RU && origins.CN
            ? `Equipment by design: Russian ${origins.RU}, Chinese ${origins.CN}; each judgment uses the doctrine of the equipment in its reports.`
            : `Identified equipment is of ${ARMIES[army]} design (${origins[army]} ${origins[army] === 1 ? 'vehicle or system' : 'vehicles and systems'}), so the assessment uses ${army === 'RU' ? 'Russian' : 'PLA'} doctrine.`);
    }
    if (largest.length) item(`Largest single sightings: ${largest.map(l => l.text).join('; ')}.`);

    // --- 3. ASSESSMENT: one line a judgment ---
    out.push('', '3. ASSESSMENT');
    if (!judged.length) say("No assessment: the reports in this period don't match any of the patterns this tool looks for.");
    groups.forEach(g => {
        out.push(`   ${g.toUpperCase()}`);
        judged.filter(x => x.group === g).forEach(x => {
            say(`${x.term.toUpperCase()} that ${x.whom} ${x.what}. Confidence: ${x.sure}.`, `   ${x.letter}. `, '      ');
            shown.push({ rule: x.j.rule, level: x.j.level, line: out.length - 1, detail: null, sources: [...new Set(x.j.list.map(f => reportKey(f.r)))] });
        });
    });
    // How many more there were is said, not hidden.
    if (all.length > top.length) {
        say(`${plural(all.length - top.length, 'more judgment')} at ${ICD203[all[top.length].level][0]} or less not shown; a shorter window, or rules switched off in the settings, narrows them.`);
    }

    // --- 4. WATCH FOR, 5. GAPS AND COLLECTION ---
    out.push('', '4. WATCH FOR');
    if (watchList.length) watchList.forEach(item);
    else out.push('   Nothing more than the judgments already show.');
    out.push('', '5. GAPS AND COLLECTION');
    if (gaps.length) gaps.forEach(item);
    else out.push('   None.');

    // --- ANNEX A: each judgment in full ---
    let annex = null;
    if (judged.length) {
        out.push('', 'ANNEX A. JUDGMENT DETAIL');
        annex = [out.length - 1, 0];
        judged.forEach((x, i) => {
            say(`${x.term.toUpperCase()} (${x.pct}) that ${x.whom} ${x.what}.`, `   ${x.letter}. `, '      ');
            const from = out.length;
            say(`Basis: ${x.j.basis}.`, '      ', '      ');
            const doctrine = DOCTRINE[x.j.rule] && DOCTRINE[x.j.rule][x.o];
            if (doctrine) {
                const whose = x.mine ? `${ARMIES[x.o]} equipment in these reports${x.own.RU && x.own.CN ? `, ${x.own[x.o]} of ${x.own.RU + x.own.CN}` : ''}` : `${ARMIES[x.o]} equipment in the period`;
                say(`Doctrine (${whose}): ${doctrine}`, '      ', '      ');
            }
            if (x.whom !== set.enemy) {
                say(`Unit: from the unit list, ${x.units.map(u => `${u.name} (${[u.places.join(', ') || 'anywhere', u.kinds.map(k => label[k]).join(', ')].filter(Boolean).join('; ')})`).join('; ')}.`, '      ', '      ');
            }
            say(`Confidence: ${x.confidence}.`, '      ', '      ');
            if (x.j.watch.length) say(`Watch for: ${x.j.watch.join('; ')}.`, '      ', '      ');
            shown[i].detail = [from, out.length];
        });
        annex[1] = out.length;
    }

    out.push('');
    say('NOTE: SITUATION and ENEMY FORCES are what the reports say; counts are as reported, and the same vehicles may be in more than one report.'
        + ' ASSESSMENT comes from fixed rules over the cited reports, in full in Annex A. Likelihood terms follow ICD 203: '
        + `${ICD203.map(([t, p]) => `${t} ${p}`).join(', ')}. Confidence (high, moderate, low) rests on how many reports and observers support a judgment.`
        + ' Doctrine follows the design of the equipment in each judgment\'s reports (Russian or Chinese), else the period\'s.'
        + `${set.units.length ? ' Units are named from the unit list, not from the reports.' : ''}`, '', '');
    return { lines: out, judgments: shown, annex };
};
