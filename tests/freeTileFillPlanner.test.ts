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
    [
        '10. multi-monitor same-ws compaction: a free tile on one monitor is filled from another monitor (both directions, global pixel rects)',
        () => {
            // two side-by-side 1000x1000 monitors, each with a top and a
            // bottom half tile. Global reading order (rows first, then
            // left-to-right): L-top=0, R-top=1, L-bottom=2, R-bottom=3
            const sideBySide: TileLike[] = [
                rect(0, 0, 1000, 500), // L-top
                rect(1000, 0, 1000, 500), // R-top
                rect(0, 500, 1000, 500), // L-bottom
                rect(1000, 500, 1000, 500), // R-bottom
            ];

            // right-monitor window fills the free LEFT-monitor tile
            // (L-top free; R-top and L-bottom blocked; R-bottom movable)
            deepEqual(
                planFillCascade(
                    snapshotOf({
                        0: {
                            tiles: sideBySide,
                            windowRects: [
                                sideBySide[2],
                                sideBySide[1],
                                sideBySide[3],
                            ],
                            movableWindowIndexes: [2],
                        },
                    })
                ),
                [
                    {
                        kind: 'compact',
                        fromWs: 0,
                        toWs: 0,
                        windowIndex: 2,
                        fromTileIndex: 3,
                        tileIndex: 0,
                    },
                ]
            );

            // mirror: left-monitor window fills the free RIGHT-monitor tile
            // (R-top free, earlier in reading order; L-top and R-bottom
            // blocked; L-bottom movable)
            deepEqual(
                planFillCascade(
                    snapshotOf({
                        0: {
                            tiles: sideBySide,
                            windowRects: [
                                sideBySide[0],
                                sideBySide[3],
                                sideBySide[2],
                            ],
                            movableWindowIndexes: [2],
                        },
                    })
                ),
                [
                    {
                        kind: 'compact',
                        fromWs: 0,
                        toWs: 0,
                        windowIndex: 2,
                        fromTileIndex: 2,
                        tileIndex: 1,
                    },
                ]
            );
        },
    ],
    [
        '11. multi-monitor cross-ws pull: a window tiled on the TOP monitor of a right workspace fills the free tile on the BOTTOM monitor of the trigger workspace',
        () => {
            // two stacked 1000x1000 monitors, each with a top and a bottom
            // half tile. Global reading order: T-top=0, T-bottom=1,
            // B-top=2, B-bottom=3
            const stacked: TileLike[] = [
                rect(0, 0, 1000, 500), // T-top
                rect(0, 500, 1000, 500), // T-bottom
                rect(0, 1000, 1000, 500), // B-top
                rect(0, 1500, 1000, 500), // B-bottom
            ];

            // trigger ws: every tile occupied except the bottom monitor's
            // lower tile; the occupants are not movable
            // right ws: a single movable window on the top monitor
            deepEqual(
                planFillCascade(
                    snapshotOf({
                        0: {
                            tiles: stacked,
                            windowRects: [stacked[0], stacked[1], stacked[2]],
                            movableWindowIndexes: [],
                        },
                        1: {
                            tiles: stacked,
                            windowRects: [stacked[0]],
                            movableWindowIndexes: [0],
                        },
                    })
                ),
                [
                    {
                        kind: 'pull',
                        fromWs: 1,
                        windowIndex: 0,
                        toWs: 0,
                        tileIndex: 3,
                        fromTileIndex: 0,
                    },
                ]
            );
        },
    ],
    [
        '12. acceptance: close on the trigger ws compacts the survivor and pulls every right workspace one step forward',
        () => {
            // workspace 1 had two windows, one of them is closed: the
            // survivor compacts onto the freed tile, workspace 2's window
            // is pulled into the tile the survivor left behind and
            // workspace 3's window follows into the gap workspace 2 left
            // — everything converges on the trigger workspace, so the
            // window nearest the closed one's spot is a local successor
            deepEqual(
                planFillCascade(
                    snapshotOf({
                        0: {
                            tiles: pair,
                            windowRects: [pair[1]],
                            movableWindowIndexes: [0],
                        },
                        1: {
                            tiles: pair,
                            windowRects: [pair[0]],
                            movableWindowIndexes: [0],
                        },
                        2: {
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
                        windowIndex: 0,
                        fromTileIndex: 1,
                        tileIndex: 0,
                    },
                    {
                        kind: 'pull',
                        fromWs: 1,
                        windowIndex: 0,
                        toWs: 0,
                        tileIndex: 1,
                        fromTileIndex: 0,
                    },
                    {
                        kind: 'pull',
                        fromWs: 2,
                        windowIndex: 0,
                        toWs: 1,
                        tileIndex: 0,
                        fromTileIndex: 0,
                    },
                ]
            );
        },
    ],
    [
        '13. floating ranked after tiled candidates (regression)',
        () => {
            // ws1 has a tiled candidate AND a floating one: only the
            // tiled window is pulled, the floating window stays put
            deepEqual(
                planFillCascade(
                    snapshotOf({
                        0: {
                            tiles: pair,
                            windowRects: [pair[0]],
                            movableWindowIndexes: [0],
                        },
                        1: {
                            tiles: pair,
                            windowRects: [pair[1], rect(2, 2, 0.1, 0.1)],
                            movableWindowIndexes: [0],
                            floatingWindowIndexes: [1],
                        },
                    })
                ),
                [
                    {
                        kind: 'pull',
                        fromWs: 1,
                        toWs: 0,
                        windowIndex: 0,
                        fromTileIndex: 1,
                        tileIndex: 1,
                    },
                ]
            );
        },
    ],
    [
        '14. tiled candidates exhausted: pull floating, fromTileIndex=-1',
        () => {
            // floatingA is outside the grid (matchWindowToTile -1),
            // floatingB is stacked exactly on pair[1] (match >= 0):
            // classification is by floatingWindowIndexes membership
            // only, so floatingA fills slot1 and floatingB stays (no
            // vacancy left)
            const floatingA = rect(2, 2, 0.1, 0.1);
            const floatingB = rect(0.5, 0, 0.5, 1);
            deepEqual(
                planFillCascade(
                    snapshotOf({
                        0: {
                            tiles: row3,
                            windowRects: [row3[0]],
                            movableWindowIndexes: [0],
                        },
                        1: {
                            tiles: pair,
                            windowRects: [pair[0], floatingA, floatingB],
                            movableWindowIndexes: [0],
                            floatingWindowIndexes: [1, 2],
                        },
                    })
                ),
                [
                    {
                        kind: 'pull',
                        fromWs: 1,
                        toWs: 0,
                        windowIndex: 0,
                        fromTileIndex: 0,
                        tileIndex: 1,
                    },
                    {
                        kind: 'pull',
                        fromWs: 1,
                        toWs: 0,
                        windowIndex: 1,
                        fromTileIndex: -1,
                        tileIndex: 2,
                    },
                ]
            );
        },
    ],
    [
        '15. floating does not block the source workspace compaction seats or fill tiles',
        () => {
            // the floating rect is stacked exactly on row3[0]: if it
            // wrongly blocked (not merged into the gone view), tile0
            // would be occupied, compaction would become 2->1 and the
            // ws2 pull would land on tile2 instead
            deepEqual(
                planFillCascade(
                    snapshotOf({
                        0: {
                            tiles: pair,
                            windowRects: [pair[0], pair[1]],
                            movableWindowIndexes: [0, 1],
                        },
                        1: {
                            tiles: row3,
                            windowRects: [row3[2], rect(0, 0, 1 / 3, 1)],
                            movableWindowIndexes: [0],
                            floatingWindowIndexes: [1],
                        },
                        2: {
                            tiles: pair,
                            windowRects: [pair[0]],
                            movableWindowIndexes: [0],
                        },
                    })
                ),
                [
                    {
                        kind: 'compact',
                        fromWs: 1,
                        toWs: 1,
                        windowIndex: 0,
                        fromTileIndex: 2,
                        tileIndex: 0,
                    },
                    {
                        kind: 'pull',
                        fromWs: 2,
                        toWs: 1,
                        windowIndex: 0,
                        fromTileIndex: 0,
                        tileIndex: 1,
                    },
                ]
            );
        },
    ],
    [
        '16. consumed floating window is not re-pulled',
        () => {
            // two vacancies but a single floating candidate: the
            // pulled floating is consumed, so tile2 stays free
            deepEqual(
                planFillCascade(
                    snapshotOf({
                        0: {
                            tiles: row3,
                            windowRects: [row3[0]],
                            movableWindowIndexes: [0],
                        },
                        1: {
                            tiles: pair,
                            windowRects: [rect(2, 2, 0.1, 0.1)],
                            movableWindowIndexes: [],
                            floatingWindowIndexes: [0],
                        },
                    })
                ),
                [
                    {
                        kind: 'pull',
                        fromWs: 1,
                        toWs: 0,
                        windowIndex: 0,
                        fromTileIndex: -1,
                        tileIndex: 1,
                    },
                ]
            );
        },
    ],
    [
        '17. sustained closes (two cascade rounds): tiled refills first, then floating lands on the freed tile',
        () => {
            // round 1: ws1 still has a tiled window - it refills the
            // freed tile before any floating candidate
            deepEqual(
                planFillCascade(
                    snapshotOf({
                        0: {
                            tiles: row3,
                            windowRects: [row3[0], row3[1]],
                            movableWindowIndexes: [0, 1],
                        },
                        1: {
                            tiles: pair,
                            windowRects: [pair[0], rect(2, 2, 0.1, 0.1)],
                            movableWindowIndexes: [0],
                            floatingWindowIndexes: [1],
                        },
                    })
                ),
                [
                    {
                        kind: 'pull',
                        fromWs: 1,
                        toWs: 0,
                        windowIndex: 0,
                        fromTileIndex: 0,
                        tileIndex: 2,
                    },
                ]
            );
            // round 2: fresh snapshot - the tiled window was pulled
            // away in round 1 and the tile2 window on ws0 got closed;
            // only the floating window is left to refill ws0
            deepEqual(
                planFillCascade(
                    snapshotOf({
                        0: {
                            tiles: row3,
                            windowRects: [row3[0], row3[1]],
                            movableWindowIndexes: [0, 1],
                        },
                        1: {
                            tiles: pair,
                            windowRects: [rect(2, 2, 0.1, 0.1)],
                            movableWindowIndexes: [],
                            floatingWindowIndexes: [0],
                        },
                    })
                ),
                [
                    {
                        kind: 'pull',
                        fromWs: 1,
                        toWs: 0,
                        windowIndex: 0,
                        fromTileIndex: -1,
                        tileIndex: 2,
                    },
                ]
            );
        },
    ],
    [
        '18. cross-ws ordering: near-ws floating before far-ws tiled',
        () => {
            // slot0 must take the floating window of ws1 instead of
            // skipping to the tiled window of ws2; an implementation
            // that ignores floating yields a single ws2->ws0 pull on
            // tile0
            deepEqual(
                planFillCascade(
                    snapshotOf({
                        0: {
                            tiles: pair,
                            windowRects: [],
                            movableWindowIndexes: [],
                        },
                        1: {
                            tiles: pair,
                            windowRects: [rect(2, 2, 0.1, 0.1)],
                            movableWindowIndexes: [],
                            floatingWindowIndexes: [0],
                        },
                        2: {
                            tiles: pair,
                            windowRects: [pair[0]],
                            movableWindowIndexes: [0],
                        },
                    })
                ),
                [
                    {
                        kind: 'pull',
                        fromWs: 1,
                        toWs: 0,
                        windowIndex: 0,
                        fromTileIndex: -1,
                        tileIndex: 0,
                    },
                    {
                        kind: 'pull',
                        fromWs: 2,
                        toWs: 0,
                        windowIndex: 0,
                        fromTileIndex: 0,
                        tileIndex: 1,
                    },
                ]
            );
        },
    ],
    [
        '19. triggering workspace floating windows are never absorbed (regression)',
        () => {
            // the trigger ws's own floating window neither compacts
            // into the free tile nor gets pulled: fill scans only look
            // rightward, and floating windows are never movers
            deepEqual(
                planFillCascade(
                    snapshotOf({
                        0: {
                            tiles: pair,
                            windowRects: [pair[0], rect(2, 2, 0.1, 0.1)],
                            movableWindowIndexes: [0],
                            floatingWindowIndexes: [1],
                        },
                    })
                ),
                []
            );
        },
    ],
    [
        '20. defensive: an index both floating and movable is invisible to computeSeating (illegal input, no crash)',
        () => {
            // the executor never produces this snapshot; the planner
            // must still not crash, and the duplicate window must
            // neither move nor block a tile: gone.has precedes the
            // movable check, so the survivor compacts onto tile0 (a
            // visible duplicate would push it onto tile1 instead)
            deepEqual(
                planFillCascade(
                    snapshotOf({
                        0: {
                            tiles: row3,
                            windowRects: [row3[0], row3[2]],
                            movableWindowIndexes: [0, 1],
                            floatingWindowIndexes: [0],
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
                        tileIndex: 0,
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
