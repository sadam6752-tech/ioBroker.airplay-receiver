'use strict';

/**
 * Distance from `b` to `a` on the 16 bit sequence circle (-32768 … 32767).
 *
 * @param {number} a - Sequence number
 * @param {number} b - Sequence number
 * @returns {number} a - b
 */
function seqDiff(a, b) {
    return ((((a - b) & 0xffff) + 0x8000) & 0xffff) - 0x8000;
}

/**
 * @typedef {object} PlayoutOptions
 * @property {number} frameMs - Duration of one packet in milliseconds
 * @property {number} holdMs - How long a gap waits for its retransmission before it is played as silence
 * @property {number} fillAfterMs - Silence is played when no packet came for this long (pause, song change)
 * @property {number} idleMs - After this long without packets the stream counts as idle
 * @property {(frame: Buffer | null) => void} onFrame - A frame in order; null = one frame of silence
 * @property {(seq: number, count: number) => void} onResend - Ask the sender for lost packets
 * @property {(active: boolean) => void} onActive - Audio started (true) or went idle (false)
 * @property {() => number} [now] - Clock (tests)
 */

/**
 * Puts the RTP packets of a sender back in order. A gap is asked for again at once and once more half way through
 * `holdMs`; packets behind a gap wait for it, and when the gap is still open after `holdMs` it becomes silence. While
 * the sender sends nothing (pause, next song) silence keeps the output going in real time, so the satellite's HTTP
 * stream does not run dry; after `idleMs` that stops and `onActive(false)` is reported.
 */
class Playout {
    /**
     * @param {PlayoutOptions} options - Options
     */
    constructor(options) {
        this.o = options;
        this.now = options.now || (() => Date.now());
        /** @type {Map<number, Buffer>} */
        this.frames = new Map();
        /** @type {Map<number, {since: number, asked: number}>} */
        this.missing = new Map();
        /** @type {number | null} */
        this.next = null;
        /** @type {number | null} */
        this.highest = null;
        this.lastArrival = 0;
        this.lastTick = 0;
        this.fillDebt = 0;
        this.active = false;
        this.stats = { received: 0, late: 0, resent: 0, recovered: 0, lost: 0, silence: 0 };
    }

    /**
     * A packet from the sender (also a retransmitted one).
     *
     * @param {number} seq - RTP sequence number
     * @param {Buffer} frame - Decrypted codec frame
     * @param {boolean} [resent] - Arrived as retransmission
     */
    push(seq, frame, resent = false) {
        const now = this.now();
        this.stats.received++;
        if (this.next === null || Math.abs(seqDiff(seq, this.next)) > 2000) {
            // first packet, or the sender jumped (new stream): start over here
            this.frames.clear();
            this.missing.clear();
            this.next = seq;
            this.highest = seq;
        }
        const d = seqDiff(seq, this.next);
        if (d < 0 || this.frames.has(seq)) {
            this.stats.late++;
            return;
        }
        if (this.missing.delete(seq) && resent) {
            this.stats.recovered++;
        }
        this.frames.set(seq, frame);
        const highest = /** @type {number} */ (this.highest);
        if (seqDiff(seq, highest) > 0) {
            const gap = seqDiff(seq, highest) - 1;
            if (gap > 0) {
                for (let i = 1; i <= gap; i++) {
                    this.missing.set((highest + i) & 0xffff, { since: now, asked: 1 });
                }
                this.stats.resent += gap;
                this.o.onResend((highest + 1) & 0xffff, gap);
            }
            this.highest = seq;
        }
        if (!resent) {
            this.lastArrival = now;
            this.fillDebt = 0;
        }
        if (!this.active) {
            this.active = true;
            this.o.onActive(true);
        }
        this.drain(now);
    }

    /**
     * Emits every frame that is ready.
     *
     * @param {number} now - Time
     */
    drain(now) {
        while (this.next !== null && this.highest !== null && seqDiff(this.highest, this.next) >= 0) {
            const frame = this.frames.get(this.next);
            if (frame) {
                this.frames.delete(this.next);
                this.o.onFrame(frame);
            } else {
                const gap = this.missing.get(this.next);
                if (gap && now - gap.since < this.o.holdMs) {
                    return; // still waiting for the retransmission
                }
                this.missing.delete(this.next);
                this.stats.lost++;
                this.o.onFrame(null);
            }
            this.next = (this.next + 1) & 0xffff;
        }
    }

    /**
     * Call every few milliseconds: gives up on gaps, asks again, keeps the output alive during pauses.
     */
    tick() {
        const now = this.now();
        const elapsed = this.lastTick ? Math.min(now - this.lastTick, 1000) : 0;
        this.lastTick = now;
        for (const [seq, gap] of this.missing) {
            if (gap.asked === 1 && now - gap.since >= this.o.holdMs / 2) {
                gap.asked = 2;
                this.o.onResend(seq, 1);
            }
        }
        this.drain(now);
        if (!this.active) {
            return;
        }
        const quiet = now - this.lastArrival;
        if (quiet >= this.o.idleMs) {
            this.active = false;
            this.fillDebt = 0;
            this.o.onActive(false);
            return;
        }
        if (quiet >= this.o.fillAfterMs && this.frames.size === 0) {
            this.fillDebt += elapsed;
            while (this.fillDebt >= this.o.frameMs) {
                this.fillDebt -= this.o.frameMs;
                this.stats.silence++;
                this.o.onFrame(null);
            }
        }
    }

    /**
     * FLUSH of the sender: drop what is buffered, the next packet starts a new run.
     */
    flush() {
        this.frames.clear();
        this.missing.clear();
        this.next = null;
        this.highest = null;
    }

    /**
     * End of the session.
     */
    reset() {
        this.flush();
        if (this.active) {
            this.active = false;
            this.o.onActive(false);
        }
    }
}

module.exports = { Playout, seqDiff };
