import * as fs from 'fs';
import * as path from 'path';
import * as process from 'process';
import { parseArgs } from 'util';
import { fileURLToPath } from 'url';

import { mergeDeep } from '../web_src/utils.js';

//---------------------------------------------------------------------------------------------------------------------
// Set up default directories

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let dataPath = path.join(__dirname, '../public/data');
let loggingLevelName = 'info';
let config = {
  game: 'all',
  delCustom: true,
  compare: true,
};

//---------------------------------------------------------------------------------------------------------------------
// Parse Command Line Options

const cliOptions = {
  dataPath: {
    type: 'string',
    short: 'd',
    default: dataPath,
    help: `{path} to marker JSONs [${dataPath}]`,
  },
  game: {
    type: 'string',
    short: 'g',
    default: config.game,
    help: `{game} to process (sl, slc, siu, all) [${config.game}]`,
  },
  delcustom: {
    type: 'boolean',
    default: config.ytdata,
    help: `delete custom data fields [${config.delCustom}]`,
  },
  compare: {
    type: 'boolean',
    default: config.compare,
    help: `compare instead of writing [${config.compare}]`,
  },
  logging: {
    type: 'string',
    short: 'l',
    default: loggingLevelName,
    help: `set logging level (quiet, error, info, debug) [${loggingLevelName}]`,
  },
  help: { type: 'boolean', short: 'h', default: false, help: 'display usage text' },
};
const args = parseArgs({ options: cliOptions, allowPositionals: false, strict: false, allowNegative: true });
args.unrecognisedOptions = Object.keys(args.values).some((x) => !(x in cliOptions));

// Set up based on arguments
dataPath = args.values.dataPath;
config.game = args.values.game;
config.delCustom = args.values.delcustom;
config.compare = args.values.compare;
loggingLevelName = args.values.logging;

const gameOptions = ['sl', 'slc', 'siu', 'sw'];
if (!gameOptions.includes(config.game) && config.game != 'all') {
  error_exit(`\nError: game option must be one of (${gameOptions.join(', ')}, all`);
}
config.games = config.game == 'all' ? gameOptions : [config.game];

//---------------------------------------------------------------------------------------------------------------------
// Setup logging functions
const loggingLevelNames = { quiet: 1, fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 };
function getLoggingLevel(levelName) {
  return loggingLevelNames[levelName] ?? loggingLevelNames.info;
}
const loggingLevel = getLoggingLevel(loggingLevelName);
function log() {
  console.log.apply(null, arguments);
}
function log_error() {
  if (loggingLevelNames.error <= loggingLevel) console.error.apply(null, arguments);
}
// eslint-disable-next-line no-unused-vars
function log_warn() {
  if (loggingLevelNames.error <= loggingLevel) console.warn.apply(null, arguments);
}
function log_info() {
  if (loggingLevelNames.info <= loggingLevel) console.info.apply(null, arguments);
}
// eslint-disable-next-line no-unused-vars
function log_debug() {
  if (loggingLevelNames.debug <= loggingLevel) console.debug.apply(null, arguments);
}
function log_trace() {
  if (loggingLevelNames.trace <= loggingLevel) console.log.apply(null, arguments);
}

function error_exit(msg) {
  log_error(msg);
  process.exit(-1);
}

//---------------------------------------------------------------------------------------------------------------------
// Usage information
if (args.values.help || args.positionals.length > 0 || args.unrecognisedOptions) {
  log('Usage: node mergemarkers.js [options]\noptions:');
  for (const [name, opt] of Object.entries(cliOptions)) {
    const optStr = `--${name}` + (opt.short ? `, -${opt.short}` : '');
    log(optStr, ' '.repeat(17 - optStr.length), opt.help);
  }
  if (!args.values.help) {
    log_error('\nError: unrecognised arguments:', process.argv.slice(2).join(' '));
  }
  process.exit();
}

//---------------------------------------------------------------------------------------------------------------------
// Log the command line
log_trace('loggingLevel:', args.values.logging, loggingLevel);
log_trace('dataPath:', dataPath);
log_trace('config', config);

//---------------------------------------------------------------------------------------------------------------------
// Read Json File
function readJsonFile(jsonPath) {
  if (fs.existsSync(jsonPath)) {
    log_debug('Reading JSON "' + jsonPath + '"');
    return JSON.parse(fs.readFileSync(jsonPath));
  } else {
    log_error('Error: file does not exist "' + jsonPath + '"');
    process.exit();
  }
}

//---------------------------------------------------------------------------------------------------------------------
// Write to Json File
function writeJsonFile(jsonData, jsonPath) {
  log_debug('Writing JSON "' + jsonPath + '"');
  fs.writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2), 'utf8');
}

