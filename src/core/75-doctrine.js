// SPDX-License-Identifier: AGPL-3.0-only
// The narrative's echelons, likelihood terms, built-in rules, and doctrine (data). The build joins the src/core/ parts in name order inside one function, so they share one scope.

// Roughly what size of unit a count of one kind of system suggests, in US
// terms as an approximation of Russian and Chinese organization (a tank or
// BMP platoon is 3-4 vehicles, a company 10-14, a battalion 30-45; a gun
// battery 6-8; a squad 7-10). Always "approximately": strengths vary, and
// one report rarely sees a whole unit.
const ECHELONS = {
    maneuver: [[1, 'section'], [3, 'platoon'], [6, 'company (-)'], [10, 'company'], [16, 'company (+)'], [26, 'battalion'], [46, 'battalion (+)']],
    fires:    [[1, 'section'], [2, 'platoon'], [4, 'battery'], [9, 'battery (+)'], [15, 'battalion'], [25, 'battalion (+)']],
    ad:       [[1, 'section'], [2, 'platoon'], [5, 'battery'], [9, 'battalion']],
    infantry: [[1, 'team'], [5, 'squad'], [13, 'platoon'], [41, 'company'], [151, 'battalion']],
};
const ECHELON_KIND = { armor: 'maneuver', mech: 'maneuver', recon: 'maneuver', fires: 'fires', ad: 'ad', infantry: 'infantry' };
const ECHELON_LABEL = { maneuver: 'armor and mechanized', fires: 'artillery', ad: 'air defense', infantry: 'dismounted' };
const echelonOf = (kind, n) => {
    let e = null;
    for (const [min, name] of ECHELONS[kind] || []) if (n >= min) e = name;
    return e;
};

// The likelihood terms of ICD 203 (Analytic Standards), lowest to highest.
// Confidence (high, moderate, low) is said separately, never in the same
// sentence, as the standard asks.
const ICD203 = [
    ['almost no chance', '1-5%'], ['very unlikely', '5-20%'], ['unlikely', '20-45%'], ['roughly even chance', '45-55%'],
    ['likely', '55-80%'], ['very likely', '80-95%'], ['almost certain', '95-99%'],
];
const EVEN = 3, LIKELY = 4, VERY_LIKELY = 5;   // rules never claim more than very likely

