/**
 * Self-asserting node tests for the GI-free GNU .mo catalog reader, the
 * Plural-Forms expression compiler and the Chinese locale aliasing.
 * No framework: plain node:assert.
 *
 * Run with:
 *   npx esbuild tests/moCatalog.test.ts --bundle \
 *     --platform=node --format=cjs --outfile=/tmp/moCatalog.test.cjs
 *   node /tmp/moCatalog.test.cjs
 */

import { deepEqual, equal, ok } from 'node:assert/strict';
import {
    chineseCatalogFor,
    compilePluralExpression,
    MoCatalog,
} from '../src/utils/moCatalog';

// ---------------------------------------------------------------------------
// minimal GNU .mo writer (little-endian, revision 0), enough to feed
// fromBytes with both valid and corrupt inputs
// ---------------------------------------------------------------------------

const MO_MAGIC = 0x950412de;

function buildMo(entries: [string, string][]): Uint8Array {
    const enc = new TextEncoder();
    const count = entries.length;
    const tablesEnd = 28 + count * 16;
    const blobs = entries.map(([o, t]) => ({
        o: enc.encode(o),
        t: enc.encode(t),
    }));
    const total =
        tablesEnd + blobs.reduce((s, b) => s + b.o.length + b.t.length, 0);
    const buf = new ArrayBuffer(total);
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);

    view.setUint32(0, MO_MAGIC, true);
    view.setUint32(4, 0, true); // revision
    view.setUint32(8, count, true);
    view.setUint32(12, 28, true); // originals table offset
    view.setUint32(16, 28 + count * 8, true); // translations table offset
    view.setUint32(20, 0, true); // hash size
    view.setUint32(24, 0, true); // hash offset

    let cursor = tablesEnd;
    blobs.forEach((b, i) => {
        view.setUint32(28 + i * 8, b.o.length, true);
        view.setUint32(28 + i * 8 + 4, cursor, true);
        bytes.set(b.o, cursor);
        cursor += b.o.length;
    });
    blobs.forEach((b, i) => {
        view.setUint32(28 + count * 8 + i * 8, b.t.length, true);
        view.setUint32(28 + count * 8 + i * 8 + 4, cursor, true);
        bytes.set(b.t, cursor);
        cursor += b.t.length;
    });
    return bytes;
}

const SLAVIC_HEADER =
    'Project-Id-Version: autotile\n' +
    'Plural-Forms: nplurals=3; plural=(n%10==1 && n%100!=11) ? 0 : ' +
    '(n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20)) ? 1 : 2;\n';

function slavicCatalog(): MoCatalog {
    const catalog = MoCatalog.fromBytes(
        buildMo([
            ['', SLAVIC_HEADER],
            ['hello', 'world'],
            ['menu\u0004layout', 'menu layout translation'], // context via EOT
            ['one\u0000many', 'form0\u0000form1\u0000form2'],
        ])
    );
    if (!catalog) throw new Error('slavic catalog failed to parse');
    return catalog;
}

