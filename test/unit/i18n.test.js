'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { NAMES } = require('../../lib/names');

const ROOT = path.join(__dirname, '..', '..');
const LANGS = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];

/**
 * @param {any} node - Part of jsonConfig.json
 * @param {Set<string>} keys - Collected texts
 */
function collect(node, keys) {
    if (Array.isArray(node)) {
        node.forEach(n => collect(n, keys));
        return;
    }
    if (!node || typeof node !== 'object') {
        return;
    }
    for (const attr of ['label', 'help', 'text', 'title', 'unit']) {
        if (typeof node[attr] === 'string') {
            keys.add(node[attr]);
        }
    }
    for (const [attr, value] of Object.entries(node)) {
        // noTranslation keeps the option labels of a select as they are
        if (!(attr === 'options' && node.noTranslation === true)) {
            collect(value, keys);
        }
    }
}

describe('translations', () => {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'admin', 'jsonConfig.json'), 'utf8'));
    const keys = new Set();
    collect(config, keys);

    for (const lang of LANGS) {
        it(`admin/i18n/${lang}.json has exactly the texts of jsonConfig.json`, () => {
            const file = JSON.parse(fs.readFileSync(path.join(ROOT, 'admin', 'i18n', `${lang}.json`), 'utf8'));
            assert.deepEqual(Object.keys(file).sort(), [...keys].sort());
            for (const [key, value] of Object.entries(file)) {
                assert.ok(typeof value === 'string' && value.trim(), `${lang}: empty value for "${key}"`);
                for (const placeholder of key.match(/\{[a-z]+\}/g) || []) {
                    assert.ok(value.includes(placeholder), `${lang}: "${key}" lost ${placeholder}`);
                }
            }
        });
    }

    it('every object name exists in all eleven languages', () => {
        for (const [id, name] of Object.entries(NAMES)) {
            assert.deepEqual(Object.keys(name).sort(), [...LANGS].sort(), id);
        }
        const io = JSON.parse(fs.readFileSync(path.join(ROOT, 'io-package.json'), 'utf8'));
        for (const obj of io.instanceObjects) {
            assert.deepEqual(Object.keys(obj.common.name).sort(), [...LANGS].sort(), obj._id);
        }
        for (const field of ['titleLang', 'desc']) {
            assert.deepEqual(Object.keys(io.common[field]).sort(), [...LANGS].sort(), field);
        }
        for (const [version, news] of Object.entries(io.common.news)) {
            assert.deepEqual(Object.keys(news).sort(), [...LANGS].sort(), `news ${version}`);
        }
    });

    it('a guard test catches a missing key (proof that the check works)', () => {
        const broken = new Set(keys);
        broken.add('A text nobody translated');
        const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'admin', 'i18n', 'en.json'), 'utf8'));
        assert.notDeepEqual(Object.keys(en).sort(), [...broken].sort());
    });
});
