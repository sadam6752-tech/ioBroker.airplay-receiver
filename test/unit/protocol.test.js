'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { addressBytes, appleResponse, verifyAppleResponse, decryptAesKey, encryptAesKey, cryptPayload, macFor } =
    require('../../lib/raop-crypto');
const { RtspParser, formatResponse, parseTransport, parseParameters } = require('../../lib/rtsp');
const { parseSdp } = require('../../lib/sdp');
const { Playout, seqDiff } = require('../../lib/playout');
const { escapeFrame, silenceFrame } = require('../../lib/alac');
const { vint, header } = require('../../lib/mkv');
const {
    normalizeReceivers,
    presetFor,
    migrateRows,
    playersFromIds,
    urlStateChoices,
    volumeLevel,
    scaleVolume,
    parseStopValue,
    displayTitle,
    fitTitle,
    streamHost,
    toId,
} = require('../../lib/config');
const { raopTxt, serviceName, mdnsHost } = require('../../lib/mdns');

describe('RAOP crypto', () => {
    it('signs the challenge with address and hardware address', () => {
        const challenge = crypto.randomBytes(16);
        const mac = Buffer.from('0a0b0c0d0e0f', 'hex');
        const signed = verifyAppleResponse(appleResponse(challenge.toString('base64'), '::ffff:192.168.1.5', mac));
        assert.deepEqual(signed, Buffer.concat([challenge, Buffer.from([192, 168, 1, 5]), mac, Buffer.alloc(6)]));
    });

    it('encodes IPv4 and IPv6 addresses', () => {
        assert.deepEqual(addressBytes('10.0.0.1'), Buffer.from([10, 0, 0, 1]));
        assert.equal(addressBytes('fe80::1%eth0').toString('hex'), 'fe800000000000000000000000000001');
    });

    it('unwraps the AES key and decrypts only whole blocks', () => {
        const key = crypto.randomBytes(16);
        assert.deepEqual(decryptAesKey(encryptAesKey(key)), key);
        const iv = crypto.randomBytes(16);
        const plain = crypto.randomBytes(37);
        const enc = cryptPayload(plain, key, iv, true);
        assert.deepEqual(enc.subarray(32), plain.subarray(32)); // the tail stays plain
        assert.notDeepEqual(enc.subarray(0, 32), plain.subarray(0, 32));
        assert.deepEqual(cryptPayload(enc, key, iv), plain);
    });

    it('gives every name its own stable, locally administered hardware address', () => {
        assert.deepEqual(macFor('Gast'), macFor('Gast'));
        assert.notDeepEqual(macFor('Gast'), macFor('Küche'));
        assert.equal(macFor('Gast')[0] & 0x03, 0x02);
        assert.match(serviceName(macFor('Gast'), 'Gast'), /^[0-9A-F]{12}@Gast$/);
        assert.equal(raopTxt().cn, '0,1');
        // an iPhone resolves only .local names over mDNS
        assert.equal(mdnsHost('ioBroker-Pi4.fritz.box'), 'iobroker-pi4-airplay.local');
        assert.equal(mdnsHost('_'), 'iobroker-airplay.local');
    });
});

describe('RTSP', () => {
    it('splits a stream into requests, also across chunks', () => {
        const p = new RtspParser();
        const msg = 'ANNOUNCE rtsp://x/1 RTSP/1.0\r\nCSeq: 2\r\nContent-Length: 5\r\n\r\nhello';
        assert.deepEqual(p.push(Buffer.from(`OPTIONS * RTSP/1.0\r\nCSeq: 1\r\n\r\n${msg.slice(0, 40)}`)).length, 1);
        const [req] = p.push(Buffer.from(msg.slice(40)));
        assert.equal(req.method, 'ANNOUNCE');
        assert.equal(req.headers.cseq, '2');
        assert.equal(req.body.toString(), 'hello');
    });

    it('formats responses and reads transport and parameters', () => {
        const r = formatResponse(200, { CSeq: 3 }, 'x').toString();
        assert.equal(r, 'RTSP/1.0 200 OK\r\nCSeq: 3\r\nContent-Length: 1\r\n\r\nx');
        assert.deepEqual(parseTransport('RTP/AVP/UDP;unicast;control_port=6001;timing_port=6002'), {
            control_port: '6001',
            timing_port: '6002',
        });
        assert.deepEqual(parseParameters('volume: -20.000000\r\n'), { volume: '-20.000000' });
    });
});

