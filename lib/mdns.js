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

/**
 * Announces speakers with mDNS (`_raop._tcp`), pure JavaScript, no system daemon needed.
 */
class Announcer {
    /**
     * @param {(e: Error) => void} onError - Error handler
     */
    constructor(onError) {
        this.bonjour = new Bonjour({}, onError);
        /** @type {any[]} */
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

module.exports = { Announcer, raopTxt, serviceName, mdnsHost };
