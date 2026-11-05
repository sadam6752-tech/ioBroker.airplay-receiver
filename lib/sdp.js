'use strict';

/**
 * @typedef {object} AudioFormat
 * @property {'alac' | 'pcm'} codec - Codec of the RTP payload
 * @property {number} frameLength - Samples per packet and channel
 * @property {number} sampleRate - Sample rate
 * @property {number} channels - Channels
 * @property {number} bitDepth - Bits per sample
 * @property {Buffer | null} cookie - ALAC magic cookie (ALACSpecificConfig, 24 bytes)
 */

/**
 * @typedef {object} Announce
 * @property {AudioFormat} format - Audio format
 * @property {Buffer | null} aesKey - Encrypted AES key, base64 (null = unencrypted stream)
 * @property {Buffer | null} aesIv - AES IV
 * @property {string} rsaaeskey - Raw `rsaaeskey`
 * @property {string} info - Session information (`i=` line, often the sender name)
 * @property {number} minLatency - `a=min-latency` in samples, 0 if missing
 */

/**
 * Builds the 24 byte ALACSpecificConfig from the `fmtp` values of an AirPlay sender:
 * `96 352 0 16 40 10 14 2 255 0 0 44100` = payload type, frameLength, compatibleVersion, bitDepth, pb, mb, kb,
 * numChannels, maxRun, maxFrameBytes, avgBitRate, sampleRate.
 *
 * @param {number[]} v - fmtp numbers without the payload type
 * @returns {Buffer} Magic cookie
 */
function alacCookie(v) {
    const b = Buffer.alloc(24);
    b.writeUInt32BE(v[0] >>> 0, 0);
    b.writeUInt8(v[1] & 0xff, 4);
    b.writeUInt8(v[2] & 0xff, 5);
    b.writeUInt8(v[3] & 0xff, 6);
    b.writeUInt8(v[4] & 0xff, 7);
    b.writeUInt8(v[5] & 0xff, 8);
    b.writeUInt8(v[6] & 0xff, 9);
    b.writeUInt16BE(v[7] & 0xffff, 10);
    b.writeUInt32BE(v[8] >>> 0, 12);
    b.writeUInt32BE(v[9] >>> 0, 16);
    b.writeUInt32BE(v[10] >>> 0, 20);
    return b;
}

/**
 * Reads the SDP of an ANNOUNCE.
 *
 * @param {string} text - SDP body
 * @returns {Announce} Session parameters
 */
function parseSdp(text) {
    /** @type {Record<string, string>} */
    const attrs = {};
    let info = '';
    for (const raw of String(text).split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith('a=')) {
            const i = line.indexOf(':');
            if (i > 0) {
                attrs[line.slice(2, i)] = line.slice(i + 1).trim();
            }
        } else if (line.startsWith('i=')) {
            info = line.slice(2).trim();
        }
    }
    const rtpmap = attrs.rtpmap || '';
    /** @type {AudioFormat} */
    let format;
    if (/AppleLossless/i.test(rtpmap)) {
        const v = String(attrs.fmtp || '')
            .split(/\s+/)
            .slice(1)
            .map(Number);
        if (v.length < 11 || v.some(n => !Number.isFinite(n))) {
            throw new Error(`ALAC parameters missing or broken: "${attrs.fmtp || ''}"`);
        }
        format = {
            codec: 'alac',
            frameLength: v[0],
            bitDepth: v[2],
            channels: v[6],
            sampleRate: v[10],
            cookie: alacCookie(v),
        };
    } else if (/L16/i.test(rtpmap)) {
        // "96 L16/44100/2"
        const [, rate = '44100', channels = '2'] = rtpmap.split(/\s+/)[1]?.split('/') || [];
        format = {
            codec: 'pcm',
            frameLength: 352,
            bitDepth: 16,
            channels: Number(channels) || 2,
            sampleRate: Number(rate) || 44100,
            cookie: null,
        };
    } else {
        throw new Error(`Unsupported audio format "${rtpmap}" (only ALAC and PCM)`);
    }
    if (format.bitDepth !== 16 || format.channels < 1 || format.channels > 2 || format.frameLength < 1) {
        throw new Error(`Unsupported audio parameters: ${format.bitDepth} bit, ${format.channels} channels`);
    }
    const rsaaeskey = attrs.rsaaeskey || '';
    return {
        format,
        aesKey: rsaaeskey ? Buffer.from(rsaaeskey, 'base64') : null,
        aesIv: attrs.aesiv ? Buffer.from(attrs.aesiv, 'base64') : null,
        rsaaeskey,
        info,
        minLatency: Number(attrs['min-latency']) || 0,
    };
}

module.exports = { parseSdp, alacCookie };
