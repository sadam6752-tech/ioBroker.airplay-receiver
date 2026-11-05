'use strict';

/** Largest RTSP message we accept (artwork comes as SET_PARAMETER and may be large). */
const MAX_MESSAGE = 8 * 1024 * 1024;

/**
 * @typedef {object} RtspRequest
 * @property {string} method - RTSP method
 * @property {string} uri - Request URI
 * @property {Record<string, string>} headers - Headers with lower case names
 * @property {Buffer} body - Body
 */

/**
 * Splits a byte stream into RTSP requests.
 */
class RtspParser {
    /** Creates an empty parser */
    constructor() {
        /** @type {Buffer} */
        this.buffer = Buffer.alloc(0);
    }

    /**
     * @param {Buffer} chunk - Data from the socket
     * @returns {RtspRequest[]} Complete requests
     */
    push(chunk) {
        this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
        if (this.buffer.length > MAX_MESSAGE) {
            throw new Error('RTSP message too large');
        }
        /** @type {RtspRequest[]} */
        const out = [];
        for (;;) {
            const end = this.buffer.indexOf('\r\n\r\n');
            if (end < 0) {
                break;
            }
            const lines = this.buffer.subarray(0, end).toString('utf8').split('\r\n');
            const [method = '', uri = ''] = lines[0].split(' ');
            /** @type {Record<string, string>} */
            const headers = {};
            for (const line of lines.slice(1)) {
                const i = line.indexOf(':');
                if (i > 0) {
                    headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
                }
            }
            const length = Number(headers['content-length']) || 0;
            if (length > MAX_MESSAGE) {
                throw new Error('RTSP message too large');
            }
            if (this.buffer.length < end + 4 + length) {
                break;
            }
            const body = Buffer.from(this.buffer.subarray(end + 4, end + 4 + length));
            this.buffer = this.buffer.subarray(end + 4 + length);
            out.push({ method, uri, headers, body });
        }
        return out;
    }
}

const STATUS = {
    200: 'OK',
    400: 'Bad Request',
    404: 'Not Found',
    453: 'Not Enough Bandwidth',
    501: 'Not Implemented',
};

/**
 * @param {number} status - Status code
 * @param {Record<string, string | number>} headers - Headers
 * @param {Buffer | string} [body] - Body
 * @returns {Buffer} Response bytes
 */
function formatResponse(status, headers, body) {
    const data = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(body);
    const all = { ...headers };
    if (data.length) {
        all['Content-Length'] = data.length;
    }
    const head = [`RTSP/1.0 ${status} ${STATUS[status] || 'Error'}`];
    for (const [k, v] of Object.entries(all)) {
        head.push(`${k}: ${v}`);
    }
    return Buffer.concat([Buffer.from(`${head.join('\r\n')}\r\n\r\n`), data]);
}

/**
 * @param {string} value - `Transport` header
 * @returns {Record<string, string>} Its `key=value` parts
 */
function parseTransport(value) {
    /** @type {Record<string, string>} */
    const out = {};
    for (const part of String(value || '').split(';')) {
        const i = part.indexOf('=');
        if (i > 0) {
            out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
        }
    }
    return out;
}

/**
 * @param {string} body - `text/parameters` body
 * @returns {Record<string, string>} Parameters
 */
function parseParameters(body) {
    /** @type {Record<string, string>} */
    const out = {};
    for (const line of String(body).split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i > 0) {
            out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
        }
    }
    return out;
}

module.exports = { RtspParser, formatResponse, parseTransport, parseParameters };