describe('SDP', () => {
    it('reads the ALAC parameters of an iPhone', () => {
        const a = parseSdp(
            'v=0\r\ni=Alex iPhone\r\nm=audio 0 RTP/AVP 96\r\na=rtpmap:96 AppleLossless\r\n' +
                'a=fmtp:96 352 0 16 40 10 14 2 255 0 0 44100\r\na=rsaaeskey:AAAA\r\na=aesiv:AAAAAAAAAAAAAAAAAAAAAA\r\n',
        );
        assert.equal(a.format.codec, 'alac');
        assert.equal(a.format.frameLength, 352);
        assert.equal(a.format.sampleRate, 44100);
        assert.equal(a.format.channels, 2);
        assert.equal(a.format.cookie?.toString('hex'), '00000160001028' + '0a0e0200ff00000000000000000000ac44');
        assert.equal(a.info, 'Alex iPhone');
        assert.equal(a.aesIv?.length, 16);
    });

    it('refuses AAC', () => {
        assert.throws(() => parseSdp('a=rtpmap:96 mpeg4-generic/44100/2\r\n'), /Unsupported/);
    });
});

describe('ALAC and Matroska', () => {
    it('writes escape frames of the right size', () => {
        assert.equal(silenceFrame(2, 352).length, Math.ceil((23 + 352 * 2 * 16 + 3) / 8));
        assert.equal(escapeFrame(new Int16Array(20), 2, 352).length, Math.ceil((23 + 32 + 20 * 16 + 3) / 8));
    });

    it('encodes EBML sizes', () => {
        assert.equal(vint(5).toString('hex'), '85');
        assert.equal(vint(126).toString('hex'), 'fe');
        assert.equal(vint(127).toString('hex'), '407f');
        const h = header({ codec: 'alac', frameLength: 352, sampleRate: 44100, channels: 2, bitDepth: 16, cookie: Buffer.alloc(24) });
        assert.ok(h.includes(Buffer.from('A_ALAC')));
    });
});

describe('Playout', () => {
    const setup = () => {
        let now = 1000;
        const out = [];
        const resends = [];
        const active = [];
        const p = new Playout({
            frameMs: 8,
            holdMs: 100,
            fillAfterMs: 200,
            idleMs: 1000,
            onFrame: f => out.push(f ? f.toString() : '-'),
            onResend: (s, c) => resends.push([s, c]),
            onActive: a => active.push(a),
            now: () => now,
        });
        return { p, out, resends, active, advance: ms => (now += ms) };
    };

    it('reorders, asks for a gap and plays the late packet in order', () => {
        const { p, out, resends } = setup();
        p.push(10, Buffer.from('a'));
        p.push(13, Buffer.from('d'));
        assert.deepEqual(resends, [[11, 2]]);
        p.push(12, Buffer.from('c'), true);
        p.push(11, Buffer.from('b'), true);
        assert.deepEqual(out, ['a', 'b', 'c', 'd']);
        assert.equal(p.stats.recovered, 2);
    });

    it('plays a gap as silence when the retransmission does not come, after asking twice', () => {
        const { p, out, resends, advance } = setup();
        p.push(65535, Buffer.from('a'));
        p.push(1, Buffer.from('c')); // across the wrap
        advance(60);
        p.tick();
        assert.deepEqual(resends, [[0, 1], [0, 1]]);
        advance(60);
        p.tick();
        assert.deepEqual(out, ['a', '-', 'c']);
    });

    it('fills a pause with silence in real time and reports idle', () => {
        const { p, out, active, advance } = setup();
        p.push(1, Buffer.from('a'));
        p.tick();
        for (let i = 0; i < 10; i++) {
            advance(40);
            p.tick();
        }
        // 400 ms quiet: silence from 200 ms on, about 25 frames of 8 ms
        assert.ok(out.filter(f => f === '-').length >= 20, String(out.length));
        advance(700);
        p.tick();
        assert.deepEqual(active, [true, false]);
        p.push(2, Buffer.from('b'));
        assert.deepEqual(active, [true, false, true]);
    });

    it('adds no silence right after the process stood still: the waiting packets come first', () => {
        const { p, out, advance } = setup();
        p.push(1, Buffer.from('a'));
        p.tick();
        advance(20);
        p.tick();
        // the event loop was blocked for half a second: the next tick comes late, packets wait in the socket
        advance(500);
        p.tick();
        assert.deepEqual(out, ['a'], 'silence before the waiting packet');
        p.push(2, Buffer.from('b'));
        assert.deepEqual(out, ['a', 'b']);
        // a real pause, ticks on time again: silence as before
        for (let i = 0; i < 10; i++) {
            advance(40);
            p.tick();
        }
        assert.ok(out.filter(f => f === '-').length >= 20, String(out.length));
    });

    it('compares sequence numbers across the wrap', () => {
        assert.equal(seqDiff(2, 65534), 4);
        assert.equal(seqDiff(65534, 2), -4);
    });
});

