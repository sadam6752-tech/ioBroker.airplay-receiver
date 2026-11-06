'use strict';

/*
 * ioBroker.airplay-receiver: AirPlay 1 speakers whose audio plays on any ioBroker player that takes a URL
 * (ioBroker.assistant satellites, Dune HD, others with a `media.url` state).
 * iPhone → RTSP/RTP (ALAC, AES) → jitter buffer → ffmpeg (FLAC/MP3) → HTTP → the player.
 */

const utils = require('@iobroker/adapter-core');
const { RaopReceiver } = require('./lib/receiver');
const { Channel, StreamServer } = require('./lib/streamer');
const { Announcer } = require('./lib/mdns');
const { macFor } = require('./lib/raop-crypto');
const { NAMES } = require('./lib/names');
const {
    normalizeReceivers,
    migrateRows,
    playersFromIds,
    urlStateChoices,
    volumeLevel,
    scaleVolume,
    displayTitle,
    fitTitle,
    streamHost,
} = require('./lib/config');

/**
 * @typedef {import('./lib/types').ReceiverConfig} ReceiverConfig
 */

/**
 * @typedef {object} Running
 * @property {ReceiverConfig} cfg - Settings
 * @property {RaopReceiver} raop - AirPlay side
 * @property {Channel} channel - HTTP side
 * @property {string} local - Local address of the current sender connection
 * @property {boolean} started - The player was told to play
 * @property {string} shownTitle - Text on the display
 * @property {boolean} hasMetadata - The sender named the track in this session
 * @property {unknown} titleTimer - Second write of the title after the player connected
 * @property {{min?: unknown, max?: unknown} | null} volumeCommon - Range of the volume state (read once)
 */

