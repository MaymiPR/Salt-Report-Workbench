// SPDX-License-Identifier: AGPL-3.0-only
// The narrative's equipment catalogue (data) and its lookups. The build joins the src/core/ parts in name order inside one function, so they share one scope.

// --- Narrative ---

// The narrative summary: what the reports say (OBSERVED), then what they
// suggest (ASSESSMENT), from fixed rules that cite the reports behind each
// judgment. The same reports always give the same words, nothing is put down
// as seen that wasn't reported, and nothing leaves the page (no AI model).

// What a type in the Size field is. Starter set: Russian (and Soviet-era) and
// Chinese systems, then plain words (truck, PAX). Each entry is
// [role, origin, name, ...other names]. A name with a digit matches the start
// of a type (T-72 matches T-72B3 but not T-720, and the longer BMP-1KSh wins
// over BMP-1); one without matches a whole word (GRAD, not GRADER).
const EQUIPMENT_ROLES = [
    ['armor', 'armor'], ['mech', 'mechanized infantry'], ['recon', 'reconnaissance'],
    ['fires', 'artillery and rockets'], ['ad', 'air defense'], ['atgm', 'antitank'],
    ['engineer', 'engineers'], ['logistics', 'logistics and support'], ['c2', 'command and control'],
    ['ew', 'electronic warfare'], ['air', 'aviation'], ['infantry', 'dismounted personnel'],
    ['light', 'light vehicles'], ['vehicle', 'other vehicles'],
];
const eqp = (role, origin, names) => names.map(n => [role, origin, ...[].concat(n)]);
const EQUIPMENT_CATALOGUE = [
    // Russian and Soviet-era. Variants are listed with each type: a type
    // matches its variants anyway (T-72 matches T-72B3M), but listing them
    // says which are meant, and the names (Proryv, Basurmanin) match too.
    // A variant after a hyphen and a digit (9P163-3, 2B14-1) is listed, since
    // the digit stops the match. Names that also mean something else (Rys,
    // Vityaz, Ovod, Redut, Klin) are given only as their designations.
    ...eqp('armor', 'RU', [['T-54', 'T-54A', 'T-54B'], ['T-55', 'T-55A', 'T-55AM', 'T-55AMV'], ['T-62', 'T-62M', 'T-62MV'],
        ['T-64', 'T-64A', 'T-64B', 'T-64BV'], ['T-72', 'T-72A', 'T-72AV', 'T-72B', 'T-72B1', 'T-72B3', 'T-72B3M', 'T-72BA', 'T-72B1K', 'T-72B3A'],
        ['T-80', 'T-80B', 'T-80BV', 'T-80BVM', 'T-80BVK', 'T-80U', 'T-80UD', 'T-80UK', 'T-80UM2', 'T-80UE-1'],
        ['T-90', 'T-90A', 'T-90AK', 'T-90S', 'T-90SM', 'T-90M', 'Proryv'],
        ['T-14', 'T-14 Armata'], ['PT-76', 'PT-76B'], ['2S25', '2S25M', 'Sprut-SD', 'Sprut-SDM1'], ['BMPT', 'BMPT-72', 'Terminator']]),
    ...eqp('mech', 'RU', [['BMP-1', 'BMP-1P', 'BMP-1AM', 'BMP-1U', 'Basurmanin'], ['BMP-2', 'BMP-2M', 'BMP-2D', 'Berezhok'], ['BMP-3', 'BMP-3M'],
        'BMD-1', 'BMD-2', 'BMD-3', ['BMD-4', 'BMD-4M', 'Sadovnitsa'], 'BTR-D', ['BTR-MD', 'Rakushka'], 'BTR-50', ['BTR-60', 'BTR-60PB'],
        ['BTR-70', 'BTR-70M'], ['BTR-80', 'BTR-80A'], ['BTR-82', 'BTR-82A', 'BTR-82AM', 'BTR-82AT'], ['BTR-90', 'Rostok'], 'BTR-MDM', 'BTR-T',
        ['BTR-22', 'Bumerang', 'K-17', 'K-16'], ['Kurganets-25', 'Kurganets', 'B-11'], ['T-15', 'T-15 Armata'],
        ['MT-LB', 'MT-LBV', 'MT-LBVM', 'MT-LBu', 'MT-LBVMK'],
        ['Typhoon', 'K-63968', 'K-4386', 'K-53949', 'KamAZ-63968', 'KamAZ-53949', 'Ural-63095', 'Ural-63099', 'Typhoon-K', 'Typhoon-VDV', 'Taifun', 'Tayfun'],
        ['SBA-60K2', 'Bulat'], ['BPM-97', 'KamAZ-43269', 'Vystrel'], ['Ural-VV', 'Ural-4320VV']]),
    ...eqp('recon', 'RU', [['BRDM-1'], ['BRDM-2', 'BRDM-2M', 'BRDM-2A', 'BRDM-2MS'], ['BRM-1K', 'BRM-1KM'], ['BRM-3K', 'Rys'], 'PRP-3',
        ['PRP-4', 'PRP-4A', 'PRP-4M', 'Nard', 'Deyteriy'],
        ['Orlan-10', 'Orlan-30', 'Orlan'], ['Zala', 'Zala 421-16E', '421-08', '421-16'], ['Eleron-3', 'Eleron'], 'Forpost', ['Granat', 'Granat-4'],
        ['Takhion', 'Tachyon'], 'Supercam', 'Merlin-VR',
        ['1L219', 'Zoopark-1', 'Zoopark-1M', '1L260', 'Zoopark'], ['1L271', 'Aistyonok'], ['1L227', 'Sobolyatnik'],
        ['SNAR-10', '1RL133', 'Big Fred'], ['ARK-1', 'ARK-1M'], ['1B75', 'Penicillin', 'Penitsillin'], 'AZK-7',
        'Uran-9', 'Nerekhta', ['Kurier', 'Kuryer'], 'MRK-65']),
    ...eqp('fires', 'RU', [['2S1', 'Gvozdika', 'M1974'], ['2S3', '2S3M', 'Akatsiya', 'M1973'], ['2S4', 'Tyulpan'], ['2S5', 'Giatsint-S'],
        ['2S7', '2S7M', 'Pion', 'Malka'], ['2S9', 'Nona-S'], ['2S19', '2S19M2', 'Msta-S'], ['2S23', 'Nona-SVK'], ['2S31', 'Vena'],
        ['2S33', 'Msta-SM2'], ['2S34', 'Khosta'], ['2S35', 'Koalitsiya-SV', 'Koalitsiya'], ['2S40', 'Floks'], ['2S43', 'Malva'],
        ['2S41', 'Drok'], ['2S42', 'Lotos'], 'D-20', ['D-30', '2A18'], 'D-1', ['M-30', 'M1938'], 'BS-3', ['M-46'], ['2A36', 'Giatsint-B'],
        ['2A65', 'Msta-B'], ['2B16', 'Nona-K'],
        ['BM-21', '9K51', 'Grad', 'BM-21-1', '9P138', '9P132'], ['2B26', 'Grad-K'], ['BM-27', '9K57', '9P140', 'Uragan'], ['9K512', 'Uragan-1M'],
        ['BM-30', '9K58', '9A52', '9A52-2', 'Smerch'], ['Tornado-G', '9K51M', '9A53-G', '2B17'], ['Tornado-S', '9K515'], ['Tornado', '9A52-4'],
        ['9K59', '9A51'], ['TOS-1', 'TOS-1A', 'Buratino', 'Solntsepyok', 'Solntsepek'], ['TOS-2', 'Tosochka'], ['TOS-3', 'Drakon'], ['BMO-T'],
        ['TZM-T'], '9T452', '9T234-2',
        ['2B9', 'Vasilek'], ['2S12', '2B11', 'Sani'], ['2B14', '2B14-1', 'Podnos'], '2B24', ['BM-37', '82-BM-37'], ['PM-43', '120-PM-43'],
        ['Iskander', '9K720', 'Iskander-M', 'Iskander-K', '9M723', '9M728', '9M729', '9P78', '9P78-1', 'SS-26', 'SSC-7', 'SSC-8'],
        ['Tochka', '9K79', 'Tochka-U', '9P129', '9M79', 'SS-21'], ['Luna-M', '9K52', 'FROG-7'],
        ['K-300P', 'Bastion-P', 'SSC-5', 'P-800', 'Oniks'], ['3K60', 'Bal-E', 'SSC-6'], ['Kalibr', '3M-14', '3M-54', 'SS-N-30A', 'SS-N-27'],
        ['Lancet', 'Zala Lancet', 'Lancet-3'], ['Geran-2', 'Geran', 'Shahed-136', 'Shahed'], ['Kub-BLA'], 'Gerbera', ['Garpiya', 'Garpiya-A1'],
        'Italmas', ['Molniya', 'Molniya-2'], ['KVN', 'Knyaz Vandal Novgorodsky', 'Knyaz Vandal'], 'VT-40', 'Skalpel']),
    ...eqp('ad', 'RU', [['ZSU-23-4', 'ZSU-23-4M4', 'Shilka'], ['ZU-23-2', 'ZU-23'], ['ZPU-4', 'ZPU-2'], 'ZSU-57-2', ['S-60'],
        ['2S6', '2S6M', '2S6M1', '2K22', '2K22M', 'Tunguska', 'SA-19', 'Grison'], ['Pantsir', 'Pantsir-S1', 'Pantsir-SM', '96K6', 'SA-22'],
        ['2S38', 'Derivatsiya-PVO', 'Derivatsiya'], ['BTR-ZD', 'Skrezhet'],
        ['Osa', '9K33', '9A33', '9A33BM3', 'Osa-AKM', 'SA-8'], ['Strela-10', '9K35', '9A35', '9A34', 'SA-13'], ['Strela-1', '9K31', 'SA-9'],
        ['Strela-2', '9K32', 'SA-7'], ['Strela-3', '9K34', 'SA-14'], ['Igla', '9K38', '9K310', 'Igla-1', 'SA-16', 'SA-18'], ['Igla-S', '9K338', 'SA-24'],
        ['Verba', '9K333', 'SA-25'], ['Tor', '9K330', '9K331', '9K332', '9A330', '9A331', 'Tor-M1', 'Tor-M2', 'Tor-M2DT', 'Tor-M2U', 'Tor-M2KM', 'SA-15'],
        ['Buk', '9K37', 'Buk-M1', '9K317', 'Buk-M2', 'Buk-M3', '9A310', '9A316', '9A317', '9A39', '9S470', '9S510', '9S36', 'SA-11', 'SA-17', 'SA-27'],
        ['Kub', '2K12', '2P25', '1S91', 'Straight Flush', 'SA-6'], ['Krug', '2K11', 'SA-4'],
        ['S-125', 'Neva', 'Pechora', 'SA-3'], ['S-75', 'SA-2'],
        ['S-300', 'S-300PS', 'S-300PM', 'S-300V', 'S-300V4', '5P85', '30N6', '76N6', '40V6', '5N63', 'Flap Lid', 'Clam Shell',
            '9A82', '9A83', '9A84', '9A85', '9S15', '9S19', '9S32', '9S457', 'SA-10', 'SA-12', 'SA-20', 'SA-23'],
        ['S-350', 'Vityaz', '50P6', '50N6', '50K6', 'SA-28'], ['S-400', 'Triumf', '92N6', '91N6', '55K6', '5P85TE2', 'Grave Stone', 'SA-21'], 'S-500',
        ['Sosna', 'Sosna-R'], ['Gibka-S', 'Gibka'],
        ['9S18', 'Kupol'], ['96L6'], ['64N6'], ['P-18'], ['P-19'], ['Nebo', 'Nebo-M', 'Nebo-SVU', '55Zh6', '55Zh6U', '55Zh6M', '1L13', '1L119'],
        ['Kasta', 'Kasta-2E', '39N6'], ['1L122', 'Garmon', 'Garmony'], ['48Ya6', 'Podlet', 'Podlet-K1'], ['67N6', 'Gamma-DE'],
        ['59N6', 'Protivnik-GE', 'Protivnik'], ['36D6', 'ST-68U', '19Zh6', 'Tin Shield']]),
    ...eqp('atgm', 'RU', [['Malyutka', '9K11', '9M14', 'AT-3'], ['Fagot', '9K111', '9M111', 'AT-4'], ['Konkurs', '9K113', '9M113', '9P148', 'AT-5'],
        ['Shturm', '9K114', '9M114', '9P149', 'Shturm-S', 'AT-6'], ['Metis', '9K115', '9M115', 'AT-7'], ['Metis-M', '9K115-2', '9M131', 'AT-13'],
        ['Kornet', '9K135', '9M133', '9P162', '9P163', '9P163-3', '9P163M-1', 'Kornet-D', 'Kornet-T', 'Kornet-EM', 'AT-14'],
        ['Khrizantema', '9K123', '9M123', '9P157', '9P157-2', 'Khrizantema-S', 'AT-15'],
        ['Vikhr', '9K121', '9M127', 'AT-16'], ['Kobra', '9K112', '9M112', 'AT-8'], ['Refleks', '9K119', '9M119', 'AT-11'], ['Ataka', '9K120', '9M120', 'AT-9'],
        ['RPG-7', 'RPG-7V'], ['RPG-18', 'Mukha'], 'RPG-22', ['RPG-26', 'Aglen'], ['RPG-27', 'Tavolga'], ['RPG-28', 'Klyukva'], ['RPG-29', 'Vampir'],
        ['RPG-30', 'Kryuk'], ['RPG-32', 'Hashim'], ['RPO-A', 'RPO', 'RPO-M', 'Shmel', 'Shmel-M'], 'MRO-A', 'RShG-1', 'RShG-2',
        ['SPG-9'], ['2A45', 'Sprut-B'], ['MT-12', 'Rapira', 'T-12', '2A19', '2A29'], 'BTR-RD']),
    ...eqp('engineer', 'RU', ['MTU-20', 'MTU-72', 'MTU-90', ['MT-55', 'MT-55A'], ['TMM', 'TMM-3', 'TMM-3M2', 'TMM-6'], ['PMP', 'PMP-2M'],
        'PP-91', 'PP-2005', 'PPS-84', 'PMM-2', 'GSP', 'K-61',
        ['PTS', 'PTS-2', 'PTS-3', 'PTS-4'], ['IMR-2', 'IMR-2M'], ['IMR-3', 'IMR-3M'], 'IRM', 'BAT-2', 'BAT-M', 'MDK-3', 'BTM-3', 'PZM-2', 'PZM-3',
        ['BMR-3', 'BMR-3M', 'BMR-3MA'], 'KMT-7', 'KMT-8', ['UR-77', 'Meteorit', 'Zmey Gorynych'], 'UR-67', 'UR-07', 'GMZ-3', 'PMZ-4', ['UMZ', 'UMZ-G'],
        ['Zemledeliye', 'ISDM'], 'Uran-6', 'Prokhod-1', 'EOV-4421', 'EOV-3521', 'EOV-3523', 'PBU-100', ['KS-3574', 'KS-45719', 'KS-55729', 'KS-45731'],
        'RKhM-4', ['RKhM-6', 'Povozka'], 'RPM-2', ['BRDM-2RKh', 'BRDM-2RKhb'], ['TMS-65', 'TMS-65M'], 'ARS-14', ['UTM-80M', 'UTM-80'],
        'TDA-2K', 'TDA-3', ['MRK-46', 'MRK-RKh']]),
    ...eqp('logistics', 'RU', [['Ural', 'Ural-375', 'Ural-4320'], ['KamAZ', 'KamAZ-4310', 'KamAZ-5350', 'KamAZ-6560'], 'GAZ-66',
        ['GAZ-3308', 'Sadko'], 'GAZ-33097', ['ZIL-131', 'ZIL-157', 'ZIL'], ['KrAZ', 'KrAZ-255', 'KrAZ-260'], ['MAZ-537', 'MAZ-543', 'MAZ-6317'],
        ['MZKT-7930', 'MZKT-7429'], ['BAZ-6403', 'BAZ'], ['ATZ', 'ATMZ'], 'GAZ-3351', ['GAZ-3344', 'Aleut'], ['DT-30', 'DT-30P', 'DT-30PM'],
        ['DT-10', 'DT-10P', 'DT-10PM'],
        ['BREM', 'BREM-1', 'BREM-1M'], ['BREM-L', 'Beglyanka'], 'BREM-K', 'BREM-D', 'BREM-80U', 'REM-KL', 'REM-KS', 'MTO-UB', 'PARM-1AM1',
        'BTS-2', 'BTS-4', ['BMM-80', 'GAZ-59039'], 'Linza']),
    ...eqp('c2', 'RU', [['R-149', 'R-149MA1', 'R-149MA3', 'R-149BMR', 'R-149AKSh'], 'BMP-1KSh', 'BMP-2K', 'BMD-1KSh', 'BMD-2K', 'BTR-80K',
        ['R-145BM', 'R-145'], ['R-142', 'R-142N'], 'R-166', 'R-177M', ['R-439', 'R-439MD2'], ['R-419', 'R-419L1', 'R-419MP'], ['R-416', 'R-416GM'],
        ['R-423', 'R-423AM'], 'R-441', ['P-260', 'Redut-2US'],
        '1V13', '1V119', ['1V12', '1V12M', 'Mashina-M'], '1V14', '1V15', '1V16', '1V152', 'PU-12', ['Barnaul-T', 'Barnaul'],
        ['Andromeda-D', 'Andromeda'], ['Polyana-D4', '9S52'], ['9S737', 'Ranzhir', 'Ranzhir-M'], ['PPRU-1', '9S80', 'Ovod-M-SV']]),
    ...eqp('ew', 'RU', [['Krasukha', 'Krasukha-2', 'Krasukha-4', '1RL257', '1L269'], ['Borisoglebsk-2', 'RB-301B', 'R-330BMV', 'R-378BMV'],
        ['Leer-3', 'RB-341V'], ['Leer-2'], ['Zhitel', 'R-330Zh'], ['Pole-21', 'R-340RP'], ['Moskva-1', '1L267'], 'Palantin', ['Murmansk-BN', 'Murmansk'],
        ['Infauna', 'RB-531B'], ['Rtut-BM', 'Rtut-B', '1L262', 'SPR-2', 'Rtut'], 'Silok', ['Tirada-2', 'Tirada'], ['Bylina', 'RB-109A'],
        ['Shipovnik-Aero', 'Shipovnik'], ['Torn', 'R-381T'], 'Repellent-1', 'Stupor', ['1L222', 'Avtobaza', 'Avtobaza-M'],
        ['RB-636', 'RB-636AM2', 'Svet-KU'], ['R-934B', 'R-934BMV', 'Sinitsa'], ['RP-377', 'RP-377A', 'Lesochek'], ['RP-377LA', 'Lorandit'],
        ['R-330M1P', 'Diabazol'], 'Dzyudoist', 'Altayets', 'ZS-82', 'ZS-88',
        // Radar jammers against airborne radars, strategic and tactical
        // systems, and the drone jammers fitted to vehicles and carried.
        ['SPN-2', '1RL248-2'], 'SPN-3', ['SPN-4', '1RL248-4'], 'SPN-30', ['Tobol', '14Ts227'], 'Divnomorye', 'Samarkand',
        ['Mi-8MTPR-1', 'Rychag-AV'], 'Khibiny', 'Volnorez', ['Saniya', 'Sania'], ['Pishchal', 'Pischal']]),
    ...eqp('air', 'RU', [['Mi-8', 'Mi-8AMTSh', 'Mi-8MTV', 'Hip'], ['Mi-17', 'Mi-171', 'Mi-171E', 'Mi-171Sh'],
        ['Mi-24', 'Mi-24P', 'Mi-24V', 'Hind'], ['Mi-35', 'Mi-35M'],
        ['Mi-28', 'Mi-28N', 'Mi-28NM', 'Havoc'], 'Mi-26', ['Mi-2', 'Hoplite'], ['Ka-50', 'Hokum'], ['Ka-52', 'Alligator'], ['Ka-226', 'Hoodlum'],
        ['Ka-27', 'Helix'], 'Ka-29', ['Ansat', 'Ansat-U'],
        ['Su-24', 'Su-24M', 'Su-24MR', 'Fencer'], ['Su-25', 'Su-25SM3', 'Frogfoot'], ['Su-27', 'Flanker'], ['Su-30', 'Su-30SM', 'Su-30MKK', 'Su-30MK2'],
        ['Su-34', 'Fullback'], 'Su-35', 'Su-57', ['MiG-29', 'Fulcrum'], ['MiG-31', 'MiG-31K', 'MiG-31BM', 'Foxhound'], ['Yak-130', 'Mitten'],
        ['Tu-22M', 'Tu-22M3'], 'Tu-95', 'Tu-160', ['A-50', 'A-50U', 'Mainstay'], 'Il-76', ['Il-20', 'Il-20M', 'Coot-A'], ['Il-22', 'Il-22PP', 'Porubshchik'],
        'Tu-214R', 'An-12', 'An-22', 'An-26',
        ['Orion', 'Inokhodets'], ['Forpost-R'], ['Okhotnik'], ['Altius', 'Altius-U', 'Altius-RU'],
        'UMPK', ['FAB-500', 'FAB-250', 'FAB-1500', 'FAB-3000'], ['KAB-500', 'KAB-1500'],
        ['Kh-31', 'Kh-31P'], 'Kh-58', 'Kh-59', 'Kh-101', 'Kh-22', 'Kh-32', ['Kinzhal', 'Kh-47M2']]),
    ...eqp('infantry', 'RU', [['AGS-17', 'Plamya'], 'AGS-30', 'AGS-40', ['NSV', 'Utyos'], 'Kord', ['DShK', 'DShKM'], ['PKM', 'PKP', 'Pecheneg']]),
    ...eqp('light', 'RU', [['UAZ-469', 'UAZ'], ['UAZ-452', 'Bukhanka'], ['Tigr', 'Tigr-M', 'GAZ-2330', 'GAZ-233014', 'GAZ-233114', 'GAZ-233036'],
        ['Vodnik', 'GAZ-3937', 'GAZ-39371'], ['Iveco LMV', 'LMV', 'Iveco Rys', 'Lince'], ['KamAZ-435029', 'Patrul-A'], ['Z-STS', 'Z-STS Akhmat'],
        ['AMN-590951', 'Spartak'], ['Sarmat-3', 'LSTC-1944'], 'Sarmat-2', ['Chaborz M-3', 'Chaborz'], ['Desertcross 1000-3', 'Desertcross']]),
    // Chinese. "Type NN" is given only where it means one thing (Type 89 is an
    // APC, a howitzer, a rocket launcher and a tank destroyer, so the PLA
    // designations ZSD-89, PLZ-89, PHZ-89 and PTZ-89 are used instead).
    // Brand words that name other things too (Shaanxi aircraft, Dongfeng
    // missiles, Lynx IFVs) are left out for their model numbers.
    ...eqp('armor', 'CN', [['Type 59', 'Type 59-II', 'WZ-120', 'ZTZ-59', 'Type 59D'], ['Type 62', 'ZTQ-62'], ['Type 63A', 'ZTS-63'],
        ['Type 69', 'Type 69-II'], 'Type 79', 'Type 80', ['Type 85', 'Type 85-II'], ['Type 88', 'ZTZ-88'],
        ['Type 96', 'ZTZ-96', 'Type 96A', 'Type 96B'], ['Type 98', 'ZTZ-98'], ['Type 99', 'ZTZ-99', 'Type 99A'],
        ['Type 100', 'ZTZ-100', 'ZTZ-201'], ['Type 15', 'ZTQ-15', 'VT5'], ['VT4', 'MBT-3000'], ['ZTL-11', 'ZLT-11', 'ST-1'],
        ['ZTD-05', 'VN16'], 'ST-3']),
    ...eqp('mech', 'CN', [['ZBD-04', 'Type 04', 'ZBD-04A', 'WZ-502'], ['ZBD-05', 'ZBD-2000', 'VN18'], 'ZBD-03',
        ['ZBD-86', 'Type 86', 'WZ-501', 'ZBD-86A'], ['ZSL-92', 'Type 92', 'WZ-551', 'ZSL-92A', 'ZSL-92B', 'VN2', 'CS/VN9'],
        ['ZBL-08', 'Type 08', 'ZBL-09', 'VN-1', 'VN1C'], 'ZBL-19', 'ZSL-10', 'ZSD-05', ['ZSL-93', 'WZ-523'], 'ZFB-91',
        ['ZFB-05', 'ZFB-05C'], ['ZSD-89', 'YW534', 'ZSD-89A'], ['ZSD-63', 'YW531'], ['YW531H', 'Type 85 APC'],
        'VN11', 'VN12', 'VN22', 'VN23', 'CS/VN4', 'CS/AA5', 'VS27']),
    ...eqp('recon', 'CN', ['ASN-206', ['ASN-207', 'WZ-6'], ['ASN-209', 'Silver Eagle'], ['BZK-005'], ['BZK-006', 'KDV001'],
        'BZK-007', 'BZK-008', 'BZK-009', ['WZ-7'], ['TB-001', 'Twin-Tailed Scorpion'], ['CH-3'], ['ZRY-222', 'ZRY222'],
        'VE36', 'VE32A', ['SLC-2'], ['Type 704']]),
    ...eqp('fires', 'CN', [['PLZ-05', 'PLZ-05A'], ['PLZ-07', 'PLZ-07A', 'PLZ-07B'], ['PLZ-83', 'PLZ-83A', 'PLZ-83B'], ['PLZ-89', 'SH-3'],
        'PLZ-10', 'PLZ-45', 'PCL-09', 'PCL-161', 'PCL-171', ['PCL-181', 'PLC-181', 'SH-15'], 'PLL-05', 'PLL-09',
        ['PCP-001', 'CS/SM1'], 'SH-1', 'SH-2', 'SH-5', 'SH-9', 'SH-11', ['SH-16', 'SH-16A'], 'CS/SH4', 'CS/SM4', 'CS/SM10',
        'CS/SS6', 'AH-2', 'AH-4', 'W90', ['PL-66', 'Type 66'], ['PL-96'], ['Type 59-1', 'PL-59', 'PL-59-1'], 'PL-54', 'PL-54-1',
        ['PL-83', 'Type 83 gun'], ['WZ-302', 'WZ302'],
        'PP-87', 'PP-89', 'PP-89-100', 'PP-93', 'PBP-201', 'PBP-172', 'W86', 'W84', 'QLT-89',
        'PHL-03', ['PHL-16', 'PCH-191', 'PCL-191'], ['PHL-11', 'SR-4'], 'PHZ-11', 'PHZ-89', ['PHL-81', 'Type 81'], 'PHL-90',
        ['PHL-20', 'SR-7'], 'PHL-21', ['PH-63', 'Type 63 MRL'], ['WZ-303', 'WZ303'],
        ['AR-1', 'AR-1A'], 'AR-2', 'AR-3', 'SR-5', 'WS-1', 'WS-2', 'WS-3', 'WS-22', 'WS-32', 'WS-33', 'WS-35', 'WS-600L',
        'SY-300', ['SY-400', 'BP-12A', 'BP-12'], 'A-200', 'A-300', 'WM-40', 'WM-80',
        'DF-11', 'DF-12', 'DF-15', 'DF-16', 'DF-17', 'DF-21', 'DF-26', 'DF-27', ['DF-31', 'DF-31AG'], 'DF-41', 'DF-61',
        'DF-5', 'CJ-10', ['CJ-100', 'DF-100'], 'CJ-1000', 'YJ-62', 'YJ-12',
        ['CH-901', 'FH-901'], ['ASN-301', 'JWS-01', 'Feilong-300A'], 'CM-501XA', 'CM-501GA', 'WS-43']),
    ...eqp('ad', 'CN', [['PGZ-04', 'PGZ-04A'], 'PGZ-07', 'PGZ-09', 'PGZ-88', 'PGZ-95', ['PGL-625', 'PLB-625', 'Type 625'],
        ['PGL-12', 'SWS2', 'SWS-2', 'LD35'], 'SWS3', 'PG-87', 'PG-99', 'PG-74', ['WZ-305', 'WZ305'], 'WZ-554',
        'LD-2000', 'LD-3000', 'FK-3000', 'CS/SA1', 'CS/SA5',
        ['HQ-2', 'HQ-2B', 'HQ-2J'], ['HQ-6', 'HQ-6A', 'HQ-6D'], ['HQ-7', 'HQ-7A', 'HQ-7B', 'FM-90'], ['HQ-9', 'HQ-9A', 'HQ-9B', 'HQ-9C', 'FD-2000'],
        ['HQ-10', 'HQ-10A'], 'HQ-11', ['HQ-12', 'KS-1A'], ['HQ-16', 'HQ-16A', 'HQ-16B', 'HQ-16C', 'LY-80'], ['HQ-17', 'HQ-17A', 'HQ-17AE'],
        'HQ-19', 'HQ-20', ['HQ-22', 'HQ-22A', 'FK-3'], 'HQ-29', 'HQ-61', ['HQ-64', 'LY-60'], ['Yitian', 'TY-90'], ['FB-10', 'FB-10A'],
        'QW-1', 'QW-2', 'QW-3', 'QW-4', 'QW-18', 'FN-6', 'FN-16', 'HN-5', 'HN-6', 'QN-202',
        ['OW5', 'OW5-A10', 'OW5-A50'], 'LY-1', ['Hurricane 3000', 'Hurricane-3000'],
        'JY-8', 'JY-9', 'JY-11', 'JY-14', 'JY-26', 'JY-27', ['JY-29', 'LSS-1'], 'JYL-1', 'JLG-43', 'YLC-2', 'YLC-4', 'YLC-6', 'YLC-8',
        'YLC-12', 'YLC-15', 'YLC-18', 'HT-233', 'H-200', 'SJ-231', 'SJ-202', ['LLQ120', 'Type 120 radar'], 'CLC-1', 'CLC-2', ['TR-47', 'TR47C']]),
    ...eqp('atgm', 'CN', [['HJ-73', 'HJ-73D', 'Red Arrow 73'], ['HJ-8', 'HJ-8E', 'AFT-8', 'Red Arrow 8'], 'HJ-9', ['HJ-10', 'AFT-10', 'Red Arrow 10'],
        ['HJ-11', 'AFT-11'], ['HJ-12', 'Red Arrow 12'], 'HJ-13', 'HJ-16', 'HJ-20', 'AFT-9', 'PF-89', 'PF-98', 'PF-11', 'PF-97', 'DZJ-08',
        'FHJ-01', 'FHJ-84', 'PF-78', 'PF-65', 'PF-56', 'PF-75', 'FPH-01', 'FPH-02', ['PTL-02', 'Type 02'], 'PTZ-89']),
    ...eqp('engineer', 'CN', [['WZ-621', 'WZ621'], 'GQL-110', 'GQL-111', 'GQL-120', 'GQL-321', 'GQL-410', 'GZM-003', 'GQC-003',
        'GCZ-110', 'GCZ-112', ['GPZ-111', 'GPZ-111A'], ['GSL-110', 'GSL-110A', 'GSL-110B'], ['GSL-111', 'WZ762A'], 'GSL-130', 'GSL-131',
        ['GSL-132', 'GBP-127'], 'GSL-133', 'GSL-134', 'GSL-211', ['GSL-411', 'GSL-241'], ['GSL-430', 'GBP-128'], 'GBP-126',
        ['GPJ221', 'GPJ-221'], ['ZRZ-100', 'ZRZ100'], 'GBL-120', 'GBL-130', 'GJW-320', 'GDG-130', 'Type 14']),
    ...eqp('logistics', 'CN', [['Shacman', 'SX2150', 'SX2190', 'SX2110', 'SX2220', 'SX2300', 'SX2306', 'HMV3'], ['Sinotruk', 'HOWO'],
        ['EQ2100', 'EQ2102', 'EQ245'], ['EQ2081', 'EQ240'], 'EQ1108', ['FAW MV3', 'MV3'], ['Taian', 'TA5450', 'TA4410', 'TA4360', 'TA5380'],
        ['Wanshan', 'WS580', 'WS2300', 'WS2400', 'WS2500', 'WS2600'], 'HY472', ['CA-141', 'CA141'], ['CA-30', 'CA30'], ['CA-10', 'CA10'],
        ['NJ-130', 'NJ130'], ['NJ-230', 'NJ230'], 'JY813', ['CWB-221', 'CWB221'], 'CSZ-181',
        'ZJX-93', ['WZ-653', 'WZ653', 'WZ653A'], 'VME-203', 'VME-102-40', 'Type 90-II ARV']),
    ...eqp('ew', 'CN', ['J-16D', 'J-15D', 'Y-8CA', 'Y-8CB', 'Y-8DZ', 'Y-8GX1', 'Y-8GX3', 'Y-8GX7', 'Y-8JB', 'Y-8EW', 'Y-9DZ', 'Y-9LG',
        ['DWL-002', 'DWL002'], 'CTL-181A EW']),
    ...eqp('air', 'CN', [['Z-8', 'Z-8L'], ['Z-9', 'Z-9W', 'Z-9WA', 'Z-9C'], ['Z-10', 'WZ-10', 'Z-10ME'], 'Z-11', 'Z-18', ['Z-19', 'WZ-19'],
        ['Z-20', 'Z-20T'], 'Z-21', ['H120', 'EC120'], 'SA342', 'S-70C2', ['J-10', 'J-10C'], 'J-11', 'J-15', 'J-16', 'J-20',
        ['J-35', 'J-35A'], 'J-7', ['J-8', 'J-8II'], 'Q-5', ['JH-7', 'JH-7A'], ['H-6', 'H-6K', 'H-6N', 'H-6J'], 'Y-5', 'Y-7', ['Y-8', 'Shaanxi Y-8'], ['Y-9', 'Shaanxi Y-9'],
        'Y-20', ['YY-20', 'YY-20A'], 'KJ-200', 'KJ-500', 'KJ-600', 'KJ-2000', 'CH-4', 'CH-5', 'KDV002',
        ['Wing Loong', 'GJ-1', 'GJ-2'], 'GJ-11', 'WZ-8']),
    ...eqp('light', 'CN', [['Mengshi', 'EQ2050', 'CSK-131'], 'CSK-141', 'CSK-181', ['CTL-181A', 'CTL181A'], ['BJ2022', 'Brave Warrior'],
        'BJ2020', 'BJ212', 'BJ80', ['NJ2045', 'NJ2046'], ['Lynx ATV', 'CS/VP16'], 'CS/VP4', 'CS/VP11', 'CS/VP15', 'CS/VP3', 'VP11',
        'VP22', ['VN3', 'CS/VN3'], 'VN4']),
    // Plain words, any army
    ...eqp('armor', '', [['tank', 'TANK', 'MBT']]),
    ...eqp('mech', '', [['IFV', 'IFV', 'APC', 'BMP', 'BMD', 'BTR', 'MRAP', 'ARMORED VEHICLE', 'ARMOURED VEHICLE']]),
    ...eqp('recon', '', [['recon', 'RECON', 'SCOUT', 'BRDM', 'UAV', 'UAS', 'DRONE', 'QUADCOPTER', 'UGV', 'MAVIC', 'DJI', 'MATRICE', 'AUTEL']]),
    ...eqp('fires', '', [['artillery', 'ARTILLERY', 'ARTY', 'HOWITZER', 'SPG', 'SP GUN', 'MORTAR', 'MLRS', 'MRL', 'ROCKET LAUNCHER'],
        ['FPV', 'FPV', 'LOITERING MUNITION', 'KAMIKAZE DRONE']]),
    ...eqp('ad', '', [['air defense', 'AIR DEFENSE', 'AIR DEFENCE', 'ADA', 'SAM', 'AAA', 'MANPADS']]),
    ...eqp('atgm', '', [['ATGM', 'ATGM', 'AT TEAM', 'RPG']]),
    ...eqp('engineer', '', [['engineer', 'ENGINEER', 'ENGINEERING', 'ENGR', 'ENG', 'SAPPER', 'CEV', 'BULLDOZER', 'DOZER', 'EXCAVATOR',
        'BACKHOE', 'BRIDGE', 'BRIDGE LAYER', 'AVLB', 'MINELAYER', 'MINE PLOW'], ['CBRN', 'CBRN', 'DECON', 'SMOKE GENERATOR']]),
    ...eqp('logistics', '', [['truck', 'TRUCK', 'LORRY', 'FUEL', 'FUELER', 'FUELLER', 'REFUELER', 'REFUELLER', 'TANKER', 'POL', 'CARGO',
        'AMMO', 'WATER', 'SUPPLY', 'SUPPORT', 'SPT', 'LOGPAC', 'WRECKER', 'TRAILER', 'RECOVERY VEHICLE'],
        ['ambulance', 'AMBULANCE', 'MEDEVAC']]),
    ...eqp('c2', '', [['command post', 'COMMAND POST', 'CP', 'HQ', 'C2', 'ANTENNA', 'RADIO RELAY', 'SATCOM']]),
    ...eqp('ew', '', [['jammer', 'JAMMER', 'EW', 'REB', 'ANTI-DRONE', 'DRONE GUN']]),
    ...eqp('air', '', [['helicopter', 'HELICOPTER', 'HELO', 'AIRCRAFT', 'JET']]),
    ...eqp('infantry', '', [['PAX', 'PAX', 'PERSONNEL', 'PERSON', 'PEOPLE', 'TROOP', 'SOLDIER', 'INFANTRY', 'DISMOUNT', 'MAN', 'MEN',
        'FIGHTER', 'SQUAD', 'TEAM', 'INDIVIDUAL']]),
    ...eqp('light', '', [['light vehicle', 'LIGHT VEHICLE', 'CAR', 'JEEP', 'PICKUP', 'SUV', 'TECHNICAL', 'MOTORCYCLE', 'MOTORBIKE', 'ATV', 'UTV', 'VAN', 'SEDAN',
        'BUGGY', 'QUAD BIKE', 'BUS']]),
    // A vehicle with no type given, as in MTI reports ("4x tracked"). The
    // longest word wins, so "engineer vic" is engineers and "support vic"
    // logistics; a vic, tracked or wheeled, with nothing more, comes here.
    ...eqp('vehicle', '', [['vehicle', 'VIC', 'VEHICLE', 'VEH'], ['tracked vehicle', 'TRACKED'], ['wheeled vehicle', 'WHEELED']]),
];
const normType = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
// Names to match, longest first so the most specific one wins.
const equipmentKeysOf = (entries) => entries.flatMap(([role, origin, name, ...more]) =>
    [...new Set([name, ...more])].map(k => {
        const words = normType(k), compact = words.replace(/ /g, '');
        const test = /\d/.test(compact)
            ? (w, c) => c.startsWith(compact) && !/\d/.test(c[compact.length] || '')
            : (w) => ` ${w} `.includes(` ${words} `);
        return { role, origin, name, len: compact.length, test };
    // The general vehicle words (vic, tracked, wheeled) come last, whatever
    // their length: "wheeled APC" is an APC, and only a bare vic is just a vehicle.
    })).filter(k => k.len).sort((a, b) => (a.role === 'vehicle') - (b.role === 'vehicle') || b.len - a.len);
