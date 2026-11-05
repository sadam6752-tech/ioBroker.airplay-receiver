'use strict';

const CONTAINERS = new Set(['mlit', 'mlcl', 'mcon', 'cmst', 'msrv', 'mdcl']);
const TEXT = { minm: 'title', asar: 'artist', asal: 'album', asgn: 'genre' };

/**
 * @typedef {object} TrackInfo
 * @property {string} [title] - Track title
 * @property {string} [artist] - Artist
 * @property {string} [album] - Album
 * @property {string} [genre] - Genre
 */

/**
 * Reads the track information of a DMAP block (`application/x-dmap-tagged`).
 *
 * @param {Buffer} data - DMAP bytes
 * @param {TrackInfo} [out] - Target
 * @returns {TrackInfo} Track information
 */
function parseDmap(data, out = {}) {
    let pos = 0;
    while (pos + 8 <= data.length) {
        const tag = data.toString('latin1', pos, pos + 4);
        const len = data.readUInt32BE(pos + 4);
        const start = pos + 8;
        const end = Math.min(start + len, data.length);
        if (CONTAINERS.has(tag)) {
            parseDmap(data.subarray(start, end), out);
        } else if (TEXT[tag]) {
            out[TEXT[tag]] = data.toString('utf8', start, end).trim();
        }
        pos = start + len;
    }
    return out;
}

/**
 * Builds DMAP bytes (for tests and the test sender).
 *
 * @param {Array<[string, Buffer | string]>} items - Tag and value
 * @returns {Buffer} DMAP bytes
 */
function buildDmap(items) {
    return Buffer.concat(
        items.map(([tag, value]) => {
            const v = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
            const head = Buffer.alloc(8);
            head.write(tag, 0, 'latin1');
            head.writeUInt32BE(v.length, 4);
            return Buffer.concat([head, v]);
        }),
    );
}

module.exports = { parseDmap, buildDmap };
