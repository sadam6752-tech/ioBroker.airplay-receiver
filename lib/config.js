'use strict';

const os = require('node:os');

/**
 * @typedef {import('./types').ReceiverConfig} ReceiverConfig
 */

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
 * Splits `<satellite>.<player>` (the value the admin list writes) into its parts.
 *
 * @param {string} value - Player reference
 * @returns {{satellite: string, player: string} | null} Parts
 */
function splitPlayer(value) {
    const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(value || '').trim());
    return m ? { satellite: m[1], player: m[2] } : null;
}

/**
 * Reads the receiver table of the settings. Rows without a name or player are skipped with a reason.
 *
 * @param {unknown} rows - `native.receivers`
 * @returns {{receivers: ReceiverConfig[], problems: string[]}} Receivers and skipped rows
 */
function normalizeReceivers(rows) {
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
        const target = splitPlayer(String(row.player || ''));
        if (!name) {
            problems.push(`Row ${i + 1}: the AirPlay name is missing`);
            return;
        }
        if (!target) {
            problems.push(`Row ${i + 1} (${name}): choose a player as "<satellite>.<player>"`);
            return;
        }
        const id = toId(name);
        if (ids.has(id)) {
            problems.push(`Row ${i + 1} (${name}): the name is used twice`);
            return;
        }
        ids.add(id);
        const port = Number(row.rtspPort) || 0;
        receivers.push({
            id,
            name,
            satellite: target.satellite,
            player: target.player,
            rtspPort: port > 0 && port < 65536 ? port : 0,
            format: row.format === 'mp3' ? 'mp3' : 'flac',
        });
    });
    return { receivers, problems };
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

/** What the `media_title` text entity of the Waveshare firmware takes. */
const TITLE_MAX_BYTES = 48;

/**
 * Text for the display of the satellite: "Artist – Title", cut to what the firmware accepts (bytes of UTF-8, so
 * Cyrillic counts twice), never inside a character, with "…" when it was cut.
 *
 * @param {{title?: string, artist?: string}} info - Track information
 * @param {number} [maxBytes] - Limit of the text entity
 * @returns {string} Display text
 */
function displayTitle(info, maxBytes = TITLE_MAX_BYTES) {
    const text = [info.artist, info.title].filter(Boolean).join(' – ');
    if (Buffer.byteLength(text) <= maxBytes) {
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
 * The address a satellite reaches this host on: the configured one, else the address the sender used (IPv4), else the
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

module.exports = { toId, splitPlayer, normalizeReceivers, playersFromIds, volumeLevel, displayTitle, streamHost };
