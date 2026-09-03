/**
 * Self-asserting node tests for the GI-free free-tile fill planner and
 * the auto-fill suppression guard. No framework: plain node:assert.
 *
 * Run with:
 *   npx esbuild tests/freeTileFillPlanner.test.ts --bundle \
 *     --platform=node --format=cjs --outfile=/tmp/freeTileFillPlanner.test.cjs
 *   node /tmp/freeTileFillPlanner.test.cjs
 */

import { deepEqual, equal, ok, throws } from 'node:assert/strict';
import {
    computeFreeTiles,
    isSeatedOnSingleTile,
    matchWindowToTile,
    planCompaction,
    planFillCascade,
    rectMostlyInsideTile,
    sortTilesInReadingOrder,
    type RectLike,
    type TileLike,
    type WorkspaceSnapshot,
} from '../src/components/tilingsystem/freeTileFillPlanner';
import {
    isAutoFillSuppressed,
    withAutoFillSuppressed,
} from '../src/components/tilingsystem/autoFillSuppression';

const rect = (
    x: number,
    y: number,
    width: number,
    height: number
): RectLike => ({ x, y, width, height });

// 2x2 grid in reading order: TL, TR, BL, BR
const grid2x2: TileLike[] = [
    rect(0, 0, 0.5, 0.5),
    rect(0.5, 0, 0.5, 0.5),
    rect(0, 0.5, 0.5, 0.5),
    rect(0.5, 0.5, 0.5, 0.5),
];

// single row of three full-height tiles
const row3: TileLike[] = [
    rect(0, 0, 1 / 3, 1),
    rect(1 / 3, 0, 1 / 3, 1),
    rect(2 / 3, 0, 1 / 3, 1),
];

// two half-width tiles
const pair: TileLike[] = [rect(0, 0, 0.5, 1), rect(0.5, 0, 0.5, 1)];

function snapshotOf(perWs: Record<number, WorkspaceSnapshot>) {
    return (wsIndex: number): WorkspaceSnapshot | null =>
        perWs[wsIndex] ?? null;
}

