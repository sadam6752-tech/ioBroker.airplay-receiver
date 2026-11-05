'use strict';

const net = require('node:net');
const dgram = require('node:dgram');
const { EventEmitter } = require('node:events');
const { RtspParser, formatResponse, parseTransport, parseParameters } = require('./rtsp');
const { parseSdp } = require('./sdp');
const { parseDmap } = require('./dmap');
const { appleResponse, decryptAesKey, cryptPayload } = require('./raop-crypto');
const { Playout } = require('./playout');

/**
 * @typedef {import('./types').Timers} Timers
 * @typedef {import('./types').Logger} Logger
 * @typedef {import('./sdp').AudioFormat} AudioFormat
 */

/**
 * @typedef {object} Session
 * @property {net.Socket} socket - RTSP connection
 * @property {string} client - Name of the sender
 * @property {string} remote - Address of the sender (as the socket reports it)
 * @property {AudioFormat | null} format - Audio format from ANNOUNCE
 * @property {Buffer | null} key - AES key
 * @property {Buffer | null} iv - AES IV
 * @property {number} controlPort - Control port of the sender
 * @property {number} timingPort - Timing port of the sender
 * @property {boolean} recording - RECORD received
 */

const PUBLIC = 'ANNOUNCE, SETUP, RECORD, PAUSE, FLUSH, TEARDOWN, OPTIONS, GET_PARAMETER, SET_PARAMETER';

/**
 * Opens a UDP socket that takes IPv4 and IPv6 senders, IPv4 only where the host has no IPv6.
 *
 * @returns {Promise<dgram.Socket>} Bound socket
 */
async function bindUdp() {
    for (const type of /** @type {const} */ (['udp6', 'udp4'])) {
        const socket = dgram.createSocket(type === 'udp6' ? { type, ipv6Only: false } : { type });
        try {
            await new Promise((resolve, reject) => {
                socket.once('error', reject);
                socket.bind(0, type === 'udp6' ? '::' : '0.0.0.0', () => {
                    socket.off('error', reject);
                    resolve(undefined);
                });
            });
            return socket;
        } catch {
            socket.close();
        }
    }
    throw new Error('Cannot open a UDP port');
}

/**
 * One AirPlay 1 (RAOP) speaker: the RTSP server, the UDP ports for audio, control and timing, and the jitter
 * buffer. It emits
 * - `session` ({client, format, local}) when a sender starts to stream (RECORD),
 * - `frame` (Buffer | null) for every frame in order, null = silence,
 * - `active` (boolean) when audio starts or stays away,
 * - `volume` (dB, -144 = mute), `metadata` (TrackInfo), `progress` ({start, current, end}),
 * - `end` when the session is over (TEARDOWN, connection lost, taken over by another sender).
 */
class RaopReceiver extends EventEmitter {
    /**
     * @param {object} options - Options
     * @param {string} options.name - Speaker name (for log lines)
     * @param {Buffer} options.mac - Hardware address
     * @param {number} options.port - RTSP port, 0 = any free port
     * @param {number} options.holdMs - Wait for a lost packet
     * @param {number} options.idleMs - No audio for this long = idle
     * @param {Timers} options.timers - Timers
     * @param {Logger} options.log - Logger
     */
    constructor(options) {
        super();
        this.o = options;
        this.log = options.log;
        /** @type {Session | null} */
        this.session = null;
        /** @type {net.Server | null} */
        this.server = null;
        /** @type {dgram.Socket[]} */
        this.udp = [];
        this.port = 0;
        this.resendSeq = 0;
        /** @type {any} */
        this.tickTimer = null;
        /** @type {any} */
        this.timingTimer = null;
        this.playout = this.newPlayout(352, 44100);
    }

    /**
     * @param {number} frameLength - Samples per packet
     * @param {number} sampleRate - Sample rate
     * @returns {Playout} Jitter buffer
     */
    newPlayout(frameLength, sampleRate) {
        return new Playout({
            frameMs: (frameLength * 1000) / sampleRate,
            holdMs: this.o.holdMs,
            fillAfterMs: Math.max(250, this.o.holdMs + 50),
            idleMs: this.o.idleMs,
            onFrame: frame => this.emit('frame', frame),
            onResend: (seq, count) => this.requestResend(seq, count),
            onActive: active => this.emit('active', active),
        });
    }

