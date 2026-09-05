/**
 * Self-asserting node tests for the GI-free focus-border eligibility
 * rule. No framework: plain node:assert.
 *
 * Run with:
 *   npx esbuild tests/borderEligibility.test.ts --bundle \
 *     --platform=node --format=cjs --outfile=/tmp/borderEligibility.test.cjs
 *   node /tmp/borderEligibility.test.cjs
 */

import { equal } from 'node:assert/strict';
import {
    isWindowEligibleForBorder,
    type WindowBorderEligibility,
} from '../src/components/windowBorder/borderEligibility';

// baseline: a perfectly ordinary visible, sized, focused window.
// "wmClass null" means the window exists but get_wm_class() returned
// null — the window-object-null case is a separate early return in the
// GI layer and is NOT this module's contract.
const eligibleWindow = (): WindowBorderEligibility => ({
    wmClass: 'org.gnome.Nautilus',
    windowTypeName: 'NORMAL',
    skipTaskbar: false,
    showingOnItsWorkspace: true,
    frameWidth: 800,
    frameHeight: 600,
});

const withOverrides = (
    overrides: Partial<WindowBorderEligibility>
): WindowBorderEligibility => ({
    ...eligibleWindow(),
    ...overrides,
});

const scenarios: [string, () => void][] = [
    [
        '1. wmClass null (window exists, wm_class unset) → ineligible',
        () => {
            equal(
                isWindowEligibleForBorder(withOverrides({ wmClass: null })),
                false
            );
        },
    ],
    [
        '2. wmClass gjs (shell-owned chrome) → ineligible',
        () => {
            equal(
                isWindowEligibleForBorder(withOverrides({ wmClass: 'gjs' })),
                false
            );
        },
    ],
    [
        '3. window type DOCK → ineligible',
        () => {
            equal(
                isWindowEligibleForBorder(
                    withOverrides({ windowTypeName: 'DOCK' })
                ),
                false
            );
        },
    ],
    [
        '4. window type TOOLTIP → ineligible',
        () => {
            equal(
                isWindowEligibleForBorder(
                    withOverrides({ windowTypeName: 'TOOLTIP' })
                ),
                false
            );
        },
    ],
    [
        '5. eligible window types: NORMAL / DIALOG / MODAL_DIALOG → eligible',
        () => {
            equal(
                isWindowEligibleForBorder(
                    withOverrides({ windowTypeName: 'NORMAL' })
                ),
                true
            );
            equal(
                isWindowEligibleForBorder(
                    withOverrides({ windowTypeName: 'DIALOG' })
                ),
                true
            );
            equal(
                isWindowEligibleForBorder(
                    withOverrides({ windowTypeName: 'MODAL_DIALOG' })
                ),
                true
            );
        },
    ],
    [
        '6. skipTaskbar → ineligible',
        () => {
            equal(
                isWindowEligibleForBorder(withOverrides({ skipTaskbar: true })),
                false
            );
        },
    ],
    [
        '7. not showing on its workspace (hidden / minimized / other ws) → ineligible',
        () => {
            equal(
                isWindowEligibleForBorder(
                    withOverrides({ showingOnItsWorkspace: false })
                ),
                false
            );
        },
    ],
    [
        '8. frame below 2px: width 0/1 or height 0/1 → ineligible; 2x2 → eligible',
        () => {
            equal(
                isWindowEligibleForBorder(withOverrides({ frameWidth: 0 })),
                false
            );
            equal(
                isWindowEligibleForBorder(withOverrides({ frameHeight: 0 })),
                false
            );
            equal(
                isWindowEligibleForBorder(withOverrides({ frameWidth: 1 })),
                false
            );
            equal(
                isWindowEligibleForBorder(withOverrides({ frameHeight: 1 })),
                false
            );
            equal(
                isWindowEligibleForBorder(
                    withOverrides({ frameWidth: 2, frameHeight: 2 })
                ),
                true
            );
        },
    ],
    [
        '9. acceptance: valid NORMAL window, non-zero size, visible → eligible',
        () => {
            equal(isWindowEligibleForBorder(eligibleWindow()), true);
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
