'use strict';

// The AirPlay speakers in the Device Manager of ioBroker (@iobroker/dm-utils): a card per speaker with its state
// (announced, playing or idle), the sender and its audio format, the player it plays on, a volume slider for that
// player and "End the AirPlay session". The speakers are still set up in the table of the settings; this view only
// shows and acts.

const { DeviceManagement } = require('@iobroker/dm-utils');
const { DM_TEXTS } = require('./dm-texts');
const { scaleVolume, shortTarget } = require('./config');

/**
 * @typedef {import('./types').ReceiverConfig} ReceiverConfig
 * @typedef {import('./sdp').AudioFormat} AudioFormat
 * @typedef {import('@iobroker/dm-utils').ActionContext} ActionContext
 * @typedef {import('@iobroker/dm-utils').ConfigItemAny} ConfigItemAny
 * @typedef {import('@iobroker/dm-utils').ConfigItemPanel} ConfigItemPanel
 * @typedef {import('@iobroker/dm-utils').DeviceInfo<string>} DeviceInfo
 * @typedef {import('@iobroker/dm-utils').DeviceControl<string>} DeviceControl
 * @typedef {import('@iobroker/dm-utils').DeviceAction<string>} DeviceAction
 * @typedef {import('@iobroker/dm-utils').DeviceDetails<string>} DeviceDetails
 * @typedef {import('@iobroker/dm-utils').DeviceLoadContext<string>} DeviceLoadContext
 * @typedef {import('@iobroker/dm-utils').DeviceRefreshResponse<string>} DeviceRefreshResponse
 * @typedef {import('@iobroker/dm-utils').InstanceDetails} InstanceDetails
 * @typedef {import('@iobroker/dm-utils').ControlState} ControlState
 * @typedef {{min?: unknown, max?: unknown}} Range
 * @typedef {import('./config').PlayerGroup} PlayerGroup
 */

/**
 * @typedef {object} SpeakerInfo - What a card shows of a running speaker
 * @property {ReceiverConfig} cfg - Settings
 * @property {number} port - RTSP port, 0 = not started
 * @property {string} client - Name of the connected sender, empty = none
 * @property {AudioFormat | null} format - Audio format of the sender
 * @property {string} streamUrl - URL the player fetches
 */

/**
 * @typedef {object} AirplayHost - What the adapter (main.js) offers to this view
 * @property {string} namespace - e.g. airplay-receiver.0
 * @property {() => SpeakerInfo[]} speakers - The running speakers
 * @property {() => boolean} announced - The speakers are announced with mDNS
 * @property {(id: string) => string | null} endSession - Ends the AirPlay session of a speaker; the sender's name, null
 *   when no sender is connected
 * @property {() => Promise<{free: PlayerGroup[], taken: PlayerGroup[]}>} playerGroups - Players of
 *   ioBroker.assistant and ioBroker.satellite-display that no speaker uses, one device together
 * @property {(cfg: ReceiverConfig) => Promise<string[]>} missingTargets - States of the player that do not exist
 * @property {(id: string) => Promise<ioBroker.Object | null | undefined>} getForeignObjectAsync - Reads an object
 * @property {(id: string) => Promise<ioBroker.State | null | undefined>} getForeignStateAsync - Reads a state
 * @property {(id: string, state: ioBroker.SettableState) => Promise<unknown>} setForeignStateAsync - Writes a state
 */

/**
 * @param {ioBroker.Translated} texts - A text in every language with %1, %2
 * @param {...string} values - What goes in
 * @returns {ioBroker.Translated} The texts filled in
 */
function fill(texts, ...values) {
    return /** @type {ioBroker.Translated} */ (
        Object.fromEntries(
            Object.entries(texts).map(([lang, text]) => [
                lang,
                values.reduce((t, v, i) => t.split(`%${i + 1}`).join(v), text),
            ]),
        )
    );
}

/**
 * @param {{codec: string, sampleRate: number, channels: number}} f - Audio format
 * @returns {string} e.g. "ALAC 44100 Hz, 2 ch"
 */
function formatText(f) {
    return `${f.codec.toUpperCase()} ${f.sampleRate} Hz, ${f.channels} ch`;
}

/**
 * @param {Range} [common] - common of a volume state
 * @returns {{min: number, max: number}} Its range (0 … 1 without a max, like scaleVolume)
 */
function rangeOf(common = {}) {
    const num = (/** @type {unknown} */ v, /** @type {number} */ d) =>
        v !== undefined && v !== null && Number.isFinite(Number(v)) ? Number(v) : d;
    return { min: num(common.min, 0), max: num(common.max, 1) };
}

/**
 * A value of the volume state of the player as 0 … 100 % of its range.
 *
 * @param {unknown} val - Value of the state
 * @param {Range} [common] - common of the state
 * @returns {number | null} Percent, null without a number
 */
function toPercent(val, common) {
    const { min, max } = rangeOf(common);
    if (typeof val !== 'number' || !Number.isFinite(val) || max === min) {
        return null;
    }
    return Math.round(Math.max(0, Math.min(1, (val - min) / (max - min))) * 100);
}

