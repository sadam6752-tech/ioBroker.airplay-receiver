'use strict';

// Used resources registry of js-controller (doc/used-resources.md): only ports fixed by the configuration count.
// RTSP port 0 and the RTP/control/timing UDP sockets get a port from the OS, mDNS shares UDP 5353 with everyone:
// nobody can collide with those, so they are not registered.

/**
 * @typedef {{ port: number, bind?: string }} TcpPortData
 */

/**
 * @param {string} bind - Configured listen address
 * @returns {string | undefined} The address, or undefined for every address
 */
function bindOf(bind) {
    const b = String(bind || '').trim();
    return !b || b === '0.0.0.0' || b === '::' || b === '*' ? undefined : b;
}

/**
 * The TCP ports this instance occupies by its configuration.
 *
 * @param {number} httpPort - HTTP port of the streams
 * @param {string} bind - Listen address of the HTTP server
 * @param {{ rtspPort: number }[]} receivers - Receivers; rtspPort 0 = any free port
 * @returns {TcpPortData[]} Payloads for registerUsedResource('tcpPort', …)
 */
function usedTcpPorts(httpPort, bind, receivers) {
    /** @type {TcpPortData[]} */
    const out = [];
    const http = Number(httpPort);
    if (Number.isInteger(http) && http > 0 && http < 65536) {
        const b = bindOf(bind);
        out.push(b ? { port: http, bind: b } : { port: http });
    }
    for (const r of receivers) {
        const p = Number(r.rtspPort);
        // the RTSP server listens on every address
        if (Number.isInteger(p) && p > 0 && p < 65536 && !out.some(o => o.port === p)) {
            out.push({ port: p });
        }
    }
    return out;
}

module.exports = { usedTcpPorts, bindOf };
