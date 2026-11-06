'use strict';

const os = require('node:os');

/**
 * @typedef {import('./types').ReceiverConfig} ReceiverConfig
 */

/** What the `media_title` text entity of the Waveshare firmware takes. */
const TITLE_MAX_BYTES = 48;

/**
 * Object id part of a name: letters with diacritics transliterated, everything else `_`.
 *
 * @param {string} name - Name
 * @returns {string} Id
 */
function toId(name) {
    const map = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue' };
    const ascii = String(name)
        .replace(/[äöüßÄÖÜ]/g, c => map[c])
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '');
    return (
        ascii
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, '_')
            .replace(/^_+|_+$/g, '') || 'receiver'
    );
}

/**
 * Splits `<satellite>.<player>` (the player column of version 0.0.x) into its parts.
 *
 * @param {string} value - Player reference
 * @returns {{satellite: string, player: string} | null} Parts
 */
function splitPlayer(value) {
    const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(value || '').trim());
    return m ? { satellite: m[1], player: m[2] } : null;
}

const CODECS = ['flac', 'mp3'];

/**
 * @typedef {object} Stream
 * @property {'flac' | 'mp3'} codec - Codec
 * @property {number} sampleRate - 44100 or 48000
 * @property {number} channels - 1 or 2
 */

/**
 * Reads a stream setting `<codec>/<rate>/<channels>`.
 *
 * @param {unknown} value - e.g. `flac/48000/1`; `auto` or empty = the preset
 * @returns {Stream | null} Stream, null = take the preset
 */
function parseStream(value) {
    const [codec, rate, ch] = String(value || '').split('/');
    if (!CODECS.includes(codec)) {
        return null;
    }
    return {
        codec: /** @type {'flac' | 'mp3'} */ (codec),
        sampleRate: Number(rate) === 44100 ? 44100 : 48000,
        channels: Number(ch) === 2 ? 2 : 1,
    };
}

/**
 * Reads a stop value as typed: `true`/`false` and numbers keep their type, everything else is text.
 *
 * @param {unknown} value - Setting
 * @returns {ioBroker.StateValue} Value to write
 */
function parseStopValue(value) {
    if (typeof value === 'boolean' || typeof value === 'number') {
        return value;
    }
    const t = String(value ?? '').trim();
    if (t === 'true' || t === 'false') {
        return t === 'true';
    }
    if (t !== '' && Number.isFinite(Number(t))) {
        return Number(t);
    }
    return t;
}

/**
 * @typedef {object} Preset
 * @property {'assistant' | 'dune' | 'custom'} kind - Kind of target
 * @property {string} stopState - Stop state
 * @property {ioBroker.StateValue} stopValue - Stop value
 * @property {string} volumeState - Volume state, empty = none
 * @property {string} titleState - Title state, empty = none
 * @property {number} titleBytes - Byte limit of the title, 0 = none
 * @property {string} stream - Stream setting
 */

/**
 * What a play URL state belongs to, and the states and the stream that go with it.
 *
 * @param {string} urlState - Id of the play URL state
 * @returns {Preset} Preset
 */
function presetFor(urlState) {
    const sat = /^(.+\.satellites\.[^.]+)\.controls\.([^.]+)\.url$/.exec(urlState);
    if (sat) {
        // ioBroker.assistant satellite: the ESPHome firmware decodes FLAC 48 kHz mono, "stop" stops
        return {
            kind: 'assistant',
            stopState: urlState,
            stopValue: 'stop',
            volumeState: `${sat[1]}.controls.${sat[2]}.volume`,
            titleState: `${sat[1]}.controls.media_title`,
            titleBytes: TITLE_MAX_BYTES,
            stream: 'flac/48000/1',
        };
    }
    const dune = /^(dune-hd-remote\.\d+)\.media\.playUrl$/.exec(urlState);
    if (dune) {
        // ioBroker.dune-hd-remote: a stop button and a volume of 0 … 100 %
        return {
            kind: 'dune',
            stopState: `${dune[1]}.control.stop`,
            stopValue: true,
            volumeState: `${dune[1]}.control.volume`,
            titleState: '',
            titleBytes: 0,
            stream: 'mp3/44100/2',
        };
    }
    // any other player: MP3 like an internet radio, an empty URL stops
    return {
        kind: 'custom',
        stopState: urlState,
        stopValue: '',
        volumeState: '',
        titleState: '',
        titleBytes: 0,
        stream: 'mp3/44100/2',
    };
}

/**
 * A state id the user typed: empty = take the preset, `-` = none.
 *
 * @param {unknown} value - Setting
 * @param {string} preset - Value of the preset
 * @returns {string} State id or empty
 */