/**
 * Builds the card of a speaker, without the handlers (those are added by the class).
 *
 * @param {SpeakerInfo} s - Running speaker
 * @param {object} has - What it has
 * @param {string} has.ns - Namespace of the instance, e.g. airplay-receiver.0
 * @param {boolean} has.announced - The speakers are announced with mDNS
 * @param {boolean} has.volume - The volume state of the player exists
 * @param {string[]} has.missing - States of the player that do not exist
 * @returns {DeviceInfo & {controls: DeviceControl[], actions: DeviceAction[]}} Card without handlers
 */
function cardOf(s, has) {
    const base = `receivers.${s.cfg.id}`;
    /** @type {DeviceControl[]} */
    const controls = [];
    if (s.cfg.volumeState && has.volume) {
        controls.push({
            id: 'volume',
            type: 'slider',
            stateId: s.cfg.volumeState,
            label: DM_TEXTS.volume,
            min: 0,
            max: 100,
            step: 5,
            unit: '%',
        });
    }
    /** @type {DeviceAction[]} */
    const actions = [{ id: 'stop', icon: 'stop', description: DM_TEXTS.stop }];
    /** @type {Record<string, ConfigItemAny>} */
    const items = {
        _sender: {
            type: 'staticInfo',
            label: DM_TEXTS.sender,
            data: s.client ? (s.format ? `${s.client} · ${formatText(s.format)}` : s.client) : DM_TEXTS.noSender,
            sm: 12,
        },
    };
    return {
        id: base,
        name: s.cfg.name,
        // the player in short (assistant · Gast); the full play URL state is in the details (as a labelled line the
        // long id ran into its label and was cut off in admin 8)
        identifier: shortTarget(s.cfg.urlState),
        model: {
            stateId: `${has.ns}.${base}.playing`,
            mapping: { true: DM_TEXTS.playingModel, false: DM_TEXTS.idleModel },
        },
        status: {
            connection: has.announced && s.port ? 'connected' : 'disconnected',
            ...(has.missing.length ? { warning: fill(DM_TEXTS.missing, has.missing.join(', ')) } : {}),
        },
        customInfo: { id: base, schema: { type: 'panel', items }, data: {} },
        controls,
        actions,
        hasDetails: true,
    };
}

/**
 * The form below a card: name, RTSP port, stream, the states of the player.
 *
 * @param {SpeakerInfo} s - Running speaker
 * @returns {{schema: ConfigItemPanel, data: Record<string, unknown>}} JSON config schema and its data
 */
function detailsOf(s) {
    const { cfg } = s;
    /**
     * @param {ioBroker.Translated} label - Label
     * @param {string | number | ioBroker.Translated} data - Value, empty or 0 = none
     * @returns {ConfigItemAny} A line of the form
     */
    const info = (label, data) => ({ type: 'staticInfo', label, data: data === '' ? DM_TEXTS.none : data, sm: 12 });
    /** @type {Record<string, ConfigItemAny>} */
    const items = {
        _name: info(DM_TEXTS.name, cfg.name),
        _port: info(DM_TEXTS.rtspPort, s.port || ''),
        _sender: info(DM_TEXTS.sender, s.client || DM_TEXTS.noSender),
        _format: info(DM_TEXTS.format, s.format ? formatText(s.format) : ''),
        _stream: info(DM_TEXTS.stream, formatText(cfg)),
        _streamUrl: info(DM_TEXTS.streamUrl, s.streamUrl),
        _target: info(DM_TEXTS.target, cfg.urlState),
        _stopState: info(DM_TEXTS.stopState, cfg.stopState === cfg.urlState ? '' : cfg.stopState),
        _volumeState: info(DM_TEXTS.volumeState, cfg.volumeState),
        _titleState: info(DM_TEXTS.titleState, cfg.titleState),
    };
    return { schema: { type: 'panel', items }, data: {} };
}

/**
 * The form of "Find players": one left-aligned line per device without a speaker (the same satellite in
 * ioBroker.assistant and ioBroker.satellite-display on one line), then the devices a speaker already plays on through
 * the other adapter.
 *
 * @param {PlayerGroup[]} free - Devices without a speaker
 * @param {PlayerGroup[]} taken - Devices with a speaker through another play URL state
 * @returns {Record<string, ConfigItemAny>} Items of a JSON config panel
 */
function playerItems(free, taken) {
    /** @type {Record<string, ConfigItemAny>} */
    const items = { _hint: { type: 'staticText', text: DM_TEXTS.playersHint, sm: 12 } };
    const line = (/** @type {string} */ key, /** @type {ioBroker.StringOrTranslated} */ text) => {
        items[key] = { type: 'staticText', text, sm: 12, style: { textAlign: 'left', fontFamily: 'monospace' } };
    };
    free.forEach((g, i) => {
        line(`_p${i}`, g.ids.length > 1 ? fill(DM_TEXTS.sameDevice, g.ids[0], g.ids.slice(1).join(', ')) : g.ids[0]);
    });
    if (taken.length) {
        items._takenHint = { type: 'staticText', text: DM_TEXTS.takenHint, sm: 12, newLine: true };
        taken.forEach((g, i) => line(`_t${i}`, fill(DM_TEXTS.takenLine, g.ids.join(', '), g.sameAs)));
    }
    return items;
}

