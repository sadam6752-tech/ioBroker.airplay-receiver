const path = require('path');
const assert = require('assert/strict');
const { tests } = require('@iobroker/testing');
const { RaopSender, sineFrame } = require('./helpers/raop-sender');
const { buildDmap } = require('../lib/dmap');

const RTSP_PORT = 47123;
const HTTP_PORT = 47124;
const SAT = 'assistant.0.satellites.Gast';
const DUNE = 'dune-hd-remote.0';
const DUNE_RTSP = 47125;

// Run integration tests - See https://github.com/ioBroker/testing for a detailed explanation and further options
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('Streaming from a test sender to a fake satellite', getHarness => {
            let harness;

            before(async function () {
                this.timeout(60_000);
                harness = getHarness();
                // the objects ioBroker.assistant creates for a satellite with a media player, and those of
                // ioBroker.dune-hd-remote
                for (const [id, type, role, extra] of [
                    [`${SAT}.controls.player.url`, 'string', 'media.url', {}],
                    [`${SAT}.controls.player.volume`, 'number', 'level.volume', { min: 0, max: 1 }],
                    [`${SAT}.controls.media_title`, 'string', 'text', {}],
                    [`${DUNE}.media.playUrl`, 'string', 'media.url', {}],
                    [`${DUNE}.control.stop`, 'boolean', 'button.stop', {}],
                    [`${DUNE}.control.volume`, 'number', 'level.volume', { min: 0, max: 100, unit: '%' }],
                ]) {
                    await harness.objects.setObjectAsync(id, {
                        type: 'state',
                        common: { name: id, type, role, read: true, write: true, ...extra },
                        native: {},
                    });
                }
                await harness.changeAdapterConfig('airplay-receiver', {
                    native: {
                        // a row of version 0.0.x: converted to the play URL state at the first start
                        receivers: [
                            { enabled: true, name: 'Gast', player: 'Gast.player', format: 'flac', rtspPort: RTSP_PORT },
                            { enabled: true, name: 'Kino', urlState: `${DUNE}.media.playUrl`, rtspPort: DUNE_RTSP },
                        ],
                        port: HTTP_PORT,
                        bind: '127.0.0.1',
                        urlHost: '127.0.0.1',
                        idleStop: 3,
                    },
                });
                await harness.startAdapterAndWait(true);
            });

            after(async function () {
                this.timeout(30_000);
                await harness?.stopAdapter();
            });

            const state = async id => (await harness.states.getStateAsync(id))?.val;
            const waitFor = async (id, test, ms = 10_000) => {
                let val;
                for (let i = 0; i < ms / 100; i++) {
                    val = await state(id);
                    if (test(val)) {
                        return val;
                    }
                    await new Promise(r => setTimeout(r, 100));
                }
                assert.fail(`${id} = ${JSON.stringify(val)}`);
            };

            it('announces the speaker and creates its states', async function () {
                this.timeout(20_000);
                await waitFor('airplay-receiver.0.info.connection', v => v === true);
                assert.equal(await state('airplay-receiver.0.receivers.gast.connected'), false);
                assert.equal(await state('airplay-receiver.0.receivers.kino.connected'), false);
                const obj = await harness.objects.getObjectAsync('system.adapter.airplay-receiver.0');
                assert.deepEqual(obj?.native.receivers[0], {
                    enabled: true,
                    name: 'Gast',
                    rtspPort: RTSP_PORT,
                    urlState: `${SAT}.controls.player.url`,
                    stream: 'auto',
                });
            });

            it('plays a stream on the satellite, with volume and title, and stops it', async function () {
                this.timeout(60_000);
                const sender = new RaopSender({ port: RTSP_PORT, drop: seq => seq % 50 === 7 });
                try {
                    // the display still shows the radio station that played before
                    await harness.states.setStateAsync(`${SAT}.controls.media_title`, { val: 'SWR3', ack: true });
                    await sender.connect();
                    await sender.start();
                    // before the sender names the track, the display shows where the music comes from
                    await waitFor(`${SAT}.controls.media_title`, v => v === 'AirPlay – Test iPhone');
                    await sender.volume(-15);
                    await sender.metadata(buildDmap([['mlit', buildDmap([['minm', 'Song'], ['asar', 'Band']])]]));
                    for (let i = 0; i < 100; i += 5) {
                        for (let k = i; k < i + 5; k++) {
                            sender.send(k, sineFrame(k));
                        }
                        await new Promise(r => setTimeout(r, 40));
                    }
                    const url = await waitFor(`${SAT}.controls.player.url`, v => typeof v === 'string' && v.startsWith('http'));
                    assert.equal(url, `http://127.0.0.1:${HTTP_PORT}/gast.flac`);
                    assert.equal(await waitFor(`${SAT}.controls.player.volume`, v => v === 0.5), 0.5);
                    assert.equal(await waitFor(`${SAT}.controls.media_title`, v => v === 'Band – Song'), 'Band – Song');
                    assert.equal(await state('airplay-receiver.0.receivers.gast.client'), 'Test iPhone');
                    assert.equal(await state('airplay-receiver.0.receivers.gast.playing'), true);

                    // the satellite fetches the stream
                    const res = await fetch(url);
                    assert.equal(res.headers.get('content-type'), 'audio/flac');
                    const reader = res.body?.getReader();
                    const first = await reader?.read();
                    assert.equal(Buffer.from(first?.value || []).subarray(0, 4).toString(), 'fLaC');
                    // the firmware may have replaced the text while it opened the stream: it is written again
                    await harness.states.setStateAsync(`${SAT}.controls.media_title`, { val: 'SWR3', ack: true });
                    await waitFor(`${SAT}.controls.media_title`, v => v === 'Band – Song', 5000);
                    await reader?.cancel();

                    await sender.teardown();
                    await waitFor(`${SAT}.controls.player.url`, v => v === 'stop');
                    await waitFor('airplay-receiver.0.receivers.gast.connected', v => v === false);
                } finally {
                    sender.close();
                }
            });

            it('plays MP3 on a Dune HD, scales the volume, keeps a pause open and then presses stop', async function () {
                this.timeout(60_000);
                await harness.states.setStateAsync(`${DUNE}.control.stop`, { val: false, ack: true });
                const sender = new RaopSender({ port: DUNE_RTSP });
                try {
                    await sender.connect();
                    await sender.start();
                    await sender.volume(-15);
                    for (let i = 0; i < 60; i += 5) {
                        for (let k = i; k < i + 5; k++) {
                            sender.send(k, sineFrame(k));
                        }
                        await new Promise(r => setTimeout(r, 40));
                    }
                    const url = await waitFor(`${DUNE}.media.playUrl`, v => typeof v === 'string' && v.startsWith('http'));
                    assert.equal(url, `http://127.0.0.1:${HTTP_PORT}/kino.mp3`);
                    // 0 … 100 % like the volume state of the Dune
                    assert.equal(await waitFor(`${DUNE}.control.volume`, v => v === 50), 50);

                    const res = await fetch(url);
                    assert.equal(res.headers.get('content-type'), 'audio/mpeg');
                    const reader = res.body?.getReader();
                    const head = Buffer.from((await reader?.read())?.value || []);
                    // ID3 tag or an MPEG frame sync
                    assert.ok(head.subarray(0, 3).toString() === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0));

                    // the sender pauses: silence keeps the stream open, nothing is stopped before the pause time (3 s)
                    await new Promise(r => setTimeout(r, 1500));
                    assert.equal(await state(`${DUNE}.control.stop`), false);
                    assert.ok(((await reader?.read())?.value?.length || 0) > 0, 'no data during the pause');
                    await waitFor(`${DUNE}.control.stop`, v => v === true, 8000);
                    assert.equal(await state('airplay-receiver.0.receivers.kino.playing'), false);
                    await reader?.cancel().catch(() => undefined);
                    await sender.teardown();
                } finally {
                    sender.close();
                }
            });
        });
    },
});
