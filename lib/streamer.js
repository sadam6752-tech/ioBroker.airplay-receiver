'use strict';

const http = require('node:http');
const { spawn } = require('node:child_process');
const mkv = require('./mkv');
const { silenceFrame } = require('./alac');

/**
 * @typedef {import('./types').Logger} Logger
 * @typedef {import('./sdp').AudioFormat} AudioFormat
 */

const CONTENT_TYPES = { flac: 'audio/flac', mp3: 'audio/mpeg' };

/** A client that does not read for this many bytes is dropped instead of filling the memory. */
const MAX_BACKLOG = 4 * 1024 * 1024;

/** A listener that leaves within this time (a probe, a reconnecting satellite) does not use up the preroll. */
const SETTLED_MS = 3000;

/**
 * ffmpeg arguments: Matroska with ALAC or PCM on stdin, FLAC or MP3 on stdout.
 *
 * @param {'flac' | 'mp3'} codec - Output codec
 * @param {number} sampleRate - Output sample rate
 * @param {number} channels - Output channels
 * @returns {string[]} Arguments
 */
function ffmpegArgs(codec, sampleRate, channels) {
    // MP3 like an internet radio: no ID3 tag, no Xing header (it would claim a length), LAME picks its own sample
    // format (it takes no s16); FLAC in 16 bit
    const out =
        codec === 'mp3'
            ? ['-c:a', 'libmp3lame', '-b:a', '192k', '-id3v2_version', '0', '-write_xing', '0', '-f', 'mp3']
            : ['-sample_fmt', 's16', '-c:a', 'flac', '-compression_level', '2', '-f', 'flac'];
    // prettier-ignore
    return [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-fflags', 'nobuffer', '-probesize', '32', '-analyzeduration', '0',
        '-f', 'matroska', '-i', 'pipe:0',
        '-map', '0:a:0', '-map_metadata', '-1',
        '-ar', String(sampleRate), '-ac', String(channels),
        ...out,
        '-flush_packets', '1',
        'pipe:1',
    ];
}

/**
 * The HTTP stream of one receiver. Exactly one listener at a time: a new request (the satellite, after the probe of
 * ioBroker.assistant) replaces the old one. Each listener gets its own ffmpeg, so its stream starts with a proper
 * header. Frames that arrive after the start of the audio and before the first listener (the satellite needs a moment
 * to connect) are kept and handed to that listener, up to `prerollMs`.
 */
class Channel {
    /**
     * @param {object} options - Options
     * @param {string} options.id - Path name
     * @param {'flac' | 'mp3'} options.codec - Output codec
     * @param {number} options.sampleRate - Output sample rate
     * @param {number} options.channels - Output channels
     * @param {number} options.prerollMs - Frames kept for the first listener
     * @param {string} options.ffmpegPath - ffmpeg binary
     * @param {Logger} options.log - Logger
     * @param {() => void} [options.onListener] - A listener (the satellite) opened the stream
     * @param {string} options.name - Receiver name for log lines
     */
    constructor(options) {
        this.o = options;
        /** @type {AudioFormat | null} */
        this.format = null;
        /** @type {Buffer[]} */
        this.preroll = [];
        this.collecting = false;
        /** @type {{res: http.ServerResponse, proc: import('node:child_process').ChildProcess, samples: number, since: number} | null} */
        this.client = null;
        this.listeners = 0;
    }

    /** @returns {string} Path of the stream */
    get path() {
        return `/${this.o.id}.${this.o.codec}`;
    }

    /**
     * A new session: its format, and the listener of the previous one (other format) is dropped.
     *
     * @param {AudioFormat} format - Audio format of the sender
     */
    setFormat(format) {
        const old = this.format;
        this.format = format;
        if (old && JSON.stringify(old) !== JSON.stringify(format)) {
            this.disconnect();
        }
    }

    /**
     * Audio starts: keep frames until the satellite connects.
     */
    startPreroll() {
        this.preroll = [];
        this.collecting = !this.client || Date.now() - this.client.since < SETTLED_MS;
    }

    /**
     * @param {Buffer | null} frame - Frame, null = silence
     */
    push(frame) {
        const f = this.format;
        if (!f) {
            return;
        }
        const data = frame || silence(f);
        if (this.client) {
            this.write(data);
            if (this.collecting && Date.now() - this.client.since >= SETTLED_MS) {
                this.collecting = false;
                this.preroll = [];
            }
        }
        if (this.collecting) {
            this.preroll.push(data);
            const max = Math.ceil((this.o.prerollMs * f.sampleRate) / 1000 / f.frameLength);
            if (this.preroll.length > max) {
                this.preroll.shift();
            }
        }
    }

    /**
     * @param {Buffer} frame - Codec frame for the current listener
     */
    write(frame) {
        const c = this.client;
        const f = this.format;
        if (!c || !f || !c.proc.stdin || c.proc.stdin.destroyed) {
            return;
        }
        if (c.proc.stdin.writableLength > MAX_BACKLOG) {
            this.o.log.warn(`${this.o.name}: the satellite does not read the stream, disconnecting it`);
            this.disconnect();
            return;
        }
        c.proc.stdin.write(mkv.cluster(frame, (c.samples * 1000) / f.sampleRate));
        c.samples += f.frameLength;
    }

