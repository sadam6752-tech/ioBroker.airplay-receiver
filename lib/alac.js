'use strict';

// ALAC frames this adapter writes itself: the "escape" form, which carries the samples uncompressed. ffmpeg decodes
// them like any other ALAC frame, so silence (a lost packet, a pause) and the test sender need no ALAC encoder.

/**
 * Writes bits most significant first.
 */
class BitWriter {
    /**
     * @param {number} bytes - Size of the buffer
     */
    constructor(bytes) {
        this.buffer = Buffer.alloc(bytes);
        this.bit = 0;
    }

    /**
     * @param {number} value - Unsigned value
     * @param {number} bits - Number of bits (at most 32)
     */
    write(value, bits) {
        for (let i = bits - 1; i >= 0; i--) {
            if (Math.floor(value / 2 ** i) % 2) {
                this.buffer[this.bit >> 3] |= 0x80 >> (this.bit & 7);
            }
            this.bit++;
        }
    }

    /** @returns {Buffer} Written bytes */
    bytes() {
        return this.buffer.subarray(0, (this.bit + 7) >> 3);
    }
}

/**
 * An uncompressed ALAC frame.
 *
 * @param {Int16Array} samples - Interleaved 16 bit samples
 * @param {number} channels - 1 or 2
 * @param {number} frameLength - Samples per channel of a full frame (from the magic cookie)
 * @returns {Buffer} ALAC frame
 */
function escapeFrame(samples, channels, frameLength) {
    const count = Math.floor(samples.length / channels);
    const partial = count !== frameLength;
    const w = new BitWriter(8 + Math.ceil((count * channels * 16) / 8) + 8);
    w.write(channels === 2 ? 1 : 0, 3); // element: CPE (stereo) or SCE (mono)
    w.write(0, 4); // element instance tag
    w.write(0, 12); // unused
    w.write(partial ? 1 : 0, 1); // the frame carries its sample count
    w.write(0, 2); // bytes shifted
    w.write(1, 1); // escape: uncompressed
    if (partial) {
        w.write(count, 32);
    }
    for (let i = 0; i < count * channels; i++) {
        w.write(samples[i] & 0xffff, 16);
    }
    w.write(7, 3); // end
    return Buffer.from(w.bytes());
}

/** @type {Map<string, Buffer>} */
const silenceCache = new Map();

/**
 * A full frame of silence.
 *
 * @param {number} channels - 1 or 2
 * @param {number} frameLength - Samples per channel
 * @returns {Buffer} ALAC frame
 */
function silenceFrame(channels, frameLength) {
    const key = `${channels}/${frameLength}`;
    let frame = silenceCache.get(key);
    if (!frame) {
        frame = escapeFrame(new Int16Array(channels * frameLength), channels, frameLength);
        silenceCache.set(key, frame);
    }
    return frame;
}

module.exports = { escapeFrame, silenceFrame, BitWriter };
