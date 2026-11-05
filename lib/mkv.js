'use strict';

// A minimal live Matroska stream: ffmpeg needs a container to decode ALAC (there is no raw ALAC demuxer), and
// Matroska carries the magic cookie as CodecPrivate. The segment has an unknown size, every frame gets its own
// small cluster, so ffmpeg can decode each frame as soon as it arrives.

/**
 * @param {number} size - Element size
 * @returns {Buffer} EBML variable size integer
 */
function vint(size) {
    for (let len = 1; len <= 8; len++) {
        if (size < 2 ** (7 * len) - 1) {
            const b = Buffer.alloc(len);
            let v = size;
            for (let i = len - 1; i >= 0; i--) {
                b[i] = v % 256;
                v = Math.floor(v / 256);
            }
            b[0] |= 0x80 >> (len - 1);
            return b;
        }
    }
    throw new Error('EBML element too large');
}

/**
 * @param {number} id - Element id with its length marker (e.g. 0x1a45dfa3)
 * @returns {Buffer} Id bytes
 */
function idBytes(id) {
    const out = [];
    let v = id;
    while (v > 0) {
        out.unshift(v % 256);
        v = Math.floor(v / 256);
    }
    return Buffer.from(out);
}

/**
 * @param {number} id - Element id
 * @param {Buffer | Buffer[]} data - Content or children
 * @returns {Buffer} Element
 */
function el(id, data) {
    const body = Array.isArray(data) ? Buffer.concat(data) : data;
    return Buffer.concat([idBytes(id), vint(body.length), body]);
}

/**
 * @param {number} id - Element id
 * @param {number} value - Unsigned integer
 * @returns {Buffer} Element
 */
function uint(id, value) {
    const out = [];
    let v = value;
    do {
        out.unshift(v % 256);
        v = Math.floor(v / 256);
    } while (v > 0);
    return el(id, Buffer.from(out));
}

/**
 * @param {number} id - Element id
 * @param {string} value - ASCII or UTF-8 string
 * @returns {Buffer} Element
 */
function str(id, value) {
    return el(id, Buffer.from(value, 'utf8'));
}

/**
 * @param {number} id - Element id
 * @param {number} value - Float
 * @returns {Buffer} Element
 */
function float(id, value) {
    const b = Buffer.alloc(8);
    b.writeDoubleBE(value);
    return el(id, b);
}

/**
 * Header of the stream: EBML header, segment of unknown size, info and the single audio track.
 *
 * @param {import('./sdp').AudioFormat} format - Audio format
 * @returns {Buffer} Header bytes
 */
function header(format) {
    const ebml = el(0x1a45dfa3, [
        uint(0x4286, 1),
        uint(0x42f7, 1),
        uint(0x42f2, 4),
        uint(0x42f3, 8),
        str(0x4282, 'matroska'),
        uint(0x4287, 4),
        uint(0x4285, 2),
    ]);
    const info = el(0x1549a966, [
        uint(0x2ad7b1, 1_000_000),
        str(0x4d80, 'airplay-receiver'),
        str(0x5741, 'airplay-receiver'),
    ]);
    const audio = el(0xe1, [
        float(0xb5, format.sampleRate),
        uint(0x9f, format.channels),
        uint(0x6264, format.bitDepth),
    ]);
    const track = el(0xae, [
        uint(0xd7, 1),
        uint(0x73c5, 1),
        uint(0x83, 2),
        str(0x86, format.codec === 'alac' ? 'A_ALAC' : 'A_PCM/INT/BIG'),
        ...(format.codec === 'alac' && format.cookie ? [el(0x63a2, format.cookie)] : []),
        audio,
    ]);
    const tracks = el(0x1654ae6b, [track]);
    const segmentStart = Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    return Buffer.concat([ebml, segmentStart, info, tracks]);
}

/**
 * One frame in its own cluster.
 *
 * @param {Buffer} frame - Codec frame
 * @param {number} timeMs - Time stamp in milliseconds
 * @returns {Buffer} Cluster bytes
 */
function cluster(frame, timeMs) {
    const block = Buffer.concat([Buffer.from([0x81, 0x00, 0x00, 0x80]), frame]);
    return el(0x1f43b675, [uint(0xe7, Math.max(0, Math.round(timeMs))), el(0xa3, block)]);
}

module.exports = { header, cluster, vint };