const scenarios: [string, () => void][] = [
    [
        '1. chineseCatalogFor: region codes map to the script-based catalog names, everything else is null',
        () => {
            equal(chineseCatalogFor('zh'), 'zh_Simplified');
            equal(chineseCatalogFor('zh_CN'), 'zh_Simplified');
            equal(chineseCatalogFor('zh_SG'), 'zh_Simplified');
            equal(chineseCatalogFor('zh_TW'), 'zh_Traditional');
            equal(chineseCatalogFor('zh_HK'), 'zh_Traditional');
            // charset ('zh_CN.utf-8') and modifier ('zh_TW@big5') parts stripped
            equal(chineseCatalogFor('zh_CN.utf-8'), 'zh_Simplified');
            equal(chineseCatalogFor('zh_TW@big5'), 'zh_Traditional');
            equal(chineseCatalogFor('en_US'), null);
            equal(chineseCatalogFor('ja'), null);
            equal(chineseCatalogFor(''), null);
        },
    ],
    [
        '2. fromBytes: rejects short buffers, wrong magic, zero entries and out-of-bounds tables',
        () => {
            equal(MoCatalog.fromBytes(new Uint8Array(20)), null);
            const notMo = buildMo([['a', 'b']]);
            notMo[0] = 0; // break the magic
            equal(MoCatalog.fromBytes(notMo), null);

            const zeroEntries = new Uint8Array(28);
            new DataView(zeroEntries.buffer).setUint32(0, MO_MAGIC, true);
            equal(MoCatalog.fromBytes(zeroEntries), null);

            const hugeCount = buildMo([['a', 'b']]);
            new DataView(hugeCount.buffer).setUint32(8, 0x00ffffff, true);
            equal(MoCatalog.fromBytes(hugeCount), null);
        },
    ],
    [
        '3. gettext: plain lookup, embedded NUL keeps only the first form, missing entries are null',
        () => {
            const catalog = slavicCatalog();
            equal(catalog.gettext('hello'), 'world');
            equal(catalog.gettext('one\u0000many'), 'form0');
            equal(catalog.gettext('missing'), null);
            // the empty msgid IS a stored message: it returns the header
            equal(catalog.gettext(''), SLAVIC_HEADER);
        },
    ],
    [
        '4. pgettext: context+EOT lookup',
        () => {
            const catalog = slavicCatalog();
            equal(
                catalog.pgettext('menu', 'layout'),
                'menu layout translation'
            );
            equal(catalog.pgettext('other', 'layout'), null);
        },
    ],
    [
        '5. ngettext with the Slavic formula: 1→0, 2-4→1, 5+/11/12→2, 21/22 wrap back',
        () => {
            const catalog = slavicCatalog();
            const form = (n: number) =>
                catalog.ngettext('one', 'many', n) ?? 'null';
            equal(form(1), 'form0');
            equal(form(2), 'form1');
            equal(form(4), 'form1');
            equal(form(5), 'form2');
            equal(form(11), 'form2'); // n%100==11 beats n%10==1
            equal(form(12), 'form2'); // n%100 in 10..19 beats 2-4
            equal(form(21), 'form0'); // 21%10==1 and 21%100!=11
            equal(form(22), 'form1');
            equal(form(112), 'form2'); // 112%100=12 blocks form1
        },
    ],
    [
        '6. ngettext fallbacks: no Plural-Forms header and clamping to the available forms',
        () => {
            const noHeader = MoCatalog.fromBytes(
                buildMo([['one\u0000many', 'only\u0000other']])
            );
            if (!noHeader) throw new Error('catalog failed to parse');
            // documented fallback: n==1 → first form, else second form
            equal(noHeader.ngettext('one', 'many', 1), 'only');
            equal(noHeader.ngettext('one', 'many', 5), 'other');
            // single-form entry: the formula index is clamped to 0
            const clamped = MoCatalog.fromBytes(
                buildMo([
                    ['', 'Plural-Forms: nplurals=2; plural=n != 1;\n'],
                    ['one\u0000many', 'onlyform'],
                ])
            );
            if (!clamped) throw new Error('catalog failed to parse');
            equal(clamped.ngettext('one', 'many', 1), 'onlyform');
            equal(clamped.ngettext('one', 'many', 7), 'onlyform');
            // missing entry
            equal(clamped.ngettext('nope', 'nopes', 1), null);
        },
    ],
    [
        '7. compilePluralExpression: precedence, ternaries, C integer division, unary operators',
        () => {
            const german = compilePluralExpression('n != 1');
            if (!german) throw new Error('german formula failed to compile');
            equal(german(1), 0);
            equal(german(0), 1);
            equal(german(2), 1);

            const english = compilePluralExpression('(n > 1)');
            if (!english) throw new Error('english formula failed to compile');
            equal(english(1), 0);
            equal(english(2), 1);

            // C integer division truncates toward zero
            const division = compilePluralExpression('n/2');
            if (!division)
                throw new Error('division formula failed to compile');
            equal(division(1), 0);
            equal(division(3), 1);

            const negated = compilePluralExpression('!(n==1)');
            if (!negated) throw new Error('negation formula failed to compile');
            equal(negated(1), 0);
            equal(negated(4), 1);

            const chained = compilePluralExpression('n%10==1 && n%100!=11');
            if (!chained) throw new Error('chain formula failed to compile');
            equal(chained(1), 1);
            equal(chained(11), 0);
            equal(chained(21), 1);
        },
    ],
    [
        '8. compilePluralExpression: rejects malformed expressions and unknown identifiers',
        () => {
            equal(compilePluralExpression(''), null);
            equal(compilePluralExpression('n +'), null);
            equal(compilePluralExpression('x'), null); // only `n` is defined
            equal(compilePluralExpression('(n'), null); // unbalanced paren
            equal(compilePluralExpression('n 1'), null); // trailing tokens
        },
    ],
];

let passed = 0;
let failed = 0;

for (const [name, run] of scenarios) {
    try {
        run();
        passed++;
        console.log(`ok - ${name}`);
    } catch (err) {
        failed++;
        console.error(`not ok - ${name}`);
        console.error(err);
    }
}

const total = scenarios.length;
if (failed === 0) {
    console.log(`PASS ${passed}/${total}`);
} else {
    console.error(`FAILED ${passed}/${total}`);
    process.exitCode = 1;
}
