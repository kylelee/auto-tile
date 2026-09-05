/**
 * Self-asserting node tests for the GI-free auto-tile candidacy gate
 * (ghost-window immunity). No framework: plain node:assert.
 *
 * Run with:
 *   npx esbuild tests/autoTileCandidate.test.ts --bundle \
 *     --platform=node --format=cjs --outfile=/tmp/t.cjs
 *   node /tmp/t.cjs
 */

import { equal } from 'node:assert/strict';
import {
    AUTO_TILE_WM_CLASS_BLACKLIST,
    shouldAutoTileWindow,
    type AutoTileCandidateInfo,
} from '../src/components/tilingsystem/autoTileCandidate';

// baseline: a perfectly ordinary visible, sized application window.
// "wmClass null" means get_wm_class() returned null — common at
// window-created time.
const candidate = (): AutoTileCandidateInfo => ({
    wmClass: 'com.example.App',
    frameWidth: 800,
    frameHeight: 600,
});

const withOverrides = (
    overrides: Partial<AutoTileCandidateInfo>
): AutoTileCandidateInfo => ({
    ...candidate(),
    ...overrides,
});

const scenarios: [string, () => void][] = [
    [
        '1. ghost at birth: 0x0 frame → not an auto-tile candidate',
        () => {
            equal(
                shouldAutoTileWindow(
                    withOverrides({ frameWidth: 0, frameHeight: 0 })
                ),
                false
            );
        },
    ],
    [
        '2. ghost at first-frame: 1x1 frame → not an auto-tile candidate',
        () => {
            equal(
                shouldAutoTileWindow(
                    withOverrides({ frameWidth: 1, frameHeight: 1 })
                ),
                false
            );
        },
    ],
    [
        '3. 1-pixel-wide frame (1x800) → not an auto-tile candidate',
        () => {
            equal(
                shouldAutoTileWindow(
                    withOverrides({ frameWidth: 1, frameHeight: 800 })
                ),
                false
            );
        },
    ],
    [
        '4. 1-pixel-tall frame (800x1) → not an auto-tile candidate',
        () => {
            equal(
                shouldAutoTileWindow(
                    withOverrides({ frameWidth: 800, frameHeight: 1 })
                ),
                false
            );
        },
    ],
    [
        '5. negative frame width → not an auto-tile candidate',
        () => {
            equal(
                shouldAutoTileWindow(withOverrides({ frameWidth: -4 })),
                false
            );
        },
    ],
    [
        '6. negative frame height → not an auto-tile candidate',
        () => {
            equal(
                shouldAutoTileWindow(withOverrides({ frameHeight: -4 })),
                false
            );
        },
    ],
    [
        '7. smallest real window: 2x2 with a normal wmClass → candidate',
        () => {
            equal(
                shouldAutoTileWindow(
                    withOverrides({ frameWidth: 2, frameHeight: 2 })
                ),
                true
            );
        },
    ],
    [
        '8. acceptance: 1904x1032 tiled window, normal wmClass → candidate',
        () => {
            equal(
                shouldAutoTileWindow(
                    withOverrides({ frameWidth: 1904, frameHeight: 1032 })
                ),
                true
            );
        },
    ],
    [
        '9. blacklisted ghost: wl-clipboard wmClass, full 1920x1080 frame → not a candidate',
        () => {
            equal(
                shouldAutoTileWindow(
                    withOverrides({
                        wmClass: 'io.github.bugaevc.wl-clipboard',
                        frameWidth: 1920,
                        frameHeight: 1080,
                    })
                ),
                false
            );
        },
    ],
    [
        '10. wmClass null with a normal size → candidate (wm_class is null at window-created)',
        () => {
            equal(shouldAutoTileWindow(withOverrides({ wmClass: null })), true);
        },
    ],
    [
        '11. unknown wmClass (anything.else) with a normal size → candidate',
        () => {
            equal(
                shouldAutoTileWindow(
                    withOverrides({ wmClass: 'anything.else' })
                ),
                true
            );
        },
    ],
    [
        '12. wmClass null AND 1x1 → not a candidate (the size dimension wins)',
        () => {
            equal(
                shouldAutoTileWindow(
                    withOverrides({
                        wmClass: null,
                        frameWidth: 1,
                        frameHeight: 1,
                    })
                ),
                false
            );
        },
    ],
    [
        '13. blacklist contains exactly the wl-clipboard ghost',
        () => {
            equal(
                AUTO_TILE_WM_CLASS_BLACKLIST.has(
                    'io.github.bugaevc.wl-clipboard'
                ),
                true
            );
            equal(AUTO_TILE_WM_CLASS_BLACKLIST.size, 1);
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