//---------------------------------------------------------------------------------------------------------------------
// Load all marker data
function loadMarkers(game, dataPath, delCustom) {
  // Read the base marker file
  const markers = readJsonFile(path.join(dataPath, 'markers.' + game + '.json'));

  log_trace(markers.length, ' markers read');

  // Make a map from marker area:name to the marker objects
  function makeAlt(marker) {
    return marker.area + ':' + marker.name;
  }
  let markerMap = {};
  markers.forEach((marker) => {
    markerMap[makeAlt(marker)] = marker;
  });

  // Merge custom marker data into base markers
  function mergeCustomMarkers(markerMap, path) {
    const customMarkers = readJsonFile(path);
    log_trace(customMarkers.length, ' custom markers merged');
    customMarkers.forEach((marker) => {
      mergeDeep(markerMap[makeAlt(marker)], marker);
    });
  }

  // Custom-markers and custom youtube data
  mergeCustomMarkers(markerMap, path.join(dataPath, 'custom-markers.' + game + '.json'));
  mergeCustomMarkers(markerMap, path.join(dataPath, 'ytdata.' + game + '.json'));

  const customProperties = ['comment', 'spoiler_help', 'notes for dev', 'yt_video', 'yt_start', 'yt_end'];

  if (!delCustom) {
    markers.forEach((marker) => {
      customProperties.forEach((prop) => {
        delete marker[prop];
      });
    });
  }

  return markers;
}

// Note: If we added old_coins or targets we'd need to be more specific about how
// we compared them. And if we wanted to compare positions we'd probably want to
// round to nearest.
const compareProperties = [
  'type',
  'spawns',
  'coins',
  'cost',
  'loop',
  'price_type',
  'variant',
  'friendly',
  'other_pipe',
  'nearest_cap',
  'other_pad',
  'linetype',
  'twoway',
  'notsaved',
  'scrapamount',
];

function compareMarkers(newMarkers, oldMarkers) {
  const diffs = {};

  oldMarkers.forEach((marker) => {
    const alt = marker.area + ':' + marker.name;
    diffs[alt] = {};
    Object.keys(marker).forEach((prop) => {
      if (compareProperties.includes(prop)) {
        diffs[alt][prop] = marker[prop];
      }
    });
  });

  newMarkers.forEach((marker) => {
    const alt = marker.area + ':' + marker.name;
    if (alt in diffs) {
      Object.keys(marker).forEach((prop) => {
        if (compareProperties.includes(prop)) {
          if (diffs[alt][prop] == marker[prop]) {
            delete diffs[alt][prop];
          } else {
            if (Object.keys(diffs[alt]).includes(prop)) {
              diffs[alt][prop] = `${diffs[alt][prop]}->${marker[prop]}`;
            } else {
              diffs[alt][prop] = `+${marker[prop]}`;
            }
          }
        }
      });
      if (Object.keys(diffs[alt]) == 0) {
        delete diffs[alt];
      }
    } else {
      diffs[alt] = {};
      Object.keys(marker).forEach((prop) => {
        if (prop in compareProperties) {
          diffs[alt][prop] = `+${marker[prop]}`;
        }
      });
    }
  });
  const compareResult = [];
  let diffCount = 0;
  Object.keys(diffs).forEach((alt) => {
    const [area, name] = alt.split(':');
    const marker = { area, name, ...diffs[alt] };
    diffCount += Object.keys(diffs[alt]).length;
    compareResult.push(marker);
  });
  log_info(`Change count: ${diffCount}`);
  return compareResult;
}

//---------------------------------------------------------------------------------------------------------------------
// Read gameClasses and work out all variants used by them
const gameClasses = readJsonFile(path.join(dataPath, 'gameClasses.json'));

// Figure out what variants are used across all instances in our marker data and add them to game classes
for (const game of config.games) {
  const markers = loadMarkers(game, dataPath, config.delCustom);

  // Filter out markers that are marked for deletion, have no class config or won't appear on any layer
  const outMarkers = [];
  markers.forEach((marker) => {
    const gc = gameClasses[marker.type];
    if (
      gc &&
      marker.delete === undefined &&
      ((gc.layer && gc.layer != 'dev') || (gc.nospoiler && gc.nospoiler != 'dev'))
    ) {
      outMarkers.push(marker);
    }
  });

  log_info(`Game: ${game} read ${markers.length} filtered ${outMarkers.length}`);

  const outFile = path.join(dataPath, `markers-all.${game}.json`);
  if (config.compare) {
    const oldMarkers = readJsonFile(outFile);
    const markerDiffs = compareMarkers(outMarkers, oldMarkers);
    writeJsonFile(markerDiffs, path.join(dataPath, `markers-comp.${game}.json`));
  } else {
    writeJsonFile(outMarkers, outFile);
  }
}