let equipmentIndex = null;
const equipmentKeys = () => equipmentIndex || (equipmentIndex = equipmentKeysOf(EQUIPMENT_CATALOGUE));
const equipmentSeen = new Map();
const findKey = (keys, w) => {
    const hit = keys.find(k => k.test(w, w.replace(/ /g, '')));
    return hit ? { role: hit.role, origin: hit.origin, name: hit.name } : null;
};
// How much of a type as written the catalogue (and the team's entries,
// `team`, when given) knows: the length of the name it matches (TANK,
// MANPADS, RADIO RELAY), or 0.
const typesKnown = new Map();
const knownType = (text, team = null) => {
    const w = normType(text);
    if (!typesKnown.has(w)) {
        const hit = equipmentKeys().find(k => k.test(w, w.replace(/ /g, '')));
        typesKnown.set(w, hit ? hit.len : 0);
    }
    const own = team && team.length ? team.find(k => k.test(w, w.replace(/ /g, ''))) : null;
    return Math.max(typesKnown.get(w), own ? own.len : 0);
};
// { role, origin, name } for a type (T-72B3, 2S19 MSTA-S, trucks), or null.
// `team` is the team's own entries (teamEquipment), which win over the
// built-in ones: a type added, or a built-in one put right.
const lookupEquipment = (type, team = null) => {
    const w = normType(type);
    // "TANKS", "VICS": a plural that reaches here as it is (a team's type, a
    // BDA line) is tried as its singular (singularType, as the Statistics
    // fold it) when the whole doesn't match.
    const bareBy = (t) => { const one = normType(singularType(String(type || '').trim(), t)); return one && one !== w ? one : null; };
    const find = (keys, bare) => findKey(keys, w) || (bare ? findKey(keys, bare) : null);
    const own = team && team.length ? find(team, bareBy(team)) : null;
    if (own) return own;
    // The built-in answer doesn't depend on the team, so it is remembered.
    if (!equipmentSeen.has(w)) equipmentSeen.set(w, find(equipmentKeys(), bareBy(null)));
    return equipmentSeen.get(w);
};
// The team's entries ({ type, role, origin }), ready for lookupEquipment.
const teamEquipment = (list) => equipmentKeysOf((list || []).map(e => [e.role, e.origin || '', e.type]));