/** The speakers of the instance in the Device Manager; dm-utils answers the dm:* messages through it. */
class AirplayDeviceManagement extends DeviceManagement {
    /**
     * @param {AirplayHost & import('@iobroker/adapter-core').AdapterInstance} adapter - The adapter (main.js)
     */
    constructor(adapter) {
        super(adapter);
        /** @type {AirplayHost} */
        this.app = adapter;
    }

    /**
     * @returns {InstanceDetails} Instance information with the action "Find players"
     */
    getInstanceInfo() {
        const info = /** @type {InstanceDetails} */ (super.getInstanceInfo());
        info.actions = [
            {
                id: 'findPlayers',
                icon: 'search',
                title: DM_TEXTS.findPlayers,
                handler: context => this.showPlayers(context),
            },
        ];
        return info;
    }

    /**
     * Instance action: the play URL states of ioBroker.assistant and ioBroker.satellite-display that no speaker uses.
     *
     * @param {ActionContext} context - Action context of dm-utils
     * @returns {Promise<{refresh: boolean}>} Nothing to reload
     */
    async showPlayers(context) {
        const { free, taken } = await this.app.playerGroups();
        if (!free.length) {
            await context.showMessage(DM_TEXTS.noNewPlayers);
            return { refresh: false };
        }
        await context.showForm(
            { type: 'panel', items: playerItems(free, taken) },
            {
                title: DM_TEXTS.findPlayers,
                buttons: ['close'],
            },
        );
        return { refresh: false };
    }

    /**
     * @param {DeviceLoadContext} context - Load context of dm-utils
     */
    async loadDevices(context) {
        const speakers = [...this.app.speakers()].sort((a, b) => a.cfg.name.localeCompare(b.cfg.name));
        context.setTotalDevices(speakers.length);
        for (const s of speakers) {
            const missing = await this.app.missingTargets(s.cfg);
            const volume = !!s.cfg.volumeState && !missing.includes(s.cfg.volumeState);
            const card = cardOf(s, {
                ns: this.app.namespace,
                announced: this.app.announced(),
                volume,
                missing,
            });
            for (const control of card.controls) {
                const stateId = String(control.stateId);
                control.handler = (_d, _c, val) => this.writeVolume(stateId, val);
                control.getStateHandler = () => this.readVolume(stateId);
            }
            for (const action of card.actions) {
                Object.assign(action, {
                    handler: (/** @type {string} */ _d, /** @type {ActionContext} */ ctx) => this.onStop(s.cfg, ctx),
                });
            }
            context.addDevice(card);
        }
    }

    /**
     * @param {string} deviceId - Id of the card (receivers.kitchen)
     * @returns {Promise<DeviceDetails | {error: string}>} The form below the card
     */
    async getDeviceDetails(deviceId) {
        const s = this.app.speakers().find(x => `receivers.${x.cfg.id}` === deviceId);
        if (!s) {
            return { error: `unknown speaker ${deviceId}` };
        }
        return { id: deviceId, ...detailsOf(s) };
    }

    /**
     * Card action "End the AirPlay session": the sender is disconnected and the player stopped.
     *
     * @param {ReceiverConfig} cfg - The speaker of the card
     * @param {ActionContext} context - Action context of dm-utils
     * @returns {Promise<DeviceRefreshResponse>} The card is loaded again
     */
    async onStop(cfg, context) {
        const client = this.app.endSession(cfg.id);
        await context.showMessage(client === null ? DM_TEXTS.noSession : fill(DM_TEXTS.stopped, client));
        return { refresh: 'devices' };
    }

    /**
     * @param {string} id - Volume state of the player
     * @returns {Promise<Range>} Its range
     */
    async rangeOf(id) {
        try {
            const obj = await this.app.getForeignObjectAsync(id);
            return /** @type {Range} */ (obj?.common || {});
        } catch {
            return {};
        }
    }

    /**
     * The slider was moved: the volume state of the player gets the value on its own scale (a command).
     *
     * @param {string} id - Volume state of the player
     * @param {ControlState} val - 0 … 100 %
     * @returns {Promise<ioBroker.State>} The state afterwards, as the slider shows it
     */
    async writeVolume(id, val) {
        const level = Math.max(0, Math.min(100, Number(val) || 0)) / 100;
        await this.app.setForeignStateAsync(id, { val: scaleVolume(level, await this.rangeOf(id)), ack: false });
        return this.readVolume(id);
    }

    /**
     * @param {string} id - Volume state of the player
     * @returns {Promise<ioBroker.State>} The state as 0 … 100 %, or an empty one
     */
    async readVolume(id) {
        const now = Date.now();
        const state = (await this.app.getForeignStateAsync(id)) ?? {
            val: null,
            ack: true,
            ts: now,
            lc: now,
            from: '',
            q: 0,
        };
        return { ...state, val: toPercent(state.val, await this.rangeOf(id)) };
    }
}

module.exports = { AirplayDeviceManagement, cardOf, detailsOf, fill, formatText, toPercent };
