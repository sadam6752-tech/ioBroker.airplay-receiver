const path = require('path');
const assert = require('assert/strict');
const { tests } = require('@iobroker/testing');
const { RaopSender, sineFrame } = require('./helpers/raop-sender');
const { buildDmap } = require('../lib/dmap');

const RTSP_PORT = 47123;
const HTTP_PORT = 47124;
const SAT = 'assistant.0.satellites.Gast';

// Run integration tests - See https://github.com/ioBroker/testing for a detailed explanation and further options
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('Streaming from a test sender to a fake satellite', getHarness => {
            let harness;

            before(async function () {
                this.timeout(60_000);
                harness = getHarness();
                // the objects ioBroker.assistant creates for a satellite with a media player
                for (const [id, type] of [
                    [`${SAT}.controls.player.url`, 'string'],
                    [`${SAT}.controls.player.volume`, 'number'],
                    [`${SAT}.controls.media_title`, 'string'],
                ]) {
                    await harness.objects.setObjectAsync(id, {
                        type: 'state',
                        common: { name: id, type, role: 'state', read: true, write: true },
                        native: {},
                    });
                }
                await harness.changeAdapterConfig('airplay-receiver', {
                    native: {
                        receivers: [{ enabled: true, name: 'Gast', player: 'Gast.player', format: 'flac', rtspPort: RTSP_PORT }],
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
            });

            it('plays a stream on the satellite, with volume and title, and stops it', async function () {
                this.timeout(60_000);
                const sender = new RaopSender({ port: RTSP_PORT, drop: seq => seq % 50 === 7 });
                try {
                    await sender.connect();
                    await sender.start();
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
                    await reader?.cancel();

                    await sender.teardown();
                    await waitFor(`${SAT}.controls.player.url`, v => v === 'stop');
                    await waitFor('airplay-receiver.0.receivers.gast.connected', v => v === false);
                } finally {
                    sender.close();
                }
            });
        });
    },
});
