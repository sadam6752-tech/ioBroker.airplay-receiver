'use strict';

// A small AirPlay 1 sender for the tests: it does what an iPhone does (challenge, RSA wrapped AES key, ALAC frames,
// retransmissions on request, volume and metadata), so the whole chain can be tested without Apple hardware.

const net = require('node:net');
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const { encryptAesKey, cryptPayload, verifyAppleResponse } = require('../../lib/raop-crypto');
const { escapeFrame } = require('../../lib/alac');

class RaopSender {
    /**
     * @param {object} o - Options
     * @param {number} o.port - RTSP port of the receiver
     * @param {boolean} [o.encrypt] - Encrypt the audio
     * @param {(seq: number) => boolean} [o.drop] - Packets not sent at first (lost on the way)
     */
    constructor(o) {
        this.o = { encrypt: true, drop: () => false, ...o };
        this.cseq = 0;
        this.key = crypto.randomBytes(16);
        this.iv = crypto.randomBytes(16);
        /** @type {Map<number, Buffer>} */
        this.sent = new Map();
        this.resendRequests = 0;
        this.buffer = '';
        /** @type {Array<(r: any) => void>} */
        this.waiting = [];
    }

    async connect() {
        this.socket = net.connect(this.o.port, '127.0.0.1');
        await new Promise((resolve, reject) => {
            this.socket.once('connect', resolve);
            this.socket.once('error', reject);
        });
        this.socket.on('data', d => this.onData(d));
        this.control = dgram.createSocket('udp4');
        this.timing = dgram.createSocket('udp4');
        this.audio = dgram.createSocket('udp4');
        await Promise.all([this.control, this.timing, this.audio].map(s => new Promise(r => s.bind(0, '127.0.0.1', r))));
        this.control.on('message', msg => this.onControl(msg));
        this.timingRequests = 0;
        this.timing.on('message', () => this.timingRequests++);
    }

