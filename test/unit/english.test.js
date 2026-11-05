'use strict';

// The README (shown on GitHub and npm) and every English text of the adapter must be English.
// A list of frequent German and Russian words catches texts that slipped in untranslated.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

const FOREIGN = [
    // German
    'und',
    'nicht',
    'wird',
    'werden',
    'für',
    // not 'mit': the README has the MIT License
    'oder',
    'eine',
    'einen',
    'lautsprecher',
    'haustür',
    'einstellungen',
    'lautstärke',
    'satelliten',
    // Russian
    'и',
    'не',
    'колонка',
    'громкость',
];

/**
 * @param {string} text - Text to check
 * @returns {string[]} Foreign words found in the text
 */
function foreignWords(text) {
    const words = text.toLowerCase().match(/[\p{L}]+/gu) || [];
    return [...new Set(words.filter(w => FOREIGN.includes(w)))];
}

/**
 * @param {any} node - JSON part
 * @param {string[]} out - Collected English texts
 */
function englishValues(node, out) {
    if (Array.isArray(node)) {
        node.forEach(n => englishValues(n, out));
    } else if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
            if (key === 'en' && typeof value === 'string') {
                out.push(value);
            } else {
                englishValues(value, out);
            }
        }
    }
}

describe('English texts', () => {
    it('the README is English', () => {
        const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
        assert.deepEqual(foreignWords(readme), []);
    });

    it('the English admin texts and the English values of io-package.json are English', () => {
        const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'admin', 'i18n', 'en.json'), 'utf8'));
        const texts = [...Object.keys(en), ...Object.values(en)];
        englishValues(JSON.parse(fs.readFileSync(path.join(ROOT, 'io-package.json'), 'utf8')), texts);
        assert.deepEqual(foreignWords(texts.join('\n')), []);
    });

    it('finds a German word (proof that the check works)', () => {
        assert.deepEqual(foreignWords('Record the Haustür camera und send it'), ['haustür', 'und']);
    });
});
