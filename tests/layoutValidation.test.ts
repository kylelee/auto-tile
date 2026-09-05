/**
 * Self-asserting node tests for the pure crash-class validator of imported
 * layout JSON. No framework: plain node:assert.
 *
 * The validator module is GI-free by construction (its only import of Layout
 * is type-only, which esbuild erases), so Tile.ts / gi:// never enter this
 * plain-node bundle. See tests/layoutAndLogger.test.ts for the precedent.
 *
 * Run with:
 *   npx esbuild tests/layoutValidation.test.ts --bundle \
 *     --platform=node --format=cjs --outfile=/tmp/t3-layout.cjs
 *   node /tmp/t3-layout.cjs
 */

import { deepEqual, equal, strictEqual } from 'node:assert/strict';
import { validateLayouts } from '../src/components/layout/layoutValidation';

const tile = (
    overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
    x: 0,
    y: 0,
    width: 0.5,
    height: 1,
    groups: [],
    ...overrides,
});

const layout = (id: string, tiles: unknown[]): Record<string, unknown> => ({
    id,
    tiles,
});

const scenarios: [string, () => void][] = [
    [
        '1. valid layouts pass through with reference identity (no range checks)',
        () => {
            const input = [
                layout('a', [tile(), tile({ x: 0.5, groups: [1, 2] })]),
                // finite but out-of-[0,1] geometry is NOT this validator's concern
                layout('b', [tile({ x: -0.5, y: 1.5, width: 2, height: 3 })]),
            ];
            const result = validateLayouts(input);
            equal(result.length, 2);
            strictEqual(result[0], input[0]);
            strictEqual(result[1], input[1]);
            strictEqual(result[0].tiles, input[0].tiles);
        },
    ],
    [
        '2. non-array top-level input yields []',
        () => {
            for (const bad of [null, undefined, 42, '[]', {}, { id: 'x' }]) {
                deepEqual(validateLayouts(bad), []);
            }
        },
    ],
    [
        '3. empty array yields []',
        () => {
            deepEqual(validateLayouts([]), []);
        },
    ],
    [
        '4. layout with non-string id is dropped',
        () => {
            for (const badId of [undefined, null, 42, { id: 1 }]) {
                deepEqual(
                    validateLayouts([{ id: badId, tiles: [tile()] }]),
                    []
                );
            }
        },
    ],
    [
        '5. layout with non-array tiles is dropped',
        () => {
            for (const badTiles of [undefined, null, 'tile', { 0: tile() }]) {
                deepEqual(validateLayouts([{ id: 'a', tiles: badTiles }]), []);
            }
        },
    ],
    [
        '6. layout with empty tiles array is dropped',
        () => {
            deepEqual(validateLayouts([{ id: 'a', tiles: [] }]), []);
        },
    ],
    [
        '7. tile with NaN x drops the whole layout',
        () => {
            deepEqual(
                validateLayouts([layout('a', [tile(), tile({ x: NaN })])]),
                []
            );
        },
    ],
    [
        '8. tile with Infinity width drops the whole layout',
        () => {
            deepEqual(
                validateLayouts([layout('a', [tile({ width: Infinity })])]),
                []
            );
        },
    ],
    [
        '9. tile with string height drops the whole layout',
        () => {
            deepEqual(
                validateLayouts([layout('a', [tile({ height: '1' })])]),
                []
            );
        },
    ],
    [
        '10. tile with undefined or missing y drops the whole layout',
        () => {
            deepEqual(
                validateLayouts([layout('a', [tile({ y: undefined })])]),
                []
            );
            deepEqual(
                validateLayouts([
                    layout('a', [{ x: 0, width: 0.5, height: 1, groups: [] }]),
                ]),
                []
            );
        },
    ],
    [
        '11. groups that is not an array of integers drops the whole layout',
        () => {
            for (const badGroups of ['1', 1, [1.5], [1, 'a'], [null]]) {
                deepEqual(
                    validateLayouts([
                        layout('a', [tile({ groups: badGroups })]),
                    ]),
                    []
                );
            }
        },
    ],
    [
        '12. tile missing groups is dropped (Tile.ts declares groups: number[] as required)',
        () => {
            deepEqual(
                validateLayouts([
                    layout('a', [{ x: 0, y: 0, width: 0.5, height: 1 }]),
                ]),
                []
            );
        },
    ],
    [
        '13. mixed input keeps only the valid layouts, by reference',
        () => {
            const validA = layout('a', [tile()]);
            const validB = layout('b', [tile(), tile({ groups: [2] })]);
            const result = validateLayouts([
                validA,
                layout('nan', [tile({ x: NaN })]),
                validB,
                { tiles: [tile()] }, // missing id
                'not-a-layout',
            ]);
            equal(result.length, 2);
            strictEqual(result[0], validA);
            strictEqual(result[1], validB);
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
