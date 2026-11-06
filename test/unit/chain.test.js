'use strict';

// The whole chain without ioBroker: a test sender streams ALAC over RTSP/RTP with lost packets, the receiver asks for
// them again, ffmpeg turns the stream into FLAC, and an HTTP client (the satellite) reads it.

const assert = require('node:assert/strict');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const ffmpegPath = require('ffmpeg-static');
const { RaopReceiver } = require('../../lib/receiver');
const { Channel, StreamServer } = require('../../lib/streamer');
const { macFor } = require('../../lib/raop-crypto');
const { buildDmap, parseDmap } = require('../../lib/dmap');
const { RaopSender, sineFrame } = require('../helpers/raop-sender');

const timers = {
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: h => clearTimeout(h),
    setInterval: (cb, ms) => setInterval(cb, ms),
    clearInterval: h => clearInterval(h),
};
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * @param {Buffer} flac - FLAC stream
 * @returns {Int16Array} Mono samples
 */
function decode(flac) {
    const r = spawnSync(String(ffmpegPath), ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 's16le', 'pipe:1'], {
        input: flac,
        maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(r.status, 0, String(r.stderr));
    return new Int16Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length >> 1);
}

/**
 * Longest run of near silent samples between `from` and `to`.
 *
 * @param {Int16Array} s - Samples
 * @param {number} from - Start
 * @param {number} to - End
 * @returns {number} Samples
 */
function longestSilence(s, from, to) {
    let run = 0;
    let max = 0;
    for (let i = from; i < to; i++) {
        run = Math.abs(s[i]) < 200 ? run + 1 : 0;
        max = Math.max(max, run);
    }
    return max;
}

describe('AirPlay chain (sender → receiver → ffmpeg → HTTP)', function () {
    this.timeout(60_000);

    for (const [encrypt, codec] of /** @type {const} */ ([
        [true, 'flac'],
        [false, 'flac'],
        [true, 'mp3'],
    ])) {
        it(`plays ${encrypt ? 'encrypted' : 'plain'} audio as ${codec} without gaps although packets get lost`, async () => {
            const receiver = new RaopReceiver({
                name: 'Test',
                mac: macFor('Test'),
                port: 0,
                holdMs: 300,
                idleMs: 1500,
                timers,
                log: quiet,
            });
            const server = new StreamServer(quiet);
            const channel = new Channel({
                id: 'test',
                name: 'Test',
                codec,
                sampleRate: 48000,
                channels: 1,
                prerollMs: 1500,
                ffmpegPath: String(ffmpegPath),
                log: quiet,
            });
            server.add(channel);
            const events = { volume: [], meta: [], active: [], sessions: [], end: 0 };
            receiver.on('session', s => {
                events.sessions.push(s.client);
                channel.setFormat(s.format);
            });
            receiver.on('frame', f => channel.push(f));
            receiver.on('active', a => {
                events.active.push(a);
                if (a) {
                    channel.startPreroll();
                }
            });
            receiver.on('volume', v => events.volume.push(v));
            receiver.on('metadata', m => events.meta.push(m));
            receiver.on('end', () => {
                events.end++;
                channel.reset();
            });
            const rtspPort = await receiver.start();
            const httpPort = await server.listen(0, '127.0.0.1');
            const sender = new RaopSender({ port: rtspPort, encrypt, drop: seq => seq % 37 === 5 });
            try {
                await sender.connect();
                const signed = await sender.start();
                assert.ok(signed.length >= 32);
                await sender.volume(-15);
                await sender.metadata(buildDmap([['mlit', buildDmap([['minm', 'Song'], ['asar', 'Band']])]]));

                const frames = 400; // about 3.2 s
                /** @type {Buffer[]} */
                const body = [];
                let response;
                let probeType;
                for (let i = 0; i < frames; i += 5) {
                    for (let k = i; k < i + 5; k++) {
                        sender.send(k, sineFrame(k));
                    }
                    if (i === 25) {
                        // ioBroker.assistant probes the URL first and drops it after the headers
                        const probe = await fetch(`http://127.0.0.1:${httpPort}${channel.path}`, {
                            headers: { 'User-Agent': 'ioBroker.assistant', 'Icy-MetaData': '0' },
                        });
                        probeType = probe.headers.get('content-type');
                        await probe.body?.cancel();
                    }
                    if (i === 50) {
                        // the satellite connects a moment after the start, the preroll covers that
                        http.get(`http://127.0.0.1:${httpPort}${channel.path}`, res => {
                            response = res;
                            res.on('data', d => body.push(d));
                        });
                    }
                    await sleep(40);
                }
                await sleep(800);
                await sender.teardown();
                await sleep(500);

                assert.deepEqual(events.sessions, ['Test iPhone']);
                assert.deepEqual(events.volume, [-15]);
                assert.deepEqual(events.meta, [{ title: 'Song', artist: 'Band' }]);
                assert.equal(events.active[0], true);
                assert.equal(events.end, 1);
                assert.equal(response?.headers['content-type'], codec === 'mp3' ? 'audio/mpeg' : 'audio/flac');
                assert.equal(probeType, codec === 'mp3' ? 'audio/mpeg' : 'audio/flac');
                assert.ok(sender.resendRequests > 0, 'no retransmission was requested');
                assert.ok(sender.timingRequests > 0, 'no timing request was sent');
                assert.ok(receiver.playout.stats.lost === 0 || receiver.playout.stats.recovered > 0);

                const pcm = decode(Buffer.concat(body));
                const expected = Math.round((frames * 352 * 48000) / 44100);
                assert.ok(pcm.length >= expected * 0.98, `${pcm.length} samples, expected about ${expected}`);
                // inside the music: no gap longer than 1 ms (a lost packet would be 8 ms of silence)
                assert.ok(longestSilence(pcm, 2000, expected - 2000) < 48, 'a gap of silence in the music');
            } finally {
                sender.close();
                await receiver.stop();
                await server.close();
            }
        });
    }

    it('reads DMAP metadata', () => {
        const data = buildDmap([['mlit', buildDmap([['asal', 'Album'], ['minm', 'Title'], ['astm', Buffer.alloc(4)]])]]);
        assert.deepEqual(parseDmap(data), { album: 'Album', title: 'Title' });
    });
});