const scenarios: [string, () => void][] = [
    [
        '1. reading order: 2x2 grid, 3-row layout, stability, no input mutation, matchWindowToTile',
        () => {
            const scrambled = [grid2x2[3], grid2x2[0], grid2x2[2], grid2x2[1]];
            deepEqual(sortTilesInReadingOrder(scrambled), grid2x2);
            ok(scrambled[0] === grid2x2[3] && scrambled[1] === grid2x2[0]);

            const threeRows: TileLike[] = [
                rect(0, 2 / 3, 0.5, 1 / 3),
                rect(0, 0, 0.5, 1 / 3),
                rect(0, 1 / 3, 1, 1 / 3),
                rect(0.5, 0, 0.5, 1 / 3),
                rect(0.5, 2 / 3, 0.5, 1 / 3),
            ];
            deepEqual(sortTilesInReadingOrder(threeRows), [
                rect(0, 0, 0.5, 1 / 3),
                rect(0.5, 0, 0.5, 1 / 3),
                rect(0, 1 / 3, 1, 1 / 3),
                rect(0, 2 / 3, 0.5, 1 / 3),
                rect(0.5, 2 / 3, 0.5, 1 / 3),
            ]);

            // stability: identical tiles keep their input order
            const first = rect(0.25, 0.25, 0.5, 0.5);
            const second = rect(0.25, 0.25, 0.5, 0.5);
            const sortedPair = sortTilesInReadingOrder([second, first]);
            ok(sortedPair[0] === second && sortedPair[1] === first);

            equal(matchWindowToTile(rect(0.5, 0, 0.5, 0.5), grid2x2), 1);
            // equal intersections resolve to the reading-order-first tile
            equal(matchWindowToTile(rect(0.25, 0.25, 0.5, 0.5), grid2x2), 0);
            equal(matchWindowToTile(rect(2, 2, 0.1, 0.1), grid2x2), -1);
        },
    ],
    [
        '2. compaction: closes a middle gap; spanned rect is excluded from movers AND blocks its tiles',
        () => {
            deepEqual(planCompaction(row3, [row3[0], row3[2]]), [
                { windowIndex: 1, fromTileIndex: 2, toTileIndex: 1 },
            ]);
            deepEqual(computeFreeTiles(row3, [row3[0]]), [1, 2]);

            // spans the whole top row: 50% in TL and 50% in TR
            const spanned = rect(0, 0, 1, 0.5);
            equal(isSeatedOnSingleTile(spanned, grid2x2), false);
            equal(isSeatedOnSingleTile(grid2x2[2], grid2x2), true);
            // the spanned window neither moves nor frees its tiles, so
            // the BL window has nothing to compact into
            deepEqual(planCompaction(grid2x2, [spanned, grid2x2[2]]), []);
            deepEqual(computeFreeTiles(grid2x2, [spanned, grid2x2[2]]), [3]);
        },
    ],
    [
        '3. cascade: ws1<-ws2<-ws3 frontmost selection and fill order, stops when rightmost ws is empty',
        () => {
            const cascade = planFillCascade(
                snapshotOf({
                    0: {
                        tiles: pair,
                        windowRects: [pair[0]],
                        movableWindowIndexes: [0],
                    },
                    1: {
                        tiles: pair,
                        windowRects: [pair[0], pair[1]],
                        movableWindowIndexes: [0, 1],
                    },
                    2: {
                        tiles: pair,
                        windowRects: [pair[0]],
                        movableWindowIndexes: [0],
                    },
                })
            );
            deepEqual(cascade, [
                {
                    kind: 'pull',
                    fromWs: 1,
                    windowIndex: 0,
                    toWs: 0,
                    tileIndex: 1,
                    fromTileIndex: 0,
                },
                {
                    kind: 'compact',
                    fromWs: 1,
                    toWs: 1,
                    windowIndex: 1,
                    fromTileIndex: 1,
                    tileIndex: 0,
                },
                {
                    kind: 'pull',
                    fromWs: 2,
                    windowIndex: 0,
                    toWs: 1,
                    tileIndex: 1,
                    fromTileIndex: 0,
                },
            ]);

            // compaction on the trigger ws frees a tile the fill pass
            // then fills from the next workspace
            deepEqual(
                planFillCascade(
                    snapshotOf({
                        0: {
                            tiles: row3,
                            windowRects: [row3[0], row3[2]],
                            movableWindowIndexes: [0, 1],
                        },
                        1: {
                            tiles: pair,
                            windowRects: [pair[0]],
                            movableWindowIndexes: [0],
                        },
                    })
                ),
                [
                    {
                        kind: 'compact',
                        fromWs: 0,
                        toWs: 0,
                        windowIndex: 1,
                        fromTileIndex: 2,
                        tileIndex: 1,
                    },
                    {
                        kind: 'pull',
                        fromWs: 1,
                        windowIndex: 0,
                        toWs: 0,
                        tileIndex: 2,
                        fromTileIndex: 0,
                    },
                ]
            );
        },
    ],
    [
        '4. no right candidates: compaction-only plan',
        () => {
            deepEqual(
                planFillCascade(
                    snapshotOf({
                        0: {
                            tiles: row3,
                            windowRects: [row3[0], row3[2]],
                            movableWindowIndexes: [0, 1],
                        },
                    })
                ),
                [
                    {
                        kind: 'compact',
                        fromWs: 0,
                        toWs: 0,
                        windowIndex: 1,
                        fromTileIndex: 2,
                        tileIndex: 1,
                    },
                ]
            );
        },
    ],
    [
        '5. full workspaces: empty plan',
        () => {
            deepEqual(
                planFillCascade(
                    snapshotOf({
                        0: {
                            tiles: pair,
                            windowRects: [pair[0], pair[1]],
                            movableWindowIndexes: [0, 1],
                        },
                    })
                ),
                []
            );
            // a movable window exists to the right, but the trigger ws
            // is full: nothing to pull
            deepEqual(
                planFillCascade(
                    snapshotOf({
                        0: {
                            tiles: pair,
                            windowRects: [pair[0], pair[1]],
                            movableWindowIndexes: [0, 1],
                        },
                        1: {
                            tiles: pair,
                            windowRects: [pair[0], pair[1]],
                            movableWindowIndexes: [0, 1],
                        },
                    })
                ),
                []
            );
        },
    ],
    [
        '6. two free tiles filled in reading order from two pulled windows',
        () => {
            deepEqual(
                planFillCascade(
                    snapshotOf({
                        0: {
                            tiles: row3,
                            windowRects: [row3[0]],
                            movableWindowIndexes: [0],
                        },
                        1: {
                            tiles: row3,
                            windowRects: [row3[1], row3[2]],
                            movableWindowIndexes: [0, 1],
                        },
                    })
                ),
                [
                    {
                        kind: 'pull',
                        fromWs: 1,
                        windowIndex: 0,
                        toWs: 0,
                        tileIndex: 1,
                        fromTileIndex: 1,
                    },
                    {
                        kind: 'pull',
                        fromWs: 1,
                        windowIndex: 1,
                        toWs: 0,
                        tileIndex: 2,
                        fromTileIndex: 2,
                    },
                ]
            );
        },
    ],
    [
        '7. suppression guard: nesting and try/finally release',
        () => {
            equal(isAutoFillSuppressed(), false);
            withAutoFillSuppressed(() => {
                equal(isAutoFillSuppressed(), true);
                withAutoFillSuppressed(() => {
                    equal(isAutoFillSuppressed(), true);
                });
                equal(isAutoFillSuppressed(), true);
            });
            equal(isAutoFillSuppressed(), false);
            throws(() =>
                withAutoFillSuppressed(() => {
                    throw new Error('boom');
                })
            );
            equal(isAutoFillSuppressed(), false);
        },
    ],
    [
        '8. rectMostlyInsideTile truth table',
        () => {
            const windowRect = rect(0, 0, 1, 1);
            equal(rectMostlyInsideTile(windowRect, rect(0, 0, 1, 1)), true);
            equal(rectMostlyInsideTile(windowRect, rect(0, 0, 1, 0.55)), true);
            equal(rectMostlyInsideTile(windowRect, rect(0, 0, 1, 0.3)), false);
            equal(rectMostlyInsideTile(windowRect, rect(2, 2, 1, 1)), false);
        },
    ],
    [
        '9. spanned window on a right ws is never a pull candidate',
        () => {
            deepEqual(
                planFillCascade(
                    snapshotOf({
                        0: {
                            tiles: pair,
                            windowRects: [pair[0]],
                            movableWindowIndexes: [0],
                        },
                        1: {
                            tiles: grid2x2,
                            windowRects: [rect(0, 0, 1, 0.5), grid2x2[2]],
                            movableWindowIndexes: [1],
                        },
                    })
                ),
                [
                    {
                        kind: 'pull',
                        fromWs: 1,
                        windowIndex: 1,
                        toWs: 0,
                        tileIndex: 1,
                        fromTileIndex: 2,
                    },
                ]
            );
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
