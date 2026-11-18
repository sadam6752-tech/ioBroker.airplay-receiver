'use strict';

const os = require('node:os');
const { Bonjour } = require('bonjour-service');

/**
 * TXT record of an AirPlay 1 speaker: ALAC and PCM, unencrypted or RSA, text, artwork and progress metadata, no
 * password.
 *
 * @returns {Record<string, string>} TXT values
 */
function raopTxt() {
    return {
        txtvers: '1',
        ch: '2',
        cn: '0,1',
        et: '0,1',
        ek: '1',
        md: '0,1,2',
        pw: 'false',
        sr: '44100',
        ss: '16',
        tp: 'UDP',
        vn: '65537',
        vs: '105.1',
        am: 'ioBrokerAirPlayReceiver',
        sf: '0x4',
        da: 'true',
        sv: 'false',
    };
}

/**
 * The service name of a speaker: hardware address in hex, then the visible name.
 *
 * @param {Buffer} mac - Hardware address
 * @param {string} name - Speaker name
 * @returns {string} Service instance name
 */
function serviceName(mac, name) {
    return `${mac.toString('hex').toUpperCase()}@${name}`;
}

/**
 * The host name in the SRV and A records. It must end in `.local` (bonjour-service takes the bare
 * `os.hostname()`, which an iPhone then looks up in the normal DNS and gives up), and it is our own name, so it
 * never collides with the `<host>.local` of avahi on the same machine.
 *
 * @param {string} [hostname] - Host name of the machine
 * @returns {string} mDNS host name
 */
function mdnsHost(hostname = os.hostname()) {
    const base =
        String(hostname)
            .split('.')[0]
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'iobroker';
    return `${base}-airplay.local`;
}

/** A network outage counts as over after this long without an error */
const QUIET_MS = 60_000;

/**
 * Collects the errors of an outage into one warning. Without network every announcement fails
 * (`send ENETUNREACH 224.0.0.251:5353`, five per round), which wrote 25 warnings in 18 s when the router restarted
 * (2026-11-18). The first error of an outage is a warning, the repeats are only counted, and once no error came for
 * {@link QUIET_MS} one info line says that it works again and how many repeats there were.
 */
class ErrorDigest {
    /**
     * @param {object} options - Options
     * @param {(text: string) => void} options.warn - Warning
     * @param {(text: string) => void} options.info - Info
     * @param {(fn: () => void, ms: number) => unknown} options.setTimeout - Timer of the adapter
     * @param {(timer: any) => void} options.clearTimeout - Clears it
     * @param {number} [options.quietMs] - Time without an error that ends the outage
     */
    constructor({ warn, info, setTimeout, clearTimeout, quietMs = QUIET_MS }) {
        this.warn = warn;
        this.info = info;
        this.setTimer = setTimeout;
        this.clearTimer = clearTimeout;
        this.quietMs = quietMs;
        /** Repeats suppressed in the current outage, -1 = no outage */
        this.repeats = -1;
        /** @type {unknown} */
        this.timer = null;
    }

    /**
     * @param {string} text - Error text
     */
    report(text) {
        if (this.repeats < 0) {
            this.repeats = 0;
            this.warn(`${text} (more errors of this kind are counted, not logged, until it works again)`);
        } else {
            this.repeats++;
        }
        if (this.timer) {
            this.clearTimer(this.timer);
        }
        this.timer = this.setTimer(() => this.recovered(), this.quietMs);
    }

    /** No error for a while: the outage is over. */
    recovered() {
        this.timer = null;
        const repeats = this.repeats;
        this.repeats = -1;
        this.info(
            `mDNS works again${repeats > 0 ? ` (${repeats} more error${repeats === 1 ? '' : 's'} not logged)` : ''}`,
        );
    }

    /** Stops the timer (unload). */
    stop() {
        if (this.timer) {
            this.clearTimer(this.timer);
            this.timer = null;
        }
    }
}

/**
 * Announces speakers with mDNS (`_raop._tcp`), pure JavaScript, no system daemon needed.
 */
class Announcer {
    /**
     * @param {(e: Error) => void} onError - Error handler
     */
    constructor(onError) {
        this.bonjour = new Bonjour({}, onError);
        /** @type {import('bonjour-service').Service[]} */
        this.services = [];
    }

    /**
     * @param {Buffer} mac - Hardware address
     * @param {string} name - Speaker name
     * @param {number} port - RTSP port
     * @param {(e: Error) => void} onError - Error of this service (e.g. the name is taken)
     */
    publish(mac, name, port, onError) {
        const service = this.bonjour.publish({
            name: serviceName(mac, name),
            type: 'raop',
            protocol: 'tcp',
            port,
            host: mdnsHost(),
            txt: raopTxt(),
            // the satellite and most senders talk IPv4; an IPv6 link-local address only causes detours
            disableIPv6: true,
        });
        service.on('error', onError);
        this.services.push(service);
    }

    /**
     * Withdraws every speaker (goodbye packets) and closes the socket.
     *
     * @returns {Promise<void>} Done
     */
    async close() {
        // both callbacks come once the goodbye packets are sent and the socket is closed
        await new Promise(resolve => this.bonjour.unpublishAll(() => resolve(undefined)));
        await new Promise(resolve => this.bonjour.destroy(() => resolve(undefined)));
    }
}

module.exports = { Announcer, ErrorDigest, raopTxt, serviceName, mdnsHost, QUIET_MS };