// The built-in rules, which the team can switch off: [id, name, what it
// looks for, group]. Patterns from Russian and PLA tactics, as far as SALT
// reports can show them.
const NARRATIVE_RULES = [
    ['offense', 'Preparing an offensive', 'artillery, air defense moving, armor massing, engineers moving, EW, contact', 'Maneuver'],
    ['axes', 'Advance on several axes', 'armor or mechanized forces moving in two or more places within 6 hrs', 'Maneuver'],
    ['fixing', 'Fixing attack, main effort elsewhere', 'contact in one place while armor or mechanized forces move in another within 3 hrs', 'Maneuver'],
    ['forward', 'Forward detachment or advance guard', 'armor moving with artillery, air defense or engineers', 'Maneuver'],
    ['recon', 'Reconnaissance ahead of armor', 'reconnaissance or UAVs, then armor or mechanized forces within 6 hrs in the same place', 'Maneuver'],
    ['reconforce', 'Reconnaissance in force', 'a platoon or more firing, then pulling back within 3 hrs in the same place', 'Maneuver'],
    ['assembly', 'Assembly area', 'armor halted with supply or command vehicles, or resupplying', 'Maneuver'],
    ['reserve', 'Second echelon or reserve', 'armor halted in one place while there is contact in another', 'Maneuver'],
    ['firing', 'Probing or attacking', 'firing twice or more, or by a company or more', 'Maneuver'],
    ['dismount', 'Delivering an assault group', 'armored vehicles dropping infantry, then infantry moving or fighting within 2 hrs', 'Maneuver'],
    ['buildup', 'Infantry building up near the line', 'small dismounted groups halted or hiding in one place, three times or more in 48 hrs', 'Maneuver'],
    ['infiltration', 'Infiltration by small groups', 'small dismounted groups (or light vehicles) moving or observing, twice or more in 12 hrs', 'Maneuver'],
    ['lightassault', 'Assault on light vehicles', 'motorcycles, buggies or light vehicles moving or fighting, twice or more in 12 hrs', 'Maneuver'],
    ['urban', 'Assault groups in built-up areas', 'small dismounted groups fighting among buildings, with tanks, thermobaric weapons or artillery', 'Maneuver'],
    ['exploit', 'Exploiting a breakthrough', 'contact in one place, then armor moving through it and on into new places within 12 hrs', 'Maneuver'],
    ['encircle', 'Envelopment or encirclement', 'forces moving or fighting in three or more 10 km squares around one, or flanking reported', 'Maneuver'],
    ['pursuit', 'Pursuit', 'pursuit reported by armor, light vehicles or infantry', 'Maneuver'],
    ['counterattack', 'Counterattack', 'a counterattack reported, or armor arriving in a place after contact there', 'Maneuver'],
    ['withdrawal', 'Withdrawal', 'reports of withdrawing, retreating or breaking contact', 'Maneuver'],
    ['airassault', 'Air assault or airborne landing', 'transport helicopters, landings, airborne vehicles', 'Maneuver'],
    ['amphibious', 'Amphibious landing or crossing', 'amphibious vehicles or landings, with smoke, ferries or cover', 'Maneuver'],
    ['defense', 'Preparing a defense', 'digging in, obstacles or mines, engineers, antitank weapons, vehicles halted', 'Defense'],
    ['strongpoint', 'A company strongpoint', 'two of armor, infantry and antitank weapons holding in one place for 12 hrs or more', 'Defense'],
    ['fortline', 'A fortified line in depth', 'digging in, obstacles or engineers in three or more places within 48 hrs', 'Defense'],
    ['screen', 'Security zone or screen', 'reconnaissance or small groups halted or observing in two or more places within 6 hrs', 'Defense'],
    ['antitank', 'Antitank positions', 'antitank weapons in position, with obstacles or tanks in hides', 'Defense'],
    ['remotemine', 'Remote mining', 'minelaying systems or scatterable mines, with rockets or artillery', 'Defense'],
    ['deception', 'Camouflage and deception', 'decoys, dummies, camouflage or concealment reported', 'Defense'],
    ['artillery', 'Artillery preparation or fire strike', 'artillery or rocket fire twice or more in 3 hrs, then armor moving', 'Fires'],
    ['reconfire', 'UAVs spotting for artillery', 'UAVs, then artillery, shelling or loitering munitions within an hour in the same place', 'Fires'],
    ['isr', 'Persistent drone surveillance', 'UAVs over one place three times or more in 12 hrs, with no fire yet', 'Fires'],
    ['counterbattery', 'Counter-battery fire', 'counter-battery radar or fire, or drones striking guns, with artillery in the same place', 'Fires'],
    ['shootscoot', 'Shoot and scoot', 'artillery or rockets firing, then moving within the hour', 'Fires'],
    ['tankfire', 'Tanks as fire support', 'tanks firing from halted positions, with no armor advancing there', 'Fires'],
    ['thermobaric', 'Thermobaric fires', 'TOS launchers, Shmel or PF-97 flamethrowers, or thermobaric fire reported', 'Fires'],
    ['deep', 'Long-range strikes', 'long-range rockets or missiles (Iskander, Smerch, Tornado-S, PHL-16, DF-series)', 'Fires'],
    ['c2strike', 'Strikes on command and sensors', 'fires, missiles or drones striking command posts, radars or communications', 'Fires'],
    ['sead', 'Suppressing air defense', 'anti-radiation weapons, or strikes on radars and air defense', 'Fires'],
    ['drones', 'Loitering munitions and drones', 'loitering munitions, FPV or armed drones', 'Fires'],
    ['interdict', 'Drones cutting supply routes', 'drones or FPVs striking vehicles or roads in one place', 'Fires'],
    ['glidebomb', 'Glide bomb strikes', 'glide or guided bombs (KAB, FAB with UMPK, LS-6)', 'Fires'],
    ['aviation', 'Attack aviation', 'attack helicopters, ground-attack aircraft or armed UAVs', 'Fires'],
    ['crossing', 'River or gap crossing', 'bridging or ferries, smoke, air defense cover, armor waiting', 'Support'],
    ['breach', 'Breaching obstacles', 'mine clearing or breaching, smoke, fire support, armor nearby', 'Support'],
    ['cbrn', 'Chemical defense and smoke troops', 'chemical-defense vehicles, decontamination or smoke generators', 'Support'],
    ['cp', 'Command post', 'command vehicles or antennas, with air defense, EW or many vehicles halted', 'Support'],
    ['adsite', 'Air defense over a key site', 'air defense in place with command, artillery or supply vehicles', 'Support'],
    ['ew', 'Electronic warfare', 'EW systems, or jamming reported', 'Support'],
    ['logistics', 'A logistics point', 'supply vehicles halted or resupplying in one place, twice or more in 12 hrs', 'Support'],
    ['logforward', 'Logistics pushing forward', 'supply vehicles moving, twice or more in 12 hrs, while armor masses or with fuel and ammunition', 'Support'],
    ['railhead', 'A railhead or rail move', 'armor, artillery or supply vehicles on trains or at a railhead', 'Support'],
    ['droneresupply', 'Resupply by drone', 'drones dropping or carrying supplies', 'Support'],
    ['farp', 'Helicopter refueling point', 'helicopters on the ground with fuel or supply vehicles, or a FARP reported', 'Support'],
    ['casevac', 'Casualty evacuation', 'ambulances, MEDEVAC or wounded reported', 'Support'],
    ['regroup', 'Regrouping after an attack', 'armor or infantry halted, resupplying or recovering vehicles within 24 hrs after contact', 'Support'],
];
const RULE_ORDER = Object.fromEntries(NARRATIVE_RULES.map(([id], i) => [id, i]));