function stateOrPreset(value, preset) {
    const t = String(value ?? '').trim();
    if (t === '-') {
        return '';
    }
    return t || preset;
}

/**
 * @param {string} id - State id
 * @returns {boolean} A plausible id of a foreign state
 */
function validStateId(id) {
    return /^[^\s*?"'`]+\.[^\s*?"'`]+$/.test(id);
}

/**
 * Reads the receiver table of the settings. Rows without a name or play URL state are skipped with a reason. Rows of
 * version 0.0.x (`player: "<satellite>.<player>"`) are read as the matching ioBroker.assistant state.
 *
 * @param {unknown} rows - `native.receivers`
 * @param {string} [assistant] - Instance of ioBroker.assistant for old rows
 * @returns {{receivers: ReceiverConfig[], problems: string[]}} Receivers and skipped rows
 */
function normalizeReceivers(rows, assistant = 'assistant.0') {
    /** @type {Array<Record<string, unknown>>} */
    const list = Array.isArray(rows) ? rows : rows && typeof rows === 'object' ? Object.values(rows) : [];
    /** @type {ReceiverConfig[]} */
    const receivers = [];
    const problems = [];
    const ids = new Set();
    list.forEach((row, i) => {
        if (!row || row.enabled === false) {
            return;
        }
        const name = String(row.name || '').trim();
        if (!name) {
            problems.push(`Row ${i + 1}: the AirPlay name is missing`);
            return;
        }
        const old = splitPlayer(String(row.player || ''));
        const urlState =
            String(row.urlState || '').trim() ||
            (old ? `${assistant}.satellites.${old.satellite}.controls.${old.player}.url` : '');
        if (!validStateId(urlState)) {
            problems.push(`Row ${i + 1} (${name}): choose the state that plays a URL`);
            return;
        }
        const id = toId(name);
        if (ids.has(id)) {
            problems.push(`Row ${i + 1} (${name}): the name is used twice`);
            return;
        }
        ids.add(id);
        const preset = presetFor(urlState);
        const stopState = stateOrPreset(row.stopState, preset.stopState) || urlState;
        const typedStop = String(row.stopValue ?? '').trim();
        // a stop state of its own without a value is a button
        const stopValue =
            typedStop !== '' ? parseStopValue(typedStop) : stopState === preset.stopState ? preset.stopValue : true;
        const titleState = stateOrPreset(row.titleState, preset.titleState);
        const oldFormat = old && CODECS.includes(String(row.format)) ? `${row.format}/48000/1` : '';
        const stream =
            parseStream(row.stream) || parseStream(oldFormat) || /** @type {Stream} */ (parseStream(preset.stream));
        const port = Number(row.rtspPort) || 0;
        receivers.push({
            id,
            name,
            kind: preset.kind,
            urlState,
            stopState,
            stopValue,
            volumeState: stateOrPreset(row.volumeState, preset.volumeState),
            titleState,
            titleBytes: titleState === preset.titleState ? preset.titleBytes : 0,
            codec: stream.codec,
            sampleRate: stream.sampleRate,
            channels: stream.channels,
            rtspPort: port > 0 && port < 65536 ? port : 0,
        });
    });
    return { receivers, problems };
}

/**
 * The receiver rows of version 0.0.x in the form of 0.1: the player column becomes the play URL state.
 *
 * @param {unknown} rows - `native.receivers`
 * @param {string} assistant - Instance of ioBroker.assistant
 * @returns {Array<Record<string, unknown>> | null} New rows, null = nothing to migrate
 */
function migrateRows(rows, assistant) {
    if (!Array.isArray(rows) || !rows.some(r => r && r.player && !r.urlState)) {
        return null;
    }
    return rows.map(row => {
        const old = row && splitPlayer(String(row.player || ''));
        if (!old || row.urlState) {
            return row;
        }
        const { player: _player, format, ...rest } = row;
        return {
            ...rest,
            urlState: `${assistant}.satellites.${old.satellite}.controls.${old.player}.url`,
            stream: format === 'mp3' ? 'mp3/48000/1' : 'auto',
        };
    });
}

/**
 * Players of ioBroker.assistant from their `url` states: `<instance>.satellites.<sat>.controls.<player>.url`.
 *
 * @param {string} instance - e.g. `assistant.0`
 * @param {string[]} ids - State ids
 * @returns {Array<{satellite: string, player: string}>} Players
 */
function playersFromIds(instance, ids) {
    const prefix = `${instance}.satellites.`;
    const out = [];
    for (const id of ids) {
        if (!id.startsWith(prefix)) {
            continue;
        }
        const m = /^([^.]+)\.controls\.([^.]+)\.url$/.exec(id.slice(prefix.length));
        if (m) {
            out.push({ satellite: m[1], player: m[2] });
        }
    }
    return out.sort((a, b) => `${a.satellite}.${a.player}`.localeCompare(`${b.satellite}.${b.player}`));
}

/**
 * The states an AirPlay speaker can play on: writable states with role `media.url`.
 *
 * @param {Record<string, ioBroker.Object>} objects - State objects
 * @param {string} own - Own namespace, left out
 * @returns {Array<{label: string, value: string}>} Choices for the admin
 */
function urlStateChoices(objects, own) {
    const out = [];
    for (const [id, obj] of Object.entries(objects || {})) {
        const c = /** @type {Partial<ioBroker.StateCommon>} */ (obj?.common || {});
        if (obj?.type !== 'state' || c.role !== 'media.url' || c.write === false || id.startsWith(`${own}.`)) {
            continue;
        }
        const name = typeof c.name === 'object' && c.name ? c.name.en || Object.values(c.name)[0] : c.name;
        out.push({ label: name ? `${id} (${name})` : id, value: id });
    }
    return out.sort((a, b) => a.value.localeCompare(b.value));
}

/**
 * AirPlay volume (dB, -30 … 0, -144 = mute) as level 0 … 1.
 *
 * @param {number} db - AirPlay volume
 * @returns {number} Level
 */
function volumeLevel(db) {
    if (!Number.isFinite(db) || db <= -30) {
        return 0;
    }
    return Math.round(Math.min(1, (db + 30) / 30) * 100) / 100;
}

/**
 * The value a volume state takes for a level 0 … 1: its `min` … `max` (0 … 1 without a max; whole numbers for a
 * larger range such as 0 … 100 %).
 *
 * @param {number} level - 0 … 1
 * @param {{min?: unknown, max?: unknown}} [common] - common of the volume state
 * @returns {number} Value
 */
function scaleVolume(level, common = {}) {
    const num = (v, d) => (v !== undefined && v !== null && Number.isFinite(Number(v)) ? Number(v) : d);
    const min = num(common.min, 0);
    const max = num(common.max, 1);
    const v = min + Math.max(0, Math.min(1, level)) * (max - min);
    return max - min > 1 ? Math.round(v) : Math.round(v * 100) / 100;
}

/**
 * Text for a display: "Artist – Title", cut to `maxBytes` of UTF-8 (the Waveshare firmware takes 48; Cyrillic counts
 * twice), never inside a character, with "…" when it was cut.
 *
 * @param {{title?: string, artist?: string}} info - Track information
 * @param {number} [maxBytes] - Limit of the text, 0 = none
 * @returns {string} Display text
 */
function displayTitle(info, maxBytes = TITLE_MAX_BYTES) {
    return fitTitle([info.artist, info.title].filter(Boolean).join(' – '), maxBytes);
}

/**
 * Text cut to a byte limit.
 *
 * @param {string} text - Text
 * @param {number} [maxBytes] - Limit, 0 = none
 * @returns {string} Text that fits
 */
function fitTitle(text, maxBytes = TITLE_MAX_BYTES) {
    if (!maxBytes || Buffer.byteLength(text) <= maxBytes) {
        return text;
    }
    let out = '';
    for (const ch of text) {
        if (Buffer.byteLength(`${out}${ch}…`) > maxBytes) {
            break;
        }
        out += ch;
    }
    return `${out.trimEnd()}…`;
}

/**
 * The address a player reaches this host on: the configured one, else the address the sender used (IPv4), else the
 * first external IPv4 address of the host.
 *
 * @param {string} configured - `native.urlHost`
 * @param {string} [local] - Local address of the sender's connection
 * @returns {string} Host for the stream URL
 */
function streamHost(configured, local) {
    const c = String(configured || '').trim();
    if (c) {
        return c;
    }
    const l = String(local || '').replace(/^::ffff:/, '');
    if (/^\d+\.\d+\.\d+\.\d+$/.test(l) && !l.startsWith('127.')) {
        return l;
    }
    for (const list of Object.values(os.networkInterfaces())) {
        for (const a of list || []) {
            if (a.family === 'IPv4' && !a.internal) {
                return a.address;
            }
        }
    }
    return '127.0.0.1';
}

module.exports = {
    toId,
    splitPlayer,
    parseStream,
    parseStopValue,
    presetFor,
    normalizeReceivers,
    migrateRows,
    playersFromIds,
    urlStateChoices,
    volumeLevel,
    scaleVolume,
    displayTitle,
    fitTitle,
    streamHost,
};