    /** @param {Buffer} d - Data */
    onData(d) {
        this.buffer += d.toString('latin1');
        for (;;) {
            const end = this.buffer.indexOf('\r\n\r\n');
            if (end < 0) {
                return;
            }
            const head = this.buffer.slice(0, end).split('\r\n');
            const headers = {};
            for (const l of head.slice(1)) {
                const i = l.indexOf(':');
                headers[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim();
            }
            const len = Number(headers['content-length']) || 0;
            if (this.buffer.length < end + 4 + len) {
                return;
            }
            const body = this.buffer.slice(end + 4, end + 4 + len);
            this.buffer = this.buffer.slice(end + 4 + len);
            this.waiting.shift()?.({ status: Number(head[0].split(' ')[1]), headers, body });
        }
    }

    /**
     * @param {string} method - Method
     * @param {Record<string, string>} [headers] - Headers
     * @param {Buffer | string} [body] - Body
     * @returns {Promise<{status: number, headers: Record<string, string>, body: string}>} Response
     */
    request(method, headers = {}, body = '') {
        const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
        const lines = [`${method} rtsp://127.0.0.1/1234 RTSP/1.0`, `CSeq: ${++this.cseq}`];
        for (const [k, v] of Object.entries(headers)) {
            lines.push(`${k}: ${v}`);
        }
        if (data.length) {
            lines.push(`Content-Length: ${data.length}`);
        }
        const p = new Promise(resolve => this.waiting.push(resolve));
        this.socket.write(Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`), data]));
        return p;
    }

    /**
     * OPTIONS with challenge, ANNOUNCE, SETUP, RECORD.
     *
     * @returns {Promise<Buffer>} The data the receiver signed
     */
    async start() {
        const challenge = crypto.randomBytes(16);
        const opt = await this.request('OPTIONS', { 'Apple-Challenge': challenge.toString('base64').replace(/=+$/, '') });
        if (opt.status !== 200 || !opt.headers['apple-response']) {
            throw new Error(`OPTIONS failed: ${opt.status}`);
        }
        const signed = verifyAppleResponse(opt.headers['apple-response']);
        if (!signed.subarray(0, 16).equals(challenge)) {
            throw new Error('Apple-Response does not sign the challenge');
        }
        const sdp = [
            'v=0',
            'o=iTunes 3413821438 0 IN IP4 127.0.0.1',
            's=iTunes',
            'c=IN IP4 127.0.0.1',
            't=0 0',
            'm=audio 0 RTP/AVP 96',
            'a=rtpmap:96 AppleLossless',
            'a=fmtp:96 352 0 16 40 10 14 2 255 0 0 44100',
            ...(this.o.encrypt
                ? [`a=rsaaeskey:${encryptAesKey(this.key).replace(/=+$/, '')}`, `a=aesiv:${this.iv.toString('base64').replace(/=+$/, '')}`]
                : []),
            '',
        ].join('\r\n');
        const ann = await this.request(
            'ANNOUNCE',
            { 'Content-Type': 'application/sdp', 'X-Apple-Client-Name': 'Test iPhone' },
            sdp,
        );
        if (ann.status !== 200) {
            throw new Error(`ANNOUNCE failed: ${ann.status}`);
        }
        const setup = await this.request('SETUP', {
            Transport: `RTP/AVP/UDP;unicast;interleaved=0-1;mode=record;control_port=${this.control.address().port};timing_port=${this.timing.address().port}`,
        });
        const t = Object.fromEntries(
            setup.headers.transport.split(';').filter(p => p.includes('=')).map(p => p.split('=')),
        );
        this.serverPort = Number(t.server_port);
        this.serverControl = Number(t.control_port);
        const rec = await this.request('RECORD', { Range: 'npt=0-', 'RTP-Info': 'seq=0;rtptime=0' });
        if (rec.status !== 200) {
            throw new Error(`RECORD failed: ${rec.status}`);
        }
        return signed;
    }

    /**
     * @param {number} seq - Sequence number
     * @param {Int16Array} samples - 352 stereo samples
     * @returns {Buffer} RTP packet
     */
    packet(seq, samples) {
        const frame = escapeFrame(samples, 2, 352);
        const payload = this.o.encrypt ? cryptPayload(frame, this.key, this.iv, true) : frame;
        const head = Buffer.alloc(12);
        head[0] = 0x80;
        head[1] = 0x60;
        head.writeUInt16BE(seq & 0xffff, 2);
        head.writeUInt32BE((seq * 352) >>> 0, 4);
        head.writeUInt32BE(0x1234, 8);
        return Buffer.concat([head, payload]);
    }

    /**
     * Sends one packet (unless it is "lost").
     *
     * @param {number} seq - Sequence number
     * @param {Int16Array} samples - Samples
     */
    send(seq, samples) {
        const p = this.packet(seq, samples);
        this.sent.set(seq & 0xffff, p);
        if (!this.o.drop(seq)) {
            this.audio.send(p, this.serverPort, '127.0.0.1');
        }
    }

    /** @param {Buffer} msg - Resend request */
    onControl(msg) {
        if ((msg[1] & 0x7f) !== 0x55) {
            return;
        }
        this.resendRequests++;
        const first = msg.readUInt16BE(4);
        const count = msg.readUInt16BE(6);
        for (let i = 0; i < count; i++) {
            const p = this.sent.get((first + i) & 0xffff);
            if (p) {
                const head = Buffer.from([0x80, 0xd6, 0x00, 0x01]);
                this.control.send(Buffer.concat([head, p]), this.serverControl, '127.0.0.1');
            }
        }
    }

    /**
     * @param {number} db - Volume in dB
     */
    volume(db) {
        return this.request('SET_PARAMETER', { 'Content-Type': 'text/parameters' }, `volume: ${db.toFixed(6)}\r\n`);
    }

    /**
     * @param {Buffer} dmap - DMAP block
     */
    metadata(dmap) {
        return this.request('SET_PARAMETER', { 'Content-Type': 'application/x-dmap-tagged' }, dmap);
    }

    async teardown() {
        await this.request('TEARDOWN');
    }

    close() {
        this.socket?.destroy();
        for (const s of [this.control, this.timing, this.audio]) {
            s?.close();
        }
    }
}

/**
 * 352 stereo samples of a sine.
 *
 * @param {number} index - Frame number
 * @param {number} [hz] - Frequency
 * @returns {Int16Array} Samples
 */
function sineFrame(index, hz = 441) {
    const s = new Int16Array(704);
    for (let i = 0; i < 352; i++) {
        const v = Math.round(10000 * Math.sin((2 * Math.PI * hz * (index * 352 + i)) / 44100));
        s[2 * i] = v;
        s[2 * i + 1] = v;
    }
    return s;
}

module.exports = { RaopSender, sineFrame };
