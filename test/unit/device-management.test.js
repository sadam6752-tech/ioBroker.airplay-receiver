'use strict';

// The AirPlay speakers in the Device Manager (lib/device-management.js): cards, details, volume, actions, texts.

const assert = require('node:assert/strict');
const { AirplayDeviceManagement, cardOf, detailsOf, toPercent, formatText } = require('../../lib/device-management');
const { DM_TEXTS } = require('../../lib/dm-texts');
const { shortTarget, groupPlayers, satelliteDeviceOf } = require('../../lib/config');

const LANGS = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];
const SAT = 'assistant.0.satellites.Gast.controls.waveshare_voice_eb1614';

/** @type {any} */
const gast = {
    id: 'gast',
    name: 'Gast',
    kind: 'assistant',
    urlState: `${SAT}.url`,
    stopState: `${SAT}.url`,
    stopValue: 'stop',
    volumeState: `${SAT}.volume`,
    titleState: 'assistant.0.satellites.Gast.controls.media_title',
    titleBytes: 48,
    codec: 'flac',
    sampleRate: 48000,
    channels: 1,
    rtspPort: 0,
};
/** @type {any} */
const kino = {
    id: 'kino',
    name: 'Kino',
    kind: 'dune',
    urlState: 'dune-hd-remote.0.media.playUrl',
    stopState: 'dune-hd-remote.0.control.stop',
    stopValue: true,
    volumeState: 'dune-hd-remote.0.control.volume',
    titleState: '',
    titleBytes: 0,
    codec: 'mp3',
    sampleRate: 44100,
    channels: 2,
    rtspPort: 47125,
};
const alac = { codec: 'alac', frameLength: 352, sampleRate: 44100, channels: 2, bitDepth: 16, cookie: null };

/** @returns {any} Speaker as the adapter reports it */
const speaker = (cfg, over = {}) => ({
    cfg,
    port: 50001,
    client: '',
    format: null,
    streamUrl: 'http://h:8095/x',
    ...over,
});

/**
 * @param {Partial<Record<string, any>>} [over] - Overrides
 */
function fakeAdapter(over = {}) {
    const written = [];
    const ended = [];
    const objects = {
        [`${SAT}.volume`]: { common: { min: 0, max: 1 } },
        'dune-hd-remote.0.control.volume': { common: { min: 0, max: 100 } },
    };
    const states = {
        [`${SAT}.volume`]: { val: 0.4, ack: true },
        'dune-hd-remote.0.control.volume': { val: 30, ack: true },
    };
    const app = {
        namespace: 'airplay-receiver.0',
        log: { warn() {}, info() {}, debug() {}, error() {} },
        on() {},
        written,
        ended,
        speakers: () => [speaker(kino), speaker(gast, { client: 'iPhone 18 Pro Max', format: alac })],
        announced: () => true,
        endSession: (/** @type {string} */ id) => {
            ended.push(id);
            return id === 'gast' ? 'iPhone 18 Pro Max' : null;
        },
        playerGroups: async () => ({ free: [], taken: [] }),
        missingTargets: async (/** @type {any} */ cfg) => (cfg.id === 'kino' ? [cfg.urlState, cfg.volumeState] : []),
        getForeignObjectAsync: async (/** @type {string} */ id) => objects[id] ?? null,
        getForeignStateAsync: async (/** @type {string} */ id) => states[id] ?? null,
        setForeignStateAsync: async (/** @type {string} */ id, /** @type {any} */ st) => {
            written.push([id, st]);
            states[id] = { ...st };
        },
        ...over,
    };
    return app;
}

/** A dm-utils action context that records what it shows. */
function fakeContext() {
    const shown = [];
    return {
        shown,
        showMessage: async (/** @type {any} */ text) => shown.push(['message', text]),
        showForm: async (/** @type {any} */ schema, /** @type {any} */ options) =>
            shown.push(['form', schema, options]),
    };
}