    /**
     * Opens the RTSP server and the UDP ports.
     *
     * @returns {Promise<number>} RTSP port
     */
    async start() {
        const [audio, control, timing] = [await bindUdp(), await bindUdp(), await bindUdp()];
        this.udp = [audio, control, timing];
        audio.on('message', msg => this.onAudio(msg));
        control.on('message', msg => this.onControl(msg));
        timing.on('message', (msg, rinfo) => this.onTiming(msg, rinfo));
        for (const s of this.udp) {
            s.on('error', e => this.log.debug(`${this.o.name}: UDP error ${e.message}`));
        }
        const server = net.createServer(socket => this.onConnection(socket));
        this.server = server;
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(this.o.port, () => {
                server.off('error', reject);
                resolve(undefined);
            });
        });
        server.on('error', e => this.log.warn(`${this.o.name}: RTSP server error ${e.message}`));
        this.port = /** @type {net.AddressInfo} */ (server.address()).port;
        this.tickTimer = this.o.timers.setInterval(() => this.playout.tick(), 20);
        return this.port;
    }

    /**
     * Closes everything.
     */
    async stop() {
        this.o.timers.clearInterval(this.tickTimer);
        this.endSession('the adapter stops');
        for (const s of this.udp) {
            try {
                s.close();
            } catch {
                /* already closed */
            }
        }
        this.udp = [];
        const server = this.server;
        this.server = null;
        if (server) {
            await new Promise(resolve => server.close(() => resolve(undefined)));
        }
    }

    /**
     * @param {net.Socket} socket - New RTSP connection
     */
    onConnection(socket) {
        const parser = new RtspParser();
        this.log.info(`${this.o.name}: connection from ${String(socket.remoteAddress || '').replace(/^::ffff:/, '')}`);
        socket.setNoDelay(true);
        socket.on('data', chunk => {
            try {
                for (const req of parser.push(chunk)) {
                    this.handle(socket, req);
                }
            } catch (e) {
                this.log.warn(`${this.o.name}: bad RTSP request from ${socket.remoteAddress}: ${e.message}`);
                socket.destroy();
            }
        });
        socket.on('error', () => undefined);
        socket.on('close', () => {
            if (this.session?.socket === socket) {
                this.endSession('the sender closed the connection');
            }
        });
    }

    /**
     * Ends the current session.
     *
     * @param {string} why - Reason for the log
     */
    endSession(why) {
        const s = this.session;
        if (!s) {
            return;
        }
        this.session = null;
        this.o.timers.clearInterval(this.timingTimer);
        this.timingTimer = null;
        this.playout.reset();
        this.log.info(`${this.o.name}: AirPlay session of ${s.client} ended (${why})`);
        this.emit('end');
        if (!s.socket.destroyed) {
            s.socket.end();
        }
    }

    /**
     * @param {net.Socket} socket - RTSP connection
     * @param {import('./rtsp').RtspRequest} req - Request
     */
    handle(socket, req) {
        const h = req.headers;
        /** @type {Record<string, string | number>} */
        const headers = {
            CSeq: h.cseq || '0',
            Server: 'AirTunes/105.1',
            'Audio-Jack-Status': 'connected; type=analog',
        };
        if (h['apple-challenge']) {
            headers['Apple-Response'] = appleResponse(h['apple-challenge'], socket.localAddress || '', this.o.mac);
        }
        const reply = (status, extra = {}, body) => {
            if (socket.writable) {
                socket.write(formatResponse(status, { ...headers, ...extra }, body));
            }
        };
        const own = this.session?.socket === socket ? this.session : null;
        this.log.debug(`${this.o.name}: RTSP ${req.method} ${req.uri} from ${socket.remoteAddress}`);
        try {
            switch (req.method) {
                case 'OPTIONS':
                    return reply(200, { Public: PUBLIC });
                case 'ANNOUNCE':
                    return this.onAnnounce(socket, req, reply);
                case 'SETUP':
                    return this.onSetup(own, req, reply);
                case 'RECORD':
                    if (!own?.format) {
                        return reply(400);
                    }
                    own.recording = true;
                    this.playout.flush();
                    this.emit('session', { client: own.client, format: own.format, local: socket.localAddress || '' });
                    return reply(200, { 'Audio-Latency': 11025 });
                case 'FLUSH':
                    this.playout.flush();
                    return reply(200);
                case 'PAUSE':
                    return reply(200);
                case 'TEARDOWN':
                    reply(200, { Connection: 'close' });
                    if (own) {
                        this.endSession('the sender stopped');
                    }
                    return;
                case 'SET_PARAMETER':
                    if (own) {
                        this.onSetParameter(req);
                    }
                    return reply(200);
                case 'GET_PARAMETER':
                    return reply(
                        200,
                        { 'Content-Type': 'text/parameters' },
                        req.body.length ? 'volume: 0.000000\r\n' : '',
                    );
                default:
                    return reply(501);
            }
        } catch (e) {
            this.log.warn(`${this.o.name}: ${req.method} failed: ${e.message}`);
            reply(400);
        }
    }

    /**
     * @param {net.Socket} socket - RTSP connection
     * @param {import('./rtsp').RtspRequest} req - Request
     * @param {(status: number, extra?: object, body?: string) => void} reply - Answer
     */
    onAnnounce(socket, req, reply) {
        const announce = parseSdp(req.body.toString('utf8'));
        const client =
            req.headers['x-apple-client-name'] ||
            announce.info ||
            String(socket.remoteAddress || '').replace(/^::ffff:/, '');
        if (this.session && this.session.socket !== socket) {
            this.endSession(`${client} took over`);
        }
        const key = announce.rsaaeskey ? decryptAesKey(announce.rsaaeskey) : null;
        if (key && (!announce.aesIv || announce.aesIv.length !== 16)) {
            throw new Error('AES IV missing');
        }
        const f = announce.format;
        this.playout.reset();
        this.playout = this.newPlayout(f.frameLength, f.sampleRate);
        this.session = {
            socket,
            client,
            remote: socket.remoteAddress || '',
            format: f,
            key,
            iv: announce.aesIv,
            controlPort: 0,
            timingPort: 0,
            recording: false,
        };
        this.log.info(
            `${this.o.name}: AirPlay session from ${client}: ${f.codec.toUpperCase()} ${f.sampleRate} Hz, ` +
                `${f.channels} ch${key ? ', encrypted' : ''}`,
        );
        reply(200);
    }

    /**
     * @param {Session | null} own - Session of this connection
     * @param {import('./rtsp').RtspRequest} req - Request
     * @param {(status: number, extra?: object, body?: string) => void} reply - Answer
     */
    onSetup(own, req, reply) {
        if (!own) {
            return reply(400);
        }
        const t = parseTransport(req.headers.transport);
        own.controlPort = Number(t.control_port) || 0;
        own.timingPort = Number(t.timing_port) || 0;
        const [audio, control, timing] = this.udp.map(s => s.address().port);
        this.o.timers.clearInterval(this.timingTimer);
        this.timingTimer = this.o.timers.setInterval(() => this.sendTimingRequest(), 3000);
        this.sendTimingRequest();
        reply(200, {
            Transport: `RTP/AVP/UDP;unicast;mode=record;server_port=${audio};control_port=${control};timing_port=${timing}`,
            Session: '1',
        });
    }

    /**
     * @param {import('./rtsp').RtspRequest} req - SET_PARAMETER
     */
    onSetParameter(req) {
        const type = String(req.headers['content-type'] || '').toLowerCase();
        if (type.startsWith('text/parameters')) {
            const p = parseParameters(req.body.toString('utf8'));
            if (p.volume !== undefined && Number.isFinite(Number(p.volume))) {
                this.emit('volume', Number(p.volume));
            }
            if (p.progress) {
                const [start, current, end] = p.progress.split('/').map(Number);
                this.emit('progress', { start, current, end });
            }
        } else if (type.startsWith('application/x-dmap-tagged')) {
            this.emit('metadata', parseDmap(req.body));
        }
    }

    /**
     * @param {Buffer} payload - Encrypted frame
     * @returns {Buffer} Frame
     */
    decrypt(payload) {
        const s = this.session;
        return s?.key && s.iv ? cryptPayload(payload, s.key, s.iv) : Buffer.from(payload);
    }

    /**
     * @param {Buffer} msg - Packet on the audio port
     */
    onAudio(msg) {
        if (!this.session?.recording || msg.length < 13 || (msg[1] & 0x7f) !== 0x60) {
            return;
        }
        this.playout.push(msg.readUInt16BE(2), this.decrypt(msg.subarray(12)));
    }

    /**
     * @param {Buffer} msg - Packet on the control port: sync (0x54) or a retransmitted packet (0x56)
     */
    onControl(msg) {
        if (!this.session?.recording || msg.length < 17 || (msg[1] & 0x7f) !== 0x56) {
            return;
        }
        this.playout.push(msg.readUInt16BE(6), this.decrypt(msg.subarray(16)), true);
    }

    /**
     * Answers a timing request (0x52) of the sender.
     *
     * @param {Buffer} msg - Packet
     * @param {dgram.RemoteInfo} rinfo - Sender
     */
    onTiming(msg, rinfo) {
        if (msg.length < 32 || (msg[1] & 0x7f) !== 0x52) {
            return;
        }
        const out = Buffer.alloc(32);
        out[0] = 0x80;
        out[1] = 0xd3;
        out.writeUInt16BE(7, 2);
        msg.copy(out, 8, 24, 32); // their send time becomes the origin time
        const t = ntpNow();
        t.copy(out, 16);
        t.copy(out, 24);
        this.udp[2]?.send(out, rinfo.port, rinfo.address);
    }

    /**
     * Sends a timing request to the sender; a sender that hears nothing from us may stop after a while.
     */
    sendTimingRequest() {
        const s = this.session;
        if (!s?.timingPort || !this.udp[2]) {
            return;
        }
        const out = Buffer.alloc(32);
        out[0] = 0x80;
        out[1] = 0xd2;
        out.writeUInt16BE(7, 2);
        ntpNow().copy(out, 24);
        this.sendTo(this.udp[2], out, s.timingPort, s.remote);
    }

    /**
     * Asks the sender for lost packets.
     *
     * @param {number} seq - First lost sequence number
     * @param {number} count - Number of packets
     */
    requestResend(seq, count) {
        const s = this.session;
        if (!s?.controlPort || !this.udp[1]) {
            return;
        }
        const out = Buffer.alloc(8);
        out[0] = 0x80;
        out[1] = 0xd5;
        this.resendSeq = (this.resendSeq + 1) & 0xffff;
        out.writeUInt16BE(this.resendSeq, 2);
        out.writeUInt16BE(seq & 0xffff, 4);
        out.writeUInt16BE(Math.min(count, 0xffff), 6);
        this.sendTo(this.udp[1], out, s.controlPort, s.remote);
    }

    /**
     * @param {dgram.Socket} socket - Our socket
     * @param {Buffer} data - Packet
     * @param {number} port - Port of the sender
     * @param {string} address - Address of the sender
     */
    sendTo(socket, data, port, address) {
        let target = address;
        if (socket.address().family === 'IPv4') {
            target = target.replace(/^::ffff:/, '');
        } else if (net.isIPv4(target)) {
            target = `::ffff:${target}`;
        }
        socket.send(data, port, target, e => {
            if (e) {
                this.log.debug(`${this.o.name}: UDP send to ${target}:${port} failed: ${e.message}`);
            }
        });
    }
}

/**
 * @returns {Buffer} NTP time stamp of now (8 bytes)
 */
function ntpNow() {
    const ms = Date.now() + 2_208_988_800_000;
    const b = Buffer.alloc(8);
    b.writeUInt32BE(Math.floor(ms / 1000) >>> 0, 0);
    b.writeUInt32BE(Math.floor(((ms % 1000) / 1000) * 2 ** 32) >>> 0, 4);
    return b;
}

module.exports = { RaopReceiver };
