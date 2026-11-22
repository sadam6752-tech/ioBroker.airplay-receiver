'use strict';

// The answer to "help" (js-controller PR #3638): its shape, the declaration in io-package.json, and that it names
// exactly the commands main.js handles and every state the adapter creates.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { HELP, COMMANDS, helpAnswer } = require('../../lib/help');

const root = path.join(__dirname, '..', '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const ioPackage = JSON.parse(fs.readFileSync(path.join(root, 'io-package.json'), 'utf8'));

/** Commands main.js answers, from `obj.command === '<name>'` */
const handled = [...main.matchAll(/obj\.command === '([^']+)'/g)].map(m => m[1]);
/** Commands that only serve the admin settings and are left out of the help on purpose */
const ADMIN_ONLY = ['listUrlStates'];

describe('help', () => {
    it('answers { help, commands: [{ command, write }] }', () => {
        const answer = helpAnswer();
        assert.equal(typeof answer.help, 'string');
        assert.ok(answer.help.trim().length > 200);
        assert.ok(answer.help.length < 20000, 'pi-agent cuts a help at 20000 characters');
        assert.ok(Array.isArray(answer.commands) && answer.commands.length > 0);
        for (const c of answer.commands) {
            assert.deepEqual(Object.keys(c).sort(), ['command', 'write']);
            assert.equal(typeof c.command, 'string');
            assert.equal(typeof c.write, 'boolean');
            assert.match(c.command, /^[A-Za-z][A-Za-z0-9_.:-]{0,39}$/);
        }
        assert.deepEqual(
            answer.commands.find(c => c.command === 'help'),
            { command: 'help', write: false },
        );
    });

    it('gives a copy, so a caller cannot change the list', () => {
        helpAnswer().commands[0].write = true;
        assert.equal(COMMANDS[0].write, false);
    });

    it('is declared in io-package.json, with the message box on', () => {
        assert.equal(ioPackage.common.supportedMessages?.help, true);
        assert.equal(ioPackage.common.messagebox, true);
    });

    it('lists every command main.js handles except the admin ones, and no other', () => {
        const listed = COMMANDS.map(c => c.command).sort();
        const expected = handled.filter(c => !ADMIN_ONLY.includes(c)).sort();
        assert.deepEqual(listed, expected);
        for (const c of ADMIN_ONLY) {
            assert.ok(handled.includes(c), `${c} is still handled`);
            assert.ok(!HELP.includes(c), `${c} stays out of the help`);
        }
    });

    it('names every state the adapter creates for a speaker', () => {
        const block = main.match(/const states = \[([\s\S]*?)\n\s*\];/);
        assert.ok(block, 'state list of createObjects found');
        const keys = [...block[1].matchAll(/\['([a-zA-Z]+)',/g)].map(m => m[1]);
        assert.ok(keys.length >= 8);
        for (const key of keys) {
            assert.match(HELP, new RegExp(`\\b${key}\\b`), `${key} is described`);
        }
    });

    it('holds no live values', () => {
        assert.doesNotMatch(HELP, /\d+\.\d+\.\d+\.\d+/, 'no IP address');
        assert.doesNotMatch(HELP, /airplay-receiver\.\d/, 'no fixed instance number');
    });
});