    /**
     * @param {http.IncomingMessage} req - Request
     * @param {http.ServerResponse} res - Response
     */
    serve(req, res) {
        const f = this.format;
        if (!f) {
            res.writeHead(503, { 'Content-Type': 'text/plain' }).end('Nothing is playing');
            return;
        }
        const headers = {
            'Content-Type': CONTENT_TYPES[this.o.codec],
            'Cache-Control': 'no-cache, no-store',
            Connection: 'close',
        };
        // ioBroker.assistant looks at the headers first and drops the connection: no ffmpeg for that
        if (req.method === 'HEAD' || /^ioBroker.assistant/i.test(String(req.headers['user-agent'] || ''))) {
            res.writeHead(200, headers).end();
            return;
        }
        this.disconnect();
        const proc = spawn(this.o.ffmpegPath, ffmpegArgs(this.o.codec, this.o.sampleRate, this.o.channels), {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        const client = { res, proc, samples: 0, since: Date.now() };
        this.client = client;
        this.listeners++;
        const peer = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
        this.o.log.debug(`${this.o.name}: stream ${this.path} to ${peer}`);
        this.o.onListener?.();
        let stderr = '';
        proc.stderr?.on('data', d => {
            stderr = (stderr + d).slice(-2000);
        });
        proc.stdin?.on('error', () => undefined);
        proc.on('error', e => {
            this.o.log.warn(`${this.o.name}: ffmpeg did not start: ${e.message}`);
            this.drop(client);
        });
        proc.on('exit', code => {
            if (code && stderr.trim()) {
                this.o.log.warn(`${this.o.name}: ffmpeg ended with code ${code}: ${stderr.trim().split('\n').pop()}`);
            }
            this.drop(client);
        });
        // like an internet radio: no chunked transfer, the body runs until the connection closes. The HTTP client of
        // ESP-IDF tries to read a chunked response to its end when it closes it, and an endless stream has none: the
        // player of an ESPHome display hung on every stop (seen with the tile panel of ioBroker.satellite-display).
        res.useChunkedEncodingByDefault = false;
        res.writeHead(200, headers);
        res.flushHeaders();
        proc.stdout?.pipe(res);
        res.on('close', () => this.drop(client));
        proc.stdin?.write(mkv.header(f));
        // the preroll stays until this listener has settled: if it leaves early, the next one gets it again
        for (const frame of [...this.preroll]) {
            this.write(frame);
        }
    }

    /**
     * @param {{res: http.ServerResponse, proc: import('node:child_process').ChildProcess}} client - Listener to end
     */
    drop(client) {
        if (this.client === client) {
            this.client = null;
        }
        // stop the pipe first: ffmpeg may still have output on its way into the ended response
        client.proc.stdout?.unpipe(client.res);
        client.proc.stdout?.resume();
        if (client.proc.exitCode === null && !client.proc.killed) {
            client.proc.kill('SIGKILL');
        }
        if (!client.res.writableEnded) {
            client.res.end();
        }
    }

    /**
     * Ends the current listener.
     */
    disconnect() {
        if (this.client) {
            this.drop(this.client);
        }
    }

    /**
     * Session over: no format, no listener, no preroll.
     */
    reset() {
        this.disconnect();
        this.format = null;
        this.preroll = [];
        this.collecting = false;
    }
}

/** @type {Map<string, Buffer>} */
const pcmSilence = new Map();

/**
 * @param {AudioFormat} f - Format
 * @returns {Buffer} One frame of silence in that format
 */
function silence(f) {
    if (f.codec === 'alac') {
        return silenceFrame(f.channels, f.frameLength);
    }
    const key = `${f.channels}/${f.frameLength}`;
    let b = pcmSilence.get(key);
    if (!b) {
        b = Buffer.alloc(f.channels * f.frameLength * 2);
        pcmSilence.set(key, b);
    }
    return b;
}

/**
 * The HTTP server of all receivers.
 */
class StreamServer {
    /**
     * @param {Logger} log - Logger
     */
    constructor(log) {
        this.log = log;
        /** @type {Map<string, Channel>} */
        this.channels = new Map();
        /** @type {http.Server | null} */
        this.server = null;
    }

    /**
     * @param {Channel} channel - Channel to serve
     */
    add(channel) {
        this.channels.set(channel.path, channel);
    }

    /**
     * @param {number} port - Port
     * @param {string} bind - Address
     * @returns {Promise<number>} Port
     */
    async listen(port, bind) {
        const server = http.createServer((req, res) => {
            const path = new URL(req.url || '/', 'http://x').pathname;
            const channel = this.channels.get(path);
            if (!channel || (req.method !== 'GET' && req.method !== 'HEAD')) {
                res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
                return;
            }
            channel.serve(req, res);
        });
        this.server = server;
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, bind || undefined, () => {
                server.off('error', reject);
                resolve(undefined);
            });
        });
        server.on('error', e => this.log.warn(`HTTP server error: ${e.message}`));
        return /** @type {import('node:net').AddressInfo} */ (server.address()).port;
    }

    /**
     * Ends every stream and closes the server.
     */
    async close() {
        for (const c of this.channels.values()) {
            c.reset();
        }
        const server = this.server;
        this.server = null;
        if (server) {
            server.closeAllConnections();
            await new Promise(resolve => server.close(() => resolve(undefined)));
        }
    }
}

module.exports = { Channel, StreamServer, ffmpegArgs };
