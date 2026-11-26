const { test } = require('node:test');
const assert = require('node:assert/strict');
const security = require('../frontend-security.js');

test('HTML text and attribute delimiters cannot introduce markup', () => {
    assert.equal(security.escapeHTML('<img src=x onerror="attack()">\'&'),
        '&lt;img src=x onerror=&quot;attack()&quot;&gt;&#39;&amp;');
    assert.equal(security.escapeHTML(null), '');
    assert.equal(security.escapeHTML('娃头\n要求 ♡'), '娃头\n要求 ♡');
});

for (const value of ['=1+1', '+SUM(1,2)', '-1+2', '@SUM(1)', '  =1', '\ufeff=1',
    '\t=1', '\r=1', '\n=1', '\u0000=1', '\t文字']) {
    test('CSV defuses formula or initial control: ' + JSON.stringify(value), () => {
        assert.equal(security.csvCell(value), '"\'' + value.replace(/"/g, '""') + '"');
    });
}

test('CSV preserves ordinary text and escapes row/column delimiters', () => {
    assert.equal(security.csvCell('娃头,"要求"\n下一行'), '"娃头,""要求""\n下一行"');
    assert.equal(security.csvCell(190), '"190"');
    assert.equal(security.csvCell(null), '""');
    assert.equal(security.csvDocument(['列'], [['=1']]), '\ufeff"列"\r\n"\'=1"');
});

for (const value of ['javascript:alert(1)', 'https://attacker.invalid/a.jpg',
    'data:image/svg+xml;base64,PHN2Zz4=', 'data:text/html;base64,PGltZz4=',
    'data:image/png;base64,AA==" onerror="attack()', null, {}]) {
    test('Image preview rejects active or untrusted sources: ' + JSON.stringify(value), () => {
        assert.equal(security.safePreviewDataURL(value), null);
    });
}

test('Local image previews allow expected raster data', () => {
    assert.equal(security.safePreviewDataURL('data:image/png;base64,AA=='), 'data:image/png;base64,AA==');
});

const entry = '11111111-1111-4111-8111-111111111111';
const prefix = 'entries/' + entry + '/22222222-2222-4222-8222-222222222222/';
const ticket = () => ({ bucket: 'reference-images', slots: Array.from({ length: 6 }, (_, i) => prefix + (i + 1)) });

test('Fixed upload slots are returned unchanged, without extensions or local filenames', () => {
    const original = ticket();
    assert.deepEqual(security.uploadSlots(original, entry), original.slots);
    assert.ok(Object.isFrozen(security.uploadSlots(original, entry)));
});

for (const kind of ['duplicate', 'out-of-range', 'wrong-entry', 'different-secret', 'subdirectory', 'extension', 'wrong-bucket', 'legacy-prefix']) {
    test('Fixed upload slots reject ' + kind, () => {
        const value = ticket();
        if (kind === 'duplicate') value.slots[1] = value.slots[0];
        if (kind === 'out-of-range') value.slots[5] = prefix + '7';
        if (kind === 'wrong-entry') value.slots[0] = value.slots[0].replace(entry, '33333333-3333-4333-8333-333333333333');
        if (kind === 'different-secret') value.slots[2] = value.slots[2].replace('22222222', '44444444');
        if (kind === 'subdirectory') value.slots[2] += '/nested';
        if (kind === 'extension') value.slots[2] += '.jpg';
        if (kind === 'wrong-bucket') value.bucket = 'public';
        if (kind === 'legacy-prefix') { delete value.slots; value.prefix = prefix; }
        assert.throws(() => security.uploadSlots(value, entry));
    });
}