describe('Device Manager', () => {
    it('has every text in eleven languages with the same placeholders', () => {
        for (const [key, texts] of Object.entries(DM_TEXTS)) {
            assert.deepEqual(Object.keys(texts).sort(), [...LANGS].sort(), key);
            const marks = t => (t.match(/%\d/g) || []).sort().join();
            for (const lang of LANGS) {
                assert.ok(texts[lang].trim(), `${key}.${lang}`);
                assert.equal(marks(texts[lang]), marks(texts.en), `${key}.${lang}`);
            }
        }
    });

    it('builds a card: playing or idle, sender with format, target, volume, stop', () => {
        const card = cardOf(speaker(gast, { client: 'iPhone 18 Pro Max', format: alac }), {
            ns: 'airplay-receiver.0',
            announced: true,
            volume: true,
            missing: [],
        });
        assert.equal(card.id, 'receivers.gast');
        assert.equal(card.name, 'Gast');
        assert.deepEqual(card.model, {
            stateId: 'airplay-receiver.0.receivers.gast.playing',
            mapping: { true: DM_TEXTS.playingModel, false: DM_TEXTS.idleModel },
        });
        assert.deepEqual(card.status, { connection: 'connected' });
        const items = /** @type {any} */ (card.customInfo).schema.items;
        assert.equal(items._sender.data, 'iPhone 18 Pro Max · ALAC 44100 Hz, 2 ch');
        assert.equal(items._target, undefined);
        assert.equal(card.identifier, 'assistant · Gast');
        assert.deepEqual(
            card.controls.map(c => [c.id, c.type, /** @type {any} */ (c).stateId, /** @type {any} */ (c).max]),
            [['volume', 'slider', `${SAT}.volume`, 100]],
        );
        assert.deepEqual(
            card.actions.map(a => [a.id, a.icon]),
            [['stop', 'stop']],
        );
    });

    it('marks a speaker whose player is missing, and one that is not announced', () => {
        const card = cardOf(speaker(kino, { port: 0 }), {
            ns: 'airplay-receiver.0',
            announced: true,
            volume: false,
            missing: ['dune-hd-remote.0.media.playUrl'],
        });
        const status = /** @type {any} */ (card.status);
        assert.equal(status.connection, 'disconnected');
        assert.equal(status.warning.en, 'Missing in ioBroker: dune-hd-remote.0.media.playUrl');
        assert.equal(status.warning.de, 'Fehlt in ioBroker: dune-hd-remote.0.media.playUrl');
        assert.deepEqual(card.controls, []);
        assert.deepEqual(/** @type {any} */ (card.customInfo).schema.items._sender.data, DM_TEXTS.noSender);
    });

    it('shows the details: name, RTSP port, formats, states; "none" for what is not set', () => {
        const { schema } = detailsOf(speaker(gast, { client: 'iPhone', format: alac }));
        const data = Object.fromEntries(Object.entries(schema.items).map(([k, v]) => [k, /** @type {any} */ (v).data]));
        assert.equal(data._name, 'Gast');
        assert.equal(data._port, 50001);
        assert.equal(data._sender, 'iPhone');
        assert.equal(data._format, 'ALAC 44100 Hz, 2 ch');
        assert.equal(data._stream, 'FLAC 48000 Hz, 1 ch');
        assert.equal(data._target, `${SAT}.url`);
        // the stop goes into the URL state itself
        assert.deepEqual(data._stopState, DM_TEXTS.none);
        assert.equal(data._volumeState, `${SAT}.volume`);
        const dune = detailsOf(speaker(kino, { port: 0 })).schema.items;
        assert.deepEqual(/** @type {any} */ (dune._port).data, DM_TEXTS.none);
        assert.deepEqual(/** @type {any} */ (dune._format).data, DM_TEXTS.none);
        assert.deepEqual(/** @type {any} */ (dune._titleState).data, DM_TEXTS.none);
        assert.equal(/** @type {any} */ (dune._stopState).data, 'dune-hd-remote.0.control.stop');
        assert.equal(formatText({ codec: 'mp3', sampleRate: 44100, channels: 2 }), 'MP3 44100 Hz, 2 ch');
    });

    it('shows the volume of the player as 0 … 100 % of its range', () => {
        assert.equal(toPercent(0.4, { min: 0, max: 1 }), 40);
        assert.equal(toPercent(30, { min: 0, max: 100 }), 30);
        assert.equal(toPercent(0.4, {}), 40);
        assert.equal(toPercent(-10, { min: -20, max: 0 }), 50);
        assert.equal(toPercent(150, { min: 0, max: 100 }), 100);
        assert.equal(toPercent(null, { min: 0, max: 100 }), null);
    });

    it('loads the cards with handlers: the slider writes the volume on the scale of the player', async () => {
        const app = fakeAdapter();
        const dm = new AirplayDeviceManagement(/** @type {any} */ (app));
        const cards = [];
        await dm.loadDevices(
            /** @type {any} */ ({ setTotalDevices: n => assert.equal(n, 2), addDevice: c => cards.push(c) }),
        );
        // sorted by name; Kino misses its player and volume state: no slider, a warning
        assert.deepEqual(
            cards.map(c => c.id),
            ['receivers.gast', 'receivers.kino'],
        );
        assert.deepEqual(cards[1].controls, []);
        assert.ok(cards[1].status.warning);
        const slider = cards[0].controls[0];
        assert.equal((await slider.getStateHandler('receivers.gast', 'volume', {})).val, 40);
        const after = await slider.handler('receivers.gast', 'volume', 65, {});
        assert.deepEqual(app.written, [[`${SAT}.volume`, { val: 0.65, ack: false }]]);
        assert.equal(after.val, 65);
    });

    it('a 0 … 100 volume state gets whole numbers', async () => {
        const app = fakeAdapter();
        const dm = new AirplayDeviceManagement(/** @type {any} */ (app));
        await dm.writeVolume('dune-hd-remote.0.control.volume', 72);
        assert.deepEqual(app.written, [['dune-hd-remote.0.control.volume', { val: 72, ack: false }]]);
    });

    it('ends the AirPlay session from the card, or says that none is connected', async () => {
        const app = fakeAdapter();
        const dm = new AirplayDeviceManagement(/** @type {any} */ (app));
        const ctx = fakeContext();
        assert.deepEqual(await dm.onStop(gast, /** @type {any} */ (ctx)), { refresh: 'devices' });
        assert.equal(ctx.shown[0][1].en, 'The AirPlay session of iPhone 18 Pro Max was ended and the player stopped.');
        await dm.onStop(kino, /** @type {any} */ (ctx));
        assert.deepEqual(ctx.shown[1][1], DM_TEXTS.noSession);
        assert.deepEqual(app.ended, ['gast', 'kino']);
    });

    it('instance action "Find players" lists the free devices left-aligned, a device of two adapters on one line', async () => {
        const groups = {
            free: [
                {
                    ids: ['assistant.0.satellites.Bad.controls.p.url', 'satellite-display.0.satellites.bad.media.url'],
                    sameAs: '',
                },
                { ids: ['assistant.0.satellites.Flur.controls.p.url'], sameAs: '' },
            ],
            taken: [
                {
                    ids: ['assistant.0.satellites.Mobil.controls.media_player.url'],
                    sameAs: 'satellite-display.0.satellites.panel-mobil.media.url',
                },
            ],
        };
        const dm = new AirplayDeviceManagement(/** @type {any} */ (fakeAdapter({ playerGroups: async () => groups })));
        const info = /** @type {any} */ (dm.getInstanceInfo());
        assert.deepEqual(
            info.actions.map(a => [a.id, a.icon]),
            [['findPlayers', 'search']],
        );
        const ctx = fakeContext();
        assert.deepEqual(await info.actions[0].handler(ctx), { refresh: false });
        const [kind, schema] = ctx.shown[0];
        assert.equal(kind, 'form');
        const items = /** @type {Record<string, any>} */ (schema.items);
        assert.ok(Object.values(items).every(i => i.type === 'staticText'));
        assert.equal(
            items._p0.text.en,
            'assistant.0.satellites.Bad.controls.p.url = satellite-display.0.satellites.bad.media.url (the same device)',
        );
        assert.equal(items._p0.style.textAlign, 'left');
        assert.equal(items._p1.text, 'assistant.0.satellites.Flur.controls.p.url');
        assert.deepEqual(items._takenHint.text, DM_TEXTS.takenHint);
        assert.equal(
            items._t0.text.en,
            'assistant.0.satellites.Mobil.controls.media_player.url — the same device as satellite-display.0.satellites.panel-mobil.media.url',
        );

        const none = new AirplayDeviceManagement(/** @type {any} */ (fakeAdapter()));
        const ctx2 = fakeContext();
        await /** @type {any} */ (none.getInstanceInfo()).actions[0].handler(ctx2);
        assert.deepEqual(ctx2.shown[0], ['message', DM_TEXTS.noNewPlayers]);
    });

    it('groups the players by the address of their device and marks those a speaker already plays on', () => {
        const mobilA = 'assistant.0.satellites.Mobil.controls.media_player.url';
        const mobilS = 'satellite-display.0.satellites.panel-mobil.media.url';
        const miniA = 'assistant.0.satellites.Mini.controls.media_player.url';
        const miniS = 'satellite-display.0.satellites.mini.media.url';
        const gastA = 'assistant.0.satellites.Gast.controls.p.url';
        const odd = 'assistant.0.satellites.Alt.controls.p.url';
        const { free, taken } = groupPlayers(
            [
                { id: mobilA, host: '192.168.1.157' },
                { id: mobilS, host: '192.168.1.157' },
                { id: miniS, host: '192.168.1.158' },
                { id: miniA, host: '192.168.1.158' },
                { id: gastA, host: '192.168.1.20' },
                { id: odd, host: '' },
            ],
            [
                { id: mobilS, host: '192.168.1.157' },
                { id: gastA, host: '192.168.1.20' },
            ],
        );
        assert.deepEqual(free, [
            { ids: [odd], sameAs: '' },
            { ids: [miniA, miniS], sameAs: '' },
        ]);
        assert.deepEqual(taken, [{ ids: [mobilA], sameAs: mobilS }]);
    });

    it('names the player in short on the card', () => {
        assert.equal(shortTarget(`${SAT}.url`), 'assistant · Gast');
        assert.equal(
            shortTarget('satellite-display.0.satellites.panel-mobil.media.url'),
            'satellite-display · panel-mobil',
        );
        assert.equal(shortTarget('assistant.1.satellites.Bad.controls.p.url'), 'assistant.1 · Bad');
        assert.equal(shortTarget('dune-hd-remote.1.media.playUrl'), 'dune-hd-remote.1');
        assert.equal(shortTarget('cast.0.tv.player.url2play'), 'cast.0.tv.player.url2play');
        assert.equal(satelliteDeviceOf(`${SAT}.url`), 'assistant.0.satellites.Gast');
        assert.equal(satelliteDeviceOf('dune-hd-remote.1.media.playUrl'), '');
    });

    it('answers the details of a card and an error for an unknown one', async () => {
        const dm = new AirplayDeviceManagement(/** @type {any} */ (fakeAdapter()));
        const details = /** @type {any} */ (await dm.getDeviceDetails('receivers.gast'));
        assert.equal(details.id, 'receivers.gast');
        assert.equal(details.schema.items._name.data, 'Gast');
        assert.ok(/** @type {any} */ (await dm.getDeviceDetails('receivers.nope')).error);
    });
});
