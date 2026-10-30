// SPDX-License-Identifier: AGPL-3.0-only
// The SaltCore object, its export, and the close of the function. The build joins the src/core/ parts in name order inside one function, so they share one scope.

const SaltCore = {
    plural, zoneMark, timeAgo,
    pad2, dateFields, clockValue, fileStamp, toTimeString, autoColon, parseFilterTime, typedTime, submittedTime, parseCsvTime,
    escapeHtml, safeColor, safeFilename,
    atoPrefix, reportNum, duplicateIds, nextNum, displayId, formatFullId, reportText, normalizeLocation, mgrsPrefix, applyMgrsPrefix, stripMgrsPrefix, mgrsLockChecks,
    BDA_EFFECTS, bdaElements, bdaSummary, bdaRollup, bdaCount, bdaPending,
    backupFilename, foldOverlays, overlayKey, cleanTags, TAG_ID, backupText, allWorkspacesBackupText, parseBackup,
    parseCsv, reportsCsv, mtiCsvs,
    utmToLatLon, gridToLatLon, latLonToMgrs, findGrids, findRefs, overlayRef, geometryContains, metersToGeometry,
    webMercatorToLonLat, readDbf, shapefileProjection, parseShapefile,
    reportTracks, reportPositions, heatPoints, activityMatches, arcgisTrackRows, arcgisTracksGeoJson, arcgisTracksEsriJson,
    lonLatToMerc, MERC_WORLD, compass16, zipStore, crc32, shapefileParts, arcgisShapefileZip, arcgisTracksShapefileZip, tilesFor, tileZoom, tileUrl, wmsUrl, wmsCapabilitiesUrl, pickWmsCrs, pickWmsFormat, mercToLonLat, metersBetween, bearingBetween,
    asArea, analyzeLocation, locationPlan, editLocation, classifyActivity, ACTIVITY_TAGS, arcgisRows, arcgisGeoJson, arcgisEsriJson, arcgisCsv,
    sizeElements, gridSquare, statsData, statsCsv, PL_NEAR_METERS, workbookReportRows, statsXlsx, excelSerial, colName,
    dtg, summaryReport, summaryDetail, summaryPlaces, EQUIPMENT_CATALOGUE, EQUIPMENT_ROLES, lookupEquipment, teamEquipment, ECHELONS, echelonOf, ICD203, NARRATIVE_RULES, DOCTRINE,
    reportKey, knownVersions, changedReports, withUnsaved,
    MOVEMENT_CLASSES, formatDistance, speedUnit, kmhPerSpeedUnit, formatSpeed, formatArea, formatDuration, formatBearing,
    pathMeters, areaMeters, ringPoints, movementClass, MARCH_MAX_KMH, marchRates,
    nearestSegment, AXIS_NEAR_METERS, wayOfMarchAt, axesOf, wayRelation,
};

if (typeof module === 'object' && module.exports) module.exports = SaltCore;
else root.SaltCore = SaltCore;
})(typeof globalThis !== 'undefined' ? globalThis : this);
