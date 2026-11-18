'use strict';

// One warning per network outage instead of one per mDNS packet.

const assert = require('node:assert/strict');
const { ErrorDigest, QUIET_MS } = require('../../lib/mdns');

/** A digest with fake timers: `tick()` runs the pending timer, `log` collects what was written. */
function digest() {
    /** @type {Array<[string, string]>} */
    const log = [];
    /** @type {Map<number, () => void>} */
    const timers = new Map();
    let next = 0;
    const d = new ErrorDigest({
        warn: text => log.push(['warn', text]),
        info: text => log.push(['info', text]),
        setTimeout: (fn, ms) => {
            assert.equal(ms, QUIET_MS);
            timers.set(++next, fn);
            return next;
        },
        clearTimeout: id => timers.delete(/** @type {number} */ (id)),
    });
    const tick = () => {
        assert.equal(timers.size, 1, 'exactly one timer waits');
        const [[id, fn]] = timers;
        timers.delete(id);
        fn();
    };
    return { d, log, timers, tick };
}

describe('mDNS error digest', () => {
    it('warns once per outage, counts the repeats and says when it works again', () => {
        const { d, log, timers, tick } = digest();
        for (let i = 0; i < 25; i++) {
            d.report('mDNS: send ENETUNREACH 224.0.0.251:5353');
        }
        assert.deepEqual(log, [
            [
                'warn',
                'mDNS: send ENETUNREACH 224.0.0.251:5353 (more errors of this kind are counted, not logged, until it works again)',
            ],
        ]);
        // every error restarts the quiet time: one timer only
        assert.equal(timers.size, 1);
        tick();
        assert.deepEqual(log[1], ['info', 'mDNS works again (24 more errors not logged)']);
        assert.equal(timers.size, 0);
    });

    it('warns again for a new outage; a single error ends without a count', () => {
        const { d, log, tick } = digest();
        d.report('mDNS: a');
        d.report('mDNS: b');
        tick();
        d.report('mDNS: c');
        assert.equal(log.length, 3);
        assert.equal(log[2][0], 'warn');
        assert.match(log[2][1], /^mDNS: c \(more errors/);
        tick();
        assert.deepEqual(log[3], ['info', 'mDNS works again']);
        d.report('mDNS: d');
        d.report('mDNS: e');
        tick();
        assert.deepEqual(log.at(-1), ['info', 'mDNS works again (1 more error not logged)']);
    });

    it('stop() clears the timer, nothing more is logged', () => {
        const { d, log, timers } = digest();
        d.report('mDNS: a');
        d.stop();
        assert.equal(timers.size, 0);
        assert.equal(d.timer, null);
        assert.equal(log.length, 1);
        d.stop();
    });
});