class AirplayReceiver extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
     */
    constructor(options = {}) {
        super({ ...options, name: 'airplay-receiver' });
        /** @type {Running[]} */
        this.running = [];
        /** @type {StreamServer | null} */
        this.http = null;
        /** @type {Announcer | null} */
        this.announcer = null;
        this.httpPort = 0;
        this.on('ready', this.onReady.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /** @returns {string} Instance of ioBroker.assistant */
    get assistant() {
        return String(this.config.assistantInstance || 'assistant.0').trim() || 'assistant.0';
    }

    /** @returns {import('./lib/types').Timers} Adapter timers */
    get timers() {
        return {
            setTimeout: (cb, ms) => this.setTimeout(cb, ms),
            clearTimeout: h => h && this.clearTimeout(/** @type {ioBroker.Timeout} */ (h)),
            setInterval: (cb, ms) => this.setInterval(cb, ms),
            clearInterval: h => h && this.clearInterval(/** @type {ioBroker.Interval} */ (h)),
        };
    }

    async onReady() {
        await this.setState('info.connection', { val: false, ack: true });
        await this.migrateConfig();
        const ffmpegPath = String(this.config.ffmpegPath || '').trim() || String(require('ffmpeg-static') || '');
        if (!ffmpegPath) {
            this.log.error('No ffmpeg binary for this platform; set the path of an installed ffmpeg in the settings');
            return;
        }

        let { receivers, problems } = normalizeReceivers(this.config.receivers, this.assistant);
        for (const p of problems) {
            this.log.warn(`Receiver skipped: ${p}`);
        }
        if (!receivers.length && this.config.autoDiscover !== false) {
            receivers = await this.discover();
            if (receivers.length) {
                this.log.info(`No receiver configured, found: ${receivers.map(r => r.name).join(', ')}`);
            }
        }
        if (!receivers.length) {
            this.log.warn('No receiver: add a row with the state that plays a URL in the settings');
            return;
        }

        await this.createObjects(receivers);

        this.http = new StreamServer(this.log);
        try {
            this.httpPort = await this.http.listen(
                Number(this.config.port) || 8095,
                String(this.config.bind || '0.0.0.0'),
            );
        } catch (e) {
            this.log.error(`Cannot open the HTTP port ${this.config.port}: ${e.message}`);
            return;
        }
        this.announcer = new Announcer(e => this.log.warn(`mDNS: ${e.message}`));

        for (const cfg of receivers) {
            try {
                await this.startReceiver(cfg, ffmpegPath);
            } catch (e) {
                this.log.error(`${cfg.name}: cannot start: ${e.message}`);
            }
        }
        await this.setState('info.connection', { val: this.running.length > 0, ack: true });
    }

    /**
     * Rows of version 0.0.x name a satellite player; they are written once in the new form (play URL state). This run
     * goes on with the new rows; js-controller may restart the instance because its object changed.
     */
    async migrateConfig() {
        const rows = migrateRows(this.config.receivers, this.assistant);
        if (!rows) {
            return;
        }
        this.config.receivers = rows;
        try {
            // the whole object: extendForeignObject would merge the old row into the new one
            const id = `system.adapter.${this.namespace}`;
            const obj = await this.getForeignObjectAsync(id);
            if (!obj) {
                return;
            }
            obj.native.receivers = rows;
            await this.setForeignObjectAsync(id, obj);
            this.log.info('The receiver table was converted to play URL states (one-time).');
        } catch (e) {
            this.log.warn(`Cannot convert the receiver table: ${e.message}`);
        }
    }

    /**
     * One receiver per media player of ioBroker.assistant, named after its satellite.
     *
     * @returns {Promise<ReceiverConfig[]>} Receivers
     */
    async discover() {
        try {
            const players = playersFromIds(this.assistant, await this.playerStateIds());
            const used = new Set();
            const rows = [];
            for (const p of players) {
                if (used.has(p.satellite)) {
                    continue; // one speaker per satellite
                }
                used.add(p.satellite);
                rows.push({
                    name: p.satellite,
                    urlState: `${this.assistant}.satellites.${p.satellite}.controls.${p.player}.url`,
                });
            }
            return normalizeReceivers(rows, this.assistant).receivers;
        } catch (e) {
            this.log.warn(`Search for satellites failed: ${e.message}`);
            return [];
        }
    }

    /** @returns {Promise<string[]>} Ids of all `url` states of the assistant's players */
    async playerStateIds() {
        const objs = await this.getForeignObjectsAsync(`${this.assistant}.satellites.*.controls.*.url`, 'state');
        return Object.keys(objs || {});
    }

    /**
     * @param {ReceiverConfig[]} receivers - Receivers
     */
    async createObjects(receivers) {
        await this.extendObject('receivers', { type: 'folder', common: { name: NAMES.receivers }, native: {} });
        const states = [
            ['connected', 'boolean', 'indicator.connected', false],
            ['playing', 'boolean', 'indicator', false],
            ['client', 'string', 'text', ''],
            ['title', 'string', 'media.title', ''],
            ['artist', 'string', 'media.artist', ''],
            ['album', 'string', 'media.album', ''],
            ['volume', 'number', 'value.volume', 0],
            ['streamUrl', 'string', 'text.url', ''],
        ];
        const keep = new Set(receivers.map(r => `${this.namespace}.receivers.${r.id}`));
        for (const r of receivers) {
            await this.extendObject(`receivers.${r.id}`, {
                type: 'channel',
                common: { name: r.name, desc: r.urlState },
                native: {},
            });
            for (const [key, type, role, def] of states) {
                await this.extendObject(`receivers.${r.id}.${key}`, {
                    type: 'state',
                    common: {
                        name: NAMES[/** @type {string} */ (key)],
                        type: /** @type {ioBroker.CommonType} */ (type),
                        role: /** @type {string} */ (role),
                        read: true,
                        write: false,
                        def,
                        ...(key === 'volume' ? { unit: '%', min: 0, max: 100 } : {}),
                    },
                    native: {},
                });
                await this.setState(`receivers.${r.id}.${key}`, { val: def, ack: true });
            }
        }
        // channels of receivers that were removed from the settings
        const channels = await this.getObjectViewAsync('system', 'channel', {
            startkey: `${this.namespace}.receivers.`,
            endkey: `${this.namespace}.receivers.香`,
        });
        for (const row of channels?.rows || []) {
            if (!keep.has(row.id)) {
                await this.delForeignObjectAsync(row.id, { recursive: true });
            }
        }
    }

    /**
     * @param {ReceiverConfig} cfg - Receiver
     * @param {string} ffmpegPath - ffmpeg binary
     */
    async startReceiver(cfg, ffmpegPath) {
        const mac = macFor(cfg.name);
        const raop = new RaopReceiver({
            name: cfg.name,
            mac,
            port: cfg.rtspPort,
            holdMs: Math.max(50, Number(this.config.holdMs) || 350),
            // a pause keeps the stream open with silence for this long, then the player is stopped
            idleMs: Math.max(2, Number(this.config.idleStop) || 60) * 1000,
            timers: this.timers,
            log: this.log,
        });
        const channel = new Channel({
            id: cfg.id,
            name: cfg.name,
            codec: cfg.codec,
            sampleRate: cfg.sampleRate,
            channels: cfg.channels,
            prerollMs: Math.max(0, Number(this.config.prerollMs ?? 1500)),
            // the player may replace the display text while it starts the new stream: write ours again
            onListener: () => this.refreshTitle(r),
            ffmpegPath,
            log: this.log,
        });
        this.http?.add(channel);
        /** @type {Running} */
        const r = {
            cfg,
            raop,
            channel,
            local: '',
            started: false,
            shownTitle: '',
            hasMetadata: false,
            titleTimer: null,
            volumeCommon: null,
        };
        this.running.push(r);
        const base = `receivers.${cfg.id}`;
        const set = (key, val) =>
            this.setState(`${base}.${key}`, { val, ack: true }).catch(e => this.log.debug(e.message));

        raop.on('session', s => {
            r.local = s.local;
            channel.setFormat(s.format);
            set('connected', true);
            set('client', s.client);
            // the display still shows what played before (a radio station) until the sender names the track
            if (!r.hasMetadata) {
                void this.showTitle(r, fitTitle(`AirPlay – ${s.client}`, cfg.titleBytes));
            }
        });
        raop.on('frame', frame => channel.push(frame));
        raop.on('active', active => {
            if (active) {
                channel.startPreroll();
                void this.play(r);
            } else {
                void this.stopPlaying(r);
            }
            set('playing', active);
        });
        raop.on('volume', db => {
            const level = volumeLevel(db);
            set('volume', Math.round(level * 100));
            if (this.config.syncVolume !== false && cfg.volumeState) {
                void this.setVolume(r, level);
            }
        });
        raop.on('metadata', info => {
            set('title', info.title || '');
            set('artist', info.artist || '');
            set('album', info.album || '');
            const text = displayTitle(info, cfg.titleBytes);
            if (text) {
                r.hasMetadata = true;
                void this.showTitle(r, text);
            }
        });
        raop.on('end', () => {
            r.hasMetadata = false;
            this.timers.clearTimeout(r.titleTimer);
            r.titleTimer = null;
            void this.stopPlaying(r);
            channel.reset();
            for (const [key, val] of [
                ['connected', false],
                ['playing', false],
                ['client', ''],
                ['title', ''],
                ['artist', ''],
                ['album', ''],
            ]) {
                set(key, val);
            }
            void this.showTitle(r, '');
        });

        const port = await raop.start();
        this.announcer?.publish(mac, cfg.name, port, e => this.log.warn(`${cfg.name}: mDNS: ${e.message}`));
        set('streamUrl', this.streamUrl(r));
        this.log.info(
            `AirPlay speaker "${cfg.name}" on port ${port} → ${cfg.urlState} ` +
                `(${cfg.codec.toUpperCase()} ${cfg.sampleRate} Hz ${cfg.channels === 2 ? 'stereo' : 'mono'})`,
        );
    }

    /**
     * @param {Running} r - Receiver
     * @returns {string} URL the player fetches
     */
    streamUrl(r) {
        return `http://${streamHost(this.config.urlHost, r.local)}:${this.httpPort}${r.channel.path}`;
    }

    /**
     * Tells the player to fetch the stream.
     *
     * @param {Running} r - Receiver
     */
    async play(r) {
        const url = this.streamUrl(r);
        r.started = true;
        await this.setState(`receivers.${r.cfg.id}.streamUrl`, { val: url, ack: true });
        this.log.info(`${r.cfg.name}: playing on ${r.cfg.urlState} (${url})`);
        await this.writeTarget(r.cfg.urlState, url);
        if (r.shownTitle) {
            await this.writeTarget(r.cfg.titleState, r.shownTitle, true);
        }
    }

    /**
     * The player opened the stream: while it starts playing it may still show (or set) the text of what played
     * before, so the current title is written now and once more two seconds later.
     *
     * @param {Running} r - Receiver
     */
    refreshTitle(r) {
        if (!r.shownTitle || !r.cfg.titleState) {
            return;
        }
        void this.writeTarget(r.cfg.titleState, r.shownTitle, true);
        this.timers.clearTimeout(r.titleTimer);
        r.titleTimer = this.timers.setTimeout(() => {
            r.titleTimer = null;
            if (r.shownTitle) {
                void this.writeTarget(r.cfg.titleState, r.shownTitle, true);
            }
        }, 2000);
    }

    /**
     * Stops the player, if this adapter started it.
     *
     * @param {Running} r - Receiver
     */
    async stopPlaying(r) {
        r.channel.disconnect();
        if (!r.started) {
            return;
        }
        r.started = false;
        this.log.info(`${r.cfg.name}: stopped`);
        await this.writeTarget(r.cfg.stopState, r.cfg.stopValue);
    }

    /**
     * @param {Running} r - Receiver
     * @param {string} text - Display text
     */
    async showTitle(r, text) {
        r.shownTitle = text;
        await this.writeTarget(r.cfg.titleState, text, true);
    }

    /**
     * The AirPlay volume on the player's own scale (its `min` … `max`).
     *
     * @param {Running} r - Receiver
     * @param {number} level - 0 … 1
     */
    async setVolume(r, level) {
        if (!r.volumeCommon) {
            try {
                const obj = await this.getForeignObjectAsync(r.cfg.volumeState);
                r.volumeCommon = /** @type {{min?: unknown, max?: unknown}} */ (obj?.common || {});
            } catch {
                r.volumeCommon = {};
            }
        }
        await this.writeTarget(r.cfg.volumeState, scaleVolume(level, r.volumeCommon));
    }

    /**
     * Writes a state of the player (a command, ack false).
     *
     * @param {string} id - State id; empty = nothing to do
     * @param {ioBroker.StateValue} val - Value
     * @param {boolean} [optional] - Skip silently when the state does not exist
     */
    async writeTarget(id, val, optional = false) {
        if (!id) {
            return;
        }
        try {
            if (optional && !(await this.getForeignObjectAsync(id))) {
                return;
            }
            await this.setForeignStateAsync(id, { val, ack: false });
        } catch (e) {
            this.log.warn(`Cannot write ${id}: ${e.message}`);
        }
    }

    /**
     * @param {ioBroker.Message} obj - Message
     */
    async onMessage(obj) {
        if (!obj?.command) {
            return;
        }
        const answer = result => obj.callback && this.sendTo(obj.from, obj.command, result, obj.callback);
        try {
            if (obj.command === 'listUrlStates' || obj.command === 'listPlayers') {
                // every writable state with role media.url: assistant players, Dune HD, others
                const objs = await this.getForeignObjectsAsync('*', 'state');
                answer(urlStateChoices(objs, this.namespace));
            } else {
                answer({ error: `Unknown command ${obj.command}` });
            }
        } catch (e) {
            answer({ error: e.message });
        }
    }

    /**
     * @param {() => void} callback - Done
     */
    async onUnload(callback) {
        try {
            for (const r of this.running) {
                this.timers.clearTimeout(r.titleTimer);
                await this.stopPlaying(r);
                await r.raop.stop();
            }
            this.running = [];
            await this.announcer?.close();
            this.announcer = null;
            await this.http?.close();
            this.http = null;
            await this.setState('info.connection', { val: false, ack: true });
        } catch (e) {
            this.log.error(`Unload: ${e.message}`);
        } finally {
            callback();
        }
    }
}

if (require.main !== module) {
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
     */
    module.exports = options => new AirplayReceiver(options);
} else {
    new AirplayReceiver();
}