// What each pattern means in the doctrine of the army whose equipment was
// reported: Russian, or the PLA's. Open-source generalities (US Army ATP
// 7-100.1 and 7-100.3, TRADOC, RUSI, RAND and others, including Russian
// practice in Ukraine since 2022), said once under each judgment so a reader
// knows why it matters.
const DOCTRINE = {
    offense: {
        RU: 'Russian offensives typically open with reconnaissance, EW and an artillery preparation, with air defense moving forward under the main effort.',
        CN: 'PLA offensives open by closing the range: reconnaissance and a firepower strike with EW against command and sensors, then assault groups entangle and annihilate on a weak point.',
    },
    axes: {
        RU: 'Russian attacks pair a main effort with supporting attacks on other axes, to fix the defender and envelop.',
        CN: "PLA attacks follow 'one point, two sides': converging attacks on several axes, with fire to fix, concentrating on one point of penetration.",
    },
    fixing: {
        RU: 'Russian attacks often pair a fixing attack on one axis with the main effort on another, to pin defenders and draw in their reserves.',
        CN: "Under 'one point, two sides', PLA units fix the enemy with fire on supporting axes while massing on a single point of penetration.",
    },
    forward: {
        RU: 'A Russian forward detachment or advance guard moves ahead of the main body to seize key terrain; since 2023 it is often an armored group of a few tanks and BMPs carrying an assault group.',
        CN: 'PLA brigades push a vanguard or thrust maneuver group ahead of the main body to seize key terrain.',
    },
    recon: {
        RU: 'Russian forces lead with reconnaissance (razvedka): UAVs and a combat reconnaissance patrol ahead of the main body.',
        CN: 'PLA reconnaissance battalions (mounted scouts, battlefield surveillance and UAV companies) find targets ahead of the assault and its fires.',
    },
    reconforce: {
        RU: 'Russian forces conduct reconnaissance in force (razvedka boyem), attacking with a reinforced platoon or company to make defenders reveal their positions, then striking them with artillery.',
        CN: 'PLA units use reconnaissance in force and reconnaissance by fire to make defenders open fire and reveal positions for the follow-on firepower strike.',
    },
    assembly: {
        RU: 'Russian assault detachments and battalion groups assemble dispersed, in small groups and often in villages or tree lines, to refuel and rearm before moving to attack positions.',
        CN: 'PLA combined-arms battalions gather in assembly areas to refuel and organize assault groups before attacking.',
    },
    reserve: {
        RU: 'Russian forces fight in echelons: a second echelon or reserve is held back to exploit success or counterattack.',
        CN: 'PLA forces hold a reserve or second echelon to exploit a breakthrough or counterattack.',
    },
    firing: {
        RU: 'Russian forces probe continuously with small assault groups, often expendable infantry, to make defenders reveal their positions, which drones and artillery then strike.',
        CN: 'PLA forces probe with small assault elements to locate positions for fires before the main assault.',
    },
    dismount: {
        RU: 'A Russian armored group (bronegruppa, often a tank and a few BMPs) races assault infantry to a dismount point, then pulls back or supports them by fire.',
        CN: 'PLA infantry fighting vehicles carry assault teams to the dismount point, then support them with cannon and missile fire as they close.',
    },
    buildup: {
        RU: 'Russian assault infantry seep through the gray zone in twos and threes and gather in tree lines or buildings near the line until there are enough to assault.',
        CN: 'PLA light infantry close the range in small three-man teams and concentrate near a weak point before the assault.',
    },
    infiltration: {
        RU: 'Russian sabotage-reconnaissance groups (DRG) infiltrate in small teams to scout, mark targets and raid; since 2024 assault infantry also seep through gaps in twos and threes, often on motorcycles.',
        CN: 'PLA special operations and reconnaissance teams penetrate in small three-man groups to scout and designate targets.',
    },
    lightassault: {
        RU: 'Since 2024 Russian assault groups ride motorcycles, buggies and civilian vehicles in pairs and small groups to dash through the drone-covered gray zone.',
        CN: 'PLA light combined-arms battalions move on Mengshi light vehicles and all-terrain vehicles for fast, dispersed approaches and raids.',
    },
    urban: {
        RU: 'Russian forces take built-up areas building by building with small assault groups, supported by tanks, thermobaric weapons, artillery and drones.',
        CN: 'PLA urban assaults combine small infantry teams with UAVs, unmanned ground vehicles, smoke and breaching vehicles, clearing buildings from the top down.',
    },
    exploit: {
        RU: 'Russian commanders exploit a breach by pushing a fresh forward detachment or second echelon through it to strike rear areas before the defense recovers.',
        CN: 'PLA attacks commit depth-attack and thrust maneuver groups through the gap to envelop the defense and strike its rear.',
    },
    encircle: {
        RU: 'Russian operations favor envelopment and encirclement of strongpoints and towns, cutting supply routes with fire before closing the pocket (kotyol).',
        CN: 'PLA tactics aim to split and encircle the enemy and annihilate it in detail, bypassing strongpoints to isolate them.',
    },
    pursuit: {
        RU: 'Russian doctrine calls for parallel and frontal pursuit to stop a withdrawing enemy from occupying new positions.',
        CN: "PLA tactics stress the 'three ferocities', including fierce pursuit of a retreating enemy before it can reorganize.",
    },
    counterattack: {
        RU: 'Russian defenders counterattack quickly, often within hours and at platoon to company strength, with tanks and artillery, to retake lost positions before the attacker consolidates.',
        CN: 'PLA defenses keep an armor-heavy depth group to counterattack a penetration once it has been fixed in the annihilation zones.',
    },
    withdrawal: {
        RU: 'Russian withdrawals are covered by a rear guard, obstacles and artillery, often at night.',
        CN: 'PLA withdrawals are covered by a rear guard and obstacles while the main body breaks contact.',
    },
    airassault: {
        RU: 'Russian airborne (VDV) and air-assault forces land by helicopter or parachute to seize key terrain ahead of ground forces.',
        CN: "PLA army air-assault brigades land by helicopter (Z-8, Z-20) to seize key terrain or crossings; the Air Force's airborne corps drops by parachute.",
    },
    amphibious: {
        RU: 'Russian naval infantry and amphibious vehicles land, or cross water obstacles, under covering fire.',
        CN: 'PLA amphibious combined-arms brigades (ZBD-05, ZTD-05) land under covering fires, with smoke and EW.',
    },
    defense: {
        RU: 'Russian defenses are echeloned: a security zone, then company strongpoints behind dense, mixed minefields covered by fire sacks, with reserves held back to counterattack.',
        CN: 'PLA positional defenses put a frontier defense group forward and a depth defense group behind, with obstacles covering annihilation zones and an armor-heavy force to counterattack.',
    },
    strongpoint: {
        RU: 'The Russian defense is built from company strongpoints (opornyy punkt) holding all-round, linked by fire and obstacles rather than a continuous trench.',
        CN: 'PLA defenses hold strongpoints that cover each other and anchor the annihilation zones.',
    },
    fortline: {
        RU: 'Russian forces build fortified lines in depth (as on the Surovikin line) with tank ditches, dragon\'s teeth, wire, dense minefields and company strongpoints several kilometers apart.',
        CN: 'PLA positional defense is built in depth, with a frontier defense group forward and a depth defense group behind it in prepared positions.',
    },
    screen: {
        RU: 'Russian defenses push a security zone and forward positions ahead of the main defensive area to warn, delay and draw the attacker into prepared fire sacks.',
        CN: 'PLA defenses post security and disruption elements forward of the main positions to warn of, delay and fix the attacker before the annihilation zones.',
    },
    antitank: {
        RU: 'Russian defenses place ATGMs and tanks in prepared positions covering obstacles and likely armor approaches, forming fire sacks.',
        CN: 'PLA defenses site antitank missiles (HJ-series) in depth, covering obstacles, likely armor approaches and the annihilation zones.',
    },
    remotemine: {
        RU: 'Russian engineers lay minefields remotely (Zemledeliye, UMZ, artillery-scattered mines) to block counterattacks, seal flanks and close routes behind an enemy.',
        CN: 'PLA engineers lay rapid and scatterable minefields to block enemy maneuver and protect the flanks of an attack or defense.',
    },
    deception: {
        RU: 'Russian maskirovka uses inflatable and wooden decoys, thermal camouflage, decoy drones (Gerbera) and false positions to mislead about strength and intent.',
        CN: 'PLA deception combines camouflage, feints and false emissions to mislead about strength and intent.',
    },
    artillery: {
        RU: 'Russian attacks open with an artillery preparation or short, intense fire raids, now often with mortars, drones and glide bombs as well as guns.',
        CN: 'PLA attacks open with a fire preparation and fire assaults by rockets and artillery before the assault groups close.',
    },
    reconfire: {
        RU: 'Russian reconnaissance-fire complexes link UAVs to artillery and drones, putting fire on a target within minutes of finding it (the missile-armed operational version is the reconnaissance-strike complex).',
        CN: 'PLA reconnaissance-strike integration links UAVs and reconnaissance battalions directly to rockets and artillery.',
    },
    isr: {
        RU: 'Persistent Russian drone surveillance of one place usually means a target is being built up for artillery, glide bombs or an assault.',
        CN: 'Persistent PLA UAV surveillance builds the target picture that reconnaissance-strike integration needs before a firepower strike.',
    },
    counterbattery: {
        RU: 'Russian counter-battery fire uses Zoopark radars, UAVs and increasingly loitering munitions to find guns and strike them within minutes.',
        CN: 'PLA artillery battalions use target-acquisition radars (SLC-2) and UAVs to locate enemy guns for counter-battery fire as part of the firepower strike.',
    },
    shootscoot: {
        RU: 'Russian guns and rocket launchers fire from several positions, and on the move, then displace quickly to survive counter-battery fire ("roving" guns).',
        CN: 'PLA self-propelled guns and rocket batteries (PCL-181, PHL-16) fire autonomously and displace before counter-battery fire arrives.',
    },
    tankfire: {
        RU: 'Russian tanks are now used mostly as direct or indirect fire support from behind the line, and in armored groups, rather than to break through.',
        CN: 'PLA assault-gun and tank companies support assault groups by fire, engaging strongpoints from standoff before the infantry close.',
    },
    thermobaric: {
        RU: 'Russian RKhBZ troops fire TOS thermobaric rockets (and infantry fire RPO-A Shmel) against fortified positions and built-up areas, usually just before an assault.',
        CN: 'PLA chemical-defense units field flamethrowers and incendiary or thermobaric rocket launchers to destroy fortified positions during an assault.',
    },
    deep: {
        RU: 'Russian deep strikes (Iskander, long-range rockets) hit command posts, air defense and logistics in depth.',
        CN: "PLA long-range fires (the army's PHL-16 rockets, the Rocket Force's DF-series missiles) strike command, air defense and logistics as part of a joint fire strike.",
    },
    c2strike: {
        RU: 'Russian deep strikes and loitering munitions go after command posts, radars and communications nodes first, to blind and paralyze the defense.',
        CN: "PLA 'system destruction warfare' strikes command, communications and sensor nodes first to paralyze the enemy's operational system.",
    },
    sead: {
        RU: 'Russian forces hunt air defense with anti-radiation missiles, decoys, EW and Lancet strikes, often baiting radars to emit before striking.',
        CN: 'PLA fire strikes go after air-defense radars early, with anti-radiation loitering munitions (ASN-301), rockets and EW, as part of system destruction.',
    },
    drones: {
        RU: 'Russian forces use Lancet and Molniya loitering munitions and FPV drones, including fiber-optic FPVs that jamming cannot stop, against armor, artillery, air defense and supply routes.',
        CN: 'PLA forces field loitering munitions (CH-901, ASN-301), FPV drones and swarms, down to squad level.',
    },
    interdict: {
        RU: 'Russian drone units use fiber-optic and long-range FPVs to cut supply routes 15-20 km behind the line before an assault.',
        CN: 'PLA system destruction warfare targets logistics and the links between units, using reconnaissance-strike UAVs and rockets to isolate the battle area.',
    },
    glidebomb: {
        RU: 'Russian aircraft drop FAB and KAB bombs with UMPK glide kits from 40 to 70 km away to destroy strongpoints and villages just ahead of an assault.',
        CN: 'PLA aircraft carry satellite-guided glide bombs (LS-6) to strike fixed positions from outside short-range air defense.',
    },
    aviation: {
        RU: 'Russian attack helicopters and Su-25s fire rockets from standoff, often in lofted salvoes, while Su-34s drop glide bombs on positions ahead of an attack.',
        CN: 'PLA army aviation (Z-10, Z-19) supports ground attacks and air assaults.',
    },
    crossing: {
        RU: 'Russian river crossings use smoke, air defense cover and PMP or TMM bridging or PTS ferries.',
        CN: 'PLA gap crossings use smoke, air defense cover, bridging and amphibious vehicles.',
    },
    breach: {
        RU: 'Russian breaches use UR-77 line charges and tank mine plows (KMT-7/8) leading the column, smoke, and artillery suppressing the far side.',
        CN: 'PLA breaches use mine-clearing vehicles, line charges and smoke under suppressive fires.',
    },
    cbrn: {
        RU: 'Russian RKhBZ (radiation, chemical and biological protection) troops lay smoke to screen crossings, breaches and assaults, decontaminate, and operate the TOS launchers.',
        CN: 'PLA chemical-defense companies screen attacks, crossings and breaches with smoke (now also laid by UAVs) and decontaminate units.',
    },
    cp: {
        RU: 'Russian tactical command posts show command vehicles (R-149, R-145) and antennas near the line; higher headquarters sit further back in hardened buildings, wired to the civil telecom network.',
        CN: 'PLA command posts show command vehicles, antennas, generators and local air defense.',
    },
    adsite: {
        RU: 'Russian air defense covers command posts, artillery and logistics with short- and medium-range systems in layers.',
        CN: 'PLA air defense covers key sites with layered short- and medium-range systems.',
    },
    ew: {
        RU: 'Russian EW (Borisoglebsk-2, Leer-3, Krasukha) jams communications, GPS and drones, about one major system per 10 km of front, plus small trench and vehicle jammers protecting assault columns.',
        CN: "PLA electronic warfare targets command, communications and sensors early, as part of 'system destruction' warfare.",
    },
    logistics: {
        RU: 'Russian supply runs by rail to railheads, then by truck from materiel-technical support (MTO) units; forward points sit close behind the line, and the last kilometers are often by motorcycle or drone.',
        CN: "PLA combined-arms brigades are supplied by a service-support battalion, backed by the group army's service-support brigade, pushing fuel and ammunition forward.",
    },
    logforward: {
        RU: 'Russian ammunition and fuel moving forward from MTO units usually comes before an attack.',
        CN: 'PLA service-support battalions push fuel and ammunition forward to the combined-arms battalions just before and during an attack.',
    },
    railhead: {
        RU: 'Russian forces move and supply by rail to railheads near the front, then by truck; a railhead unloading armor or ammunition often signals a build-up.',
        CN: 'PLA brigades practice long moves by rail (as in the Stride exercises), so heavy equipment on trains signals a deployment.',
    },
    droneresupply: {
        RU: 'Russian forces resupply small infiltrated groups by drone when vehicles cannot reach them, a sign they mean to hold the ground they have seeped into.',
        CN: 'PLA units, notably the airborne corps, use cargo UAVs to resupply forward elements.',
    },
    farp: {
        RU: 'Russian attack helicopters work from forward refueling and rearming sites close behind the line, to fly repeated short sorties in support of an attack.',
        CN: 'PLA army aviation sets up temporary refueling and rearming points to keep attack helicopters close to the fight.',
    },
    casevac: {
        RU: 'Russian assault groups include evacuation teams; evacuation of wounded after an assault is a sign of heavy fighting, though it is often slow.',
        CN: 'PLA units evacuate wounded with armored ambulances and are trialing unmanned vehicles and heavy-lift drones for it.',
    },
    regroup: {
        RU: 'After a costly assault, Russian units pull back, recover vehicles (BREM), take replacements and attack again, often on the same axis within days.',
        CN: 'PLA units consolidate and reorganize after an assault, committing the reserve while the assault groups regroup.',
    },
};
const ARMIES = { RU: 'Russian', CN: 'Chinese' };
