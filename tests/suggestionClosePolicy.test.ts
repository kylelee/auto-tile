/**
 * Self-asserting node tests for the GI-free windows-suggestions close
 * policy. No framework: plain node:assert.
 *
 * Run with:
 *   npx esbuild tests/suggestionClosePolicy.test.ts --bundle \
 *     --platform=node --format=cjs --outfile=/tmp/suggestionClosePolicy.test.cjs
 *   node /tmp/suggestionClosePolicy.test.cjs
 */

import { equal } from 'node:assert/strict';
import {
    shouldActivateOnClose,
    type SuggestionCloseTrigger,
} from '../src/components/windowsSuggestions/closePolicy';

const activates = (
    trigger: SuggestionCloseTrigger,
    pickedByUser: boolean
): boolean => shouldActivateOnClose(trigger, pickedByUser);

const scenarios: [string, () => void][] = [
    [
        'a suggestion picked by the user activates the picked window on close',
        () => {
            equal(activates('suggestion-picked', false), true);
        },
    ],
    [
        'auto-close for lack of suggestions still activates the last tiled window',
        () => {
            equal(activates('no-suggestions', false), true);
        },
    ],
    [
        'escape after a pick is an explicit completion and activates',
        () => {
            equal(activates('escape', true), true);
        },
    ],
    [
        'escape without a pick does not activate',
        () => {
            equal(activates('escape', false), false);
        },
    ],
    [
        'key-focus-out never activates (no pick)',
        () => {
            equal(activates('key-focus-out', false), false);
        },
    ],
    [
        'key-focus-out never activates (even after a pick)',
        () => {
            equal(activates('key-focus-out', true), false);
        },
    ],
    [
        'background release never activates (no pick)',
        () => {
            equal(activates('background-release', false), false);
        },
    ],
    [
        'background release never activates (even after a pick)',
        () => {
            equal(activates('background-release', true), false);
        },
    ],
    [
        'touch end never activates (even after a pick)',
        () => {
            equal(activates('touch-end', true), false);
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