describe('Settings', () => {
    const SAT = 'assistant.0.satellites.Gast.controls';

    it('fills an assistant satellite from its play URL state, as before', () => {
        const [r] = normalizeReceivers([{ name: 'Gast', urlState: `${SAT}.waveshare_voice_eb1614.url` }]).receivers;
        assert.deepEqual(r, {
            id: 'gast',
            name: 'Gast',
            kind: 'assistant',
            urlState: `${SAT}.waveshare_voice_eb1614.url`,
            stopState: `${SAT}.waveshare_voice_eb1614.url`,
            stopValue: 'stop',
            volumeState: `${SAT}.waveshare_voice_eb1614.volume`,
            titleState: `${SAT}.media_title`,
            titleBytes: 48,
            codec: 'flac',
            sampleRate: 48000,
            channels: 1,
            rtspPort: 0,
        });
    });

    it('reads the rows of 0.0.x (player column) the same way and converts them once', () => {
        const old = [{ enabled: true, name: 'Gast', player: 'Gast.waveshare_voice_eb1614', format: 'flac', rtspPort: 0 }];
        const [a] = normalizeReceivers(old).receivers;
        const rows = migrateRows(old, 'assistant.0');
        assert.deepEqual(rows, [
            { enabled: true, name: 'Gast', rtspPort: 0, urlState: `${SAT}.waveshare_voice_eb1614.url`, stream: 'auto' },
        ]);
        assert.deepEqual(normalizeReceivers(rows).receivers, [a]);
        assert.equal(migrateRows(rows, 'assistant.0'), null);
    });

    it('fills Dune HD: stop button, volume 0 … 100, MP3 stereo, no title', () => {
        const [r] = normalizeReceivers([{ name: 'Kino', urlState: 'dune-hd-remote.0.media.playUrl' }]).receivers;
        assert.equal(r.kind, 'dune');
        assert.equal(r.stopState, 'dune-hd-remote.0.control.stop');
        assert.equal(r.stopValue, true);
        assert.equal(r.volumeState, 'dune-hd-remote.0.control.volume');
        assert.equal(r.titleState, '');
        assert.deepEqual([r.codec, r.sampleRate, r.channels], ['mp3', 44100, 2]);
    });

    it('fills ioBroker.satellite-display: stop button, volume 0 … 100, title 48 bytes, FLAC mono', () => {
        const base = 'satellite-display.0.satellites.kueche';
        const [r] = normalizeReceivers([{ name: 'Küche', urlState: `${base}.media.url` }]).receivers;
        assert.deepEqual(r, {
            id: 'kueche',
            name: 'Küche',
            kind: 'satellite-display',
            urlState: `${base}.media.url`,
            stopState: `${base}.media.stop`,
            stopValue: true,
            volumeState: `${base}.media.volume`,
            titleState: `${base}.media.title`,
            titleBytes: 48,
            codec: 'flac',
            sampleRate: 48000,
            channels: 1,
            rtspPort: 0,
        });
        assert.equal(presetFor('satellite-display.1.satellites.gast.media.url').kind, 'satellite-display');
        // other states of the panel are no preset
        assert.equal(presetFor(`${base}.media.title`).kind, 'custom');
        assert.equal(presetFor('satellite-display.0.satellites.a.b.media.url').kind, 'custom');
    });

    it('takes what is typed over the preset; "-" switches a preset state off', () => {
        const [a, b] = normalizeReceivers([
            { name: 'Gast', urlState: `${SAT}.p.url`, stream: 'mp3/48000/2', volumeState: '-', titleState: 'x.0.t' },
            { name: 'Cast', urlState: 'cast.0.tv.player.url2play', stopState: 'cast.0.tv.player.stop' },
        ]).receivers;
        assert.deepEqual([a.codec, a.sampleRate, a.channels, a.volumeState], ['mp3', 48000, 2, '']);
        // a title state of its own has no byte limit
        assert.deepEqual([a.titleState, a.titleBytes], ['x.0.t', 0]);
        // any other player: MP3 like a radio; a stop state of its own without a value is a button
        assert.deepEqual([b.kind, b.codec, b.stopValue, b.volumeState], ['custom', 'mp3', true, '']);
        const [c] = normalizeReceivers([{ name: 'C', urlState: 'cast.0.tv.player.url2play' }]).receivers;
        assert.deepEqual([c.stopState, c.stopValue], ['cast.0.tv.player.url2play', '']);
        assert.deepEqual([parseStopValue('false'), parseStopValue('0'), parseStopValue('stop')], [false, 0, 'stop']);
    });

    it('skips rows without name, without a valid play URL state, or with a name used twice', () => {
        const { receivers, problems } = normalizeReceivers([
            { enabled: true, name: 'Gast', urlState: `${SAT}.p.url` },
            { enabled: true, name: 'Gast', urlState: `${SAT}.q.url` },
            { enabled: true, name: '', urlState: `${SAT}.p.url` },
            { enabled: true, name: 'Küche', urlState: 'not an id' },
            { enabled: false, name: 'Off', urlState: 'a.b' },
        ]);
        assert.equal(receivers.length, 1);
        assert.equal(problems.length, 3);
        assert.equal(toId('Küche Süd'), 'kueche_sued');
    });

    it('offers every writable media.url state, not its own', () => {
        const state = (role, write = true, name = 'Play') => ({ type: 'state', common: { role, write, name } });
        assert.deepEqual(
            urlStateChoices(
                {
                    [`${SAT}.p.url`]: state('media.url', true, { en: 'Play a URL' }),
                    'dune-hd-remote.0.media.playUrl': state('media.url'),
                    'dune-hd-remote.0.status.currentUrl': state('media.url', false),
                    'dune-hd-remote.0.media.seek': state('media.seek'),
                    'airplay-receiver.0.receivers.gast.streamUrl': state('media.url'),
                },
                'airplay-receiver.0',
            ),
            [
                { label: `${SAT}.p.url (Play a URL)`, value: `${SAT}.p.url` },
                { label: 'dune-hd-remote.0.media.playUrl (Play)', value: 'dune-hd-remote.0.media.playUrl' },
            ],
        );
    });

    it('scales the volume to the range of the target', () => {
        assert.equal(scaleVolume(0.5), 0.5);
        assert.equal(scaleVolume(0.5, { min: 0, max: 100 }), 50);
        assert.equal(scaleVolume(0.333, { min: 0, max: 1 }), 0.33);
        assert.equal(scaleVolume(1, { min: -20, max: 0 }), 0);
        assert.equal(scaleVolume(2, { max: 100 }), 100);
    });

    it('finds the players of ioBroker.assistant', () => {
        assert.deepEqual(
            playersFromIds('assistant.0', [
                'assistant.0.satellites.Gast.controls.waveshare_voice_eb1614.url',
                'assistant.0.satellites.Gast.controls.waveshare_voice_eb1614.volume',
                'assistant.1.satellites.X.controls.p.url',
            ]),
            [{ satellite: 'Gast', player: 'waveshare_voice_eb1614' }],
        );
    });

    it('maps the AirPlay volume and builds title and host', () => {
        assert.equal(volumeLevel(-144), 0);
        assert.equal(volumeLevel(-30), 0);
        assert.equal(volumeLevel(-15), 0.5);
        assert.equal(volumeLevel(0), 1);
        assert.equal(displayTitle({ title: 'Song', artist: 'Band' }), 'Band – Song');
        assert.equal(displayTitle({ title: 'Song' }), 'Song');
        // the display takes 48 bytes: Cyrillic is cut by bytes, never inside a letter
        const long = displayTitle({ artist: 'ANIVAR • Video verfügbar', title: 'Любимый человек' });
        assert.ok(Buffer.byteLength(long) <= 48, long);
        assert.ok(long.endsWith('…') && long.startsWith('ANIVAR • Video verfügbar – Л'), long);
        assert.ok(!long.includes('�'));
        assert.equal(fitTitle('AirPlay – iPhone'), 'AirPlay – iPhone');
        assert.equal(streamHost('nas.local', '10.0.0.2'), 'nas.local');
        assert.equal(streamHost('', '::ffff:10.0.0.15'), '10.0.0.15');
    });
});

describe('Used resources', () => {
    const { usedTcpPorts } = require('../../lib/resources');

    it('registers the HTTP port and fixed RTSP ports only', () => {
        assert.deepEqual(usedTcpPorts(8095, '0.0.0.0', [{ rtspPort: 0 }, { rtspPort: 47125 }]), [
            { port: 8095 },
            { port: 47125 },
        ]);
    });

    it('names a specific listen address and skips duplicates', () => {
        assert.deepEqual(usedTcpPorts(8095, '192.168.1.15', [{ rtspPort: 47125 }, { rtspPort: 47125 }]), [
            { port: 8095, bind: '192.168.1.15' },
            { port: 47125 },
        ]);
    });

    it('registers nothing without a valid port', () => {
        assert.deepEqual(usedTcpPorts(0, '', [{ rtspPort: 0 }, { rtspPort: 70000 }]), []);
    });
});
