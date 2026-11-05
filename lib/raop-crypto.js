'use strict';

const crypto = require('node:crypto');
const net = require('node:net');
const AIRPORT_KEY = require('./airport-key');

const privateKey = crypto.createPrivateKey(AIRPORT_KEY);

/**
 * The bytes of an IP address as the sender sees it: 4 for IPv4 (also for an IPv4-mapped IPv6 address), 16 for IPv6.
 *
 * @param {string} address - Local address of the RTSP connection
 * @returns {Buffer} Address bytes
 */
function addressBytes(address) {
    let a = String(address || '').replace(/%.*$/, '');
    if (a.toLowerCase().startsWith('::ffff:') && net.isIPv4(a.slice(7))) {
        a = a.slice(7);
    }
    if (net.isIPv4(a)) {
        return Buffer.from(a.split('.').map(Number));
    }
    if (!net.isIPv6(a)) {
        return Buffer.alloc(4);
    }
    const [head, tail = ''] = a.split('::');
    const parse = part => (part ? part.split(':') : []);
    const h = parse(head);
    const t = parse(tail);
    const groups = a.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
    const out = Buffer.alloc(16);
    groups.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16) || 0, i * 2));
    return out;
}

/**
 * The answer to an `Apple-Challenge`: challenge, local address and hardware address, at least 32 bytes, signed with
 * the AirPort key (PKCS#1 v1.5 type 1, no hash), base64 without padding.
 *
 * @param {string} challenge - Base64 challenge of the sender
 * @param {string} localAddress - Address the sender reached us on
 * @param {Buffer} mac - Hardware address of the receiver (6 bytes, the one in the service name)
 * @returns {string} Value of the `Apple-Response` header
 */
function appleResponse(challenge, localAddress, mac) {
    let data = Buffer.concat([Buffer.from(challenge, 'base64'), addressBytes(localAddress), mac]);
    if (data.length < 32) {
        data = Buffer.concat([data, Buffer.alloc(32 - data.length)]);
    }
    const signature = crypto.privateEncrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }, data);
    return signature.toString('base64').replace(/=+$/, '');
}

/**
 * The AES key of a session: the sender encrypted it with the public AirPort key (RSA-OAEP, SHA-1).
 *
 * @param {string} rsaaeskey - Base64 value of `a=rsaaeskey`
 * @returns {Buffer} 16 byte AES key
 */
function decryptAesKey(rsaaeskey) {
    return crypto.privateDecrypt(
        { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
        Buffer.from(rsaaeskey, 'base64'),
    );
}

/**
 * Encrypts an AES key like a sender does (for tests and the test sender).
 *
 * @param {Buffer} key - AES key
 * @returns {string} Base64 value for `a=rsaaeskey`
 */
function encryptAesKey(key) {
    const publicKey = crypto.createPublicKey(privateKey);
    return crypto
        .publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, key)
        .toString('base64');
}

/**
 * Checks an `Apple-Response` like a sender does (for tests).
 *
 * @param {string} response - Base64 signature
 * @returns {Buffer} The signed data
 */
function verifyAppleResponse(response) {
    const publicKey = crypto.createPublicKey(privateKey);
    return crypto.publicDecrypt(
        { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
        Buffer.from(response, 'base64'),
    );
}

/**
 * Audio payload of one RTP packet: AES-128-CBC with the session IV for every packet, only whole 16 byte blocks are
 * encrypted, the rest stays plain.
 *
 * @param {Buffer} payload - Encrypted payload
 * @param {Buffer} key - AES key
 * @param {Buffer} iv - AES IV
 * @param {boolean} [encrypt] - Encrypt instead (test sender)
 * @returns {Buffer} Decrypted payload
 */
function cryptPayload(payload, key, iv, encrypt = false) {
    const n = payload.length & ~15;
    if (n === 0) {
        return Buffer.from(payload);
    }
    const c = encrypt ? crypto.createCipheriv('aes-128-cbc', key, iv) : crypto.createDecipheriv('aes-128-cbc', key, iv);
    c.setAutoPadding(false);
    return Buffer.concat([c.update(payload.subarray(0, n)), c.final(), payload.subarray(n)]);
}

/**
 * A stable, locally administered hardware address for a receiver name: the sender keys its speaker list by it.
 *
 * @param {string} name - Receiver name
 * @returns {Buffer} 6 bytes
 */
function macFor(name) {
    const mac = crypto.createHash('sha256').update(`airplay-receiver:${name}`).digest().subarray(0, 6);
    mac[0] = (mac[0] & 0xfe) | 0x02;
    return Buffer.from(mac);
}

module.exports = {
    addressBytes,
    appleResponse,
    decryptAesKey,
    encryptAesKey,
    verifyAppleResponse,
    cryptPayload,
    macFor,
};
