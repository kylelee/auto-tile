/**
 * Self-asserting node tests for the GI-free layout data contract and the
 * tagged logger. No framework: plain node:assert.
 *
 * Run with:
 *   npx esbuild tests/layoutAndLogger.test.ts --bundle \
 *     --platform=node --format=cjs --outfile=/tmp/layoutAndLogger.test.cjs
 *   node /tmp/layoutAndLogger.test.cjs
 */

import { equal, ok } from 'node:assert/strict';
import Layout from '../src/components/layout/Layout';
import { logger, rect_to_string } from '../src/utils/logger';

const scenarios: [string, () => void][] = [
    [
        '1. Layout: stores the tile array by reference and the layout id verbatim',
        () => {
            const tiles = [
                { x: 0, y: 0, width: 0.5, height: 1, groups: [] },
                { x: 0.5, y: 0, width: 0.5, height: 1, groups: [1] },
            ];
            const layout = new Layout(tiles, 'my-custom-layout');
            ok(layout.tiles === tiles);
            equal(layout.id, 'my-custom-layout');
            // the empty layout used for transient widgets
            const empty = new Layout([], '');
            equal(empty.tiles.length, 0);
            equal(empty.id, '');
        },
    ],
    [
        '2. rect_to_string: stable {x, y, width, height} rendering for logs',
        () => {
            equal(
                rect_to_string({ x: 1, y: 2, width: 3, height: 4 }),
                '{x: 1, y: 2, width: 3, height: 4}'
            );
        },
    ],
    [
        '3. logger: every line is prefixed with the extension tag and the module tag',
        () => {
            const original = console.log;
            const lines: string[] = [];
            console.log = (...args: unknown[]) => {
                lines.push(args.join(' '));
            };
            try {
                logger('TestModule')('hello', 42);
                logger('Other')();
            } finally {
                console.log = original;
            }
            equal(lines[0], '[autotile] [TestModule] hello 42');
            equal(lines[1], '[autotile] [Other]');
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
