/**
 * Self-asserting node tests for the GI-free clamp util.
 * No framework: plain node:assert.
 *
 * Run with:
 *   npx esbuild tests/clamp.test.ts --bundle \
 *     --platform=node --format=cjs --outfile=/tmp/t2-clamp.cjs
 *   node /tmp/t2-clamp.cjs
 */

import { equal, ok } from 'node:assert/strict';
import { clamp } from '../src/utils/clamp';

const scenarios: [string, () => void][] = [
    [
        '1. n within [min, max] is returned unchanged, including both bounds',
        () => {
            equal(clamp(5, 0, 10), 5);
            equal(clamp(0, 0, 10), 0); // lower bound
            equal(clamp(10, 0, 10), 10); // upper bound
            equal(clamp(-4, -5, -1), -4); // negative range
        },
    ],
    [
        '2. n < min is clamped to min',
        () => {
            equal(clamp(-3, 0, 10), 0);
            equal(clamp(-100, -5, -1), -5);
        },
    ],
    [
        '3. n > max is clamped to max',
        () => {
            equal(clamp(15, 0, 10), 10);
            equal(clamp(0, -5, -1), -1);
        },
    ],
    [
        '4. min > max keeps Math.min(Math.max()) semantics: max wins for every n',
        () => {
            // Math.min(Math.max(n, 5), 1) === 1 for any n
            equal(clamp(2, 5, 1), 1);
            equal(clamp(5, 5, 1), 1);
            equal(clamp(7, 5, 1), 1);
            equal(clamp(-10, 5, 1), 1);
        },
    ],
    [
        '5. NaN input propagates NaN',
        () => {
            ok(Number.isNaN(clamp(NaN, 0, 10)));
            ok(Number.isNaN(clamp(5, NaN, 10)));
            ok(Number.isNaN(clamp(5, 0, NaN)));
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
