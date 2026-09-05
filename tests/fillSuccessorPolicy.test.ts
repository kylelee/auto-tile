/**
 * Self-asserting node tests for the GI-free fill-successor focus policy.
 * No framework: plain node:assert.
 *
 * Run with:
 *   npx esbuild tests/fillSuccessorPolicy.test.ts --bundle \
 *     --platform=node --format=cjs --outfile=/tmp/fsp.cjs --log-level=error
 *   node /tmp/fsp.cjs
 */

import { equal } from 'node:assert/strict';
import {
    AREA_EPSILON,
    findPreviousSeatOccupant,
    matchRectToSeat,
    pickFillSuccessor,
    positiveAreaIntersection,
    type FillMoveRecord,
    type RectLike,
    type SuccessorAnchor,
    type WsSeats,
} from '../src/components/tilingsystem/fillSuccessorPolicy';

const rect = (
    x: number,
    y: number,
    width: number,
    height: number
): RectLike => ({
    x,
    y,
    width,
    height,
});

// 2x2 reading-order grid on a 1920x1080 monitor:
// seat 0 top-left, seat 1 top-right, seat 2 bottom-left, seat 3 bottom-right
const SEATS: RectLike[] = [
    rect(0, 0, 960, 540),
    rect(960, 0, 960, 540),
    rect(0, 540, 960, 540),
    rect(960, 540, 960, 540),
];

const anchorOn = (wsIndex: number, frameRect: RectLike): SuccessorAnchor => ({
    wsIndex,
    frameRect,
});

const move = (
    windowId: number,
    toWsIndex: number,
    destRect: RectLike
): FillMoveRecord => ({
    windowId,
    toWsIndex,
    destRect,
});

const wsSeats = (
    wsIndex: number,
    windows: [number, RectLike][],
    seats: RectLike[] = SEATS
): WsSeats => ({
    wsIndex,
    seats,
    windows: windows.map(seatWindow => ({
        windowId: seatWindow[0],
        frameRect: seatWindow[1],
    })),
});

const scenarios: [string, () => void][] = [
    // --- positiveAreaIntersection -------------------------------------
    [
        'identical rects intersect in their full area',
        () => {
            equal(positiveAreaIntersection(SEATS[0], SEATS[0]), 960 * 540);
        },
    ],
    [
        'disjoint rects intersect in zero area',
        () => {
            equal(
                positiveAreaIntersection(
                    rect(0, 0, 10, 10),
                    rect(20, 20, 10, 10)
                ),
                0
            );
        },
    ],
    // --- pickFillSuccessor ---------------------------------------------
    [
        'a destination exactly on the anchor seat is picked',
        () => {
            equal(
                pickFillSuccessor(
                    [move(7, 1, SEATS[2])],
                    anchorOn(1, SEATS[2])
                ),
                7
            );
        },
    ],
    [
        'an empty move list picks no successor',
        () => {
            equal(pickFillSuccessor([], anchorOn(1, SEATS[2])), null);
        },
    ],
    [
        'a move landing on another workspace is not a successor',
        () => {
            equal(
                pickFillSuccessor(
                    [move(7, 2, SEATS[2])],
                    anchorOn(1, SEATS[2])
                ),
                null
            );
        },
    ],
    [
        'edge-adjacent (zero-area) contact with the anchor rect is not a match',
        () => {
            equal(
                pickFillSuccessor(
                    [move(7, 1, rect(0, 540, 960, 540))],
                    anchorOn(1, SEATS[0])
                ),
                null
            );
        },
    ],
    [
        'moves to other seats in the same pass do not interfere',
        () => {
            equal(
                pickFillSuccessor(
                    [
                        move(3, 1, SEATS[0]),
                        move(5, 1, SEATS[1]),
                        move(9, 1, SEATS[2]),
                    ],
                    anchorOn(1, SEATS[2])
                ),
                9
            );
        },
    ],
    [
        'the record with the larger intersection wins regardless of order',
        () => {
            equal(
                pickFillSuccessor(
                    [
                        move(13, 1, SEATS[2]),
                        move(11, 1, rect(0, 540, 480, 540)),
                    ],
                    anchorOn(1, SEATS[2])
                ),
                13
            );
        },
    ],
    [
        'equal-intersection records resolve to the last applied one',
        () => {
            equal(
                pickFillSuccessor(
                    [move(21, 1, SEATS[2]), move(22, 1, SEATS[2])],
                    anchorOn(1, SEATS[2])
                ),
                22
            );
        },
    ],
    [
        'a partially overlapping destination matches',
        () => {
            equal(
                pickFillSuccessor(
                    [move(15, 1, rect(480, 540, 960, 540))],
                    anchorOn(1, SEATS[2])
                ),
                15
            );
        },
    ],
    [
        'a destination fully containing the anchor rect matches',
        () => {
            equal(
                pickFillSuccessor(
                    [move(16, 1, rect(0, 0, 1920, 1080))],
                    anchorOn(1, SEATS[2])
                ),
                16
            );
        },
    ],
    [
        'a destination fully inside the anchor rect matches',
        () => {
            equal(
                pickFillSuccessor(
                    [move(17, 1, rect(240, 780, 240, 135))],
                    anchorOn(1, SEATS[2])
                ),
                17
            );
        },
    ],
    // --- findPreviousSeatOccupant --------------------------------------
    [
        'the occupant of the previous seat on the same workspace is found',
        () => {
            equal(
                findPreviousSeatOccupant(anchorOn(1, SEATS[2]), [
                    wsSeats(1, [
                        [31, SEATS[1]],
                        [32, SEATS[2]],
                    ]),
                ]),
                31
            );
        },
    ],
    [
        'an empty previous seat keeps walking back',
        () => {
            equal(
                findPreviousSeatOccupant(anchorOn(1, SEATS[2]), [
                    wsSeats(1, [[41, SEATS[0]]]),
                ]),
                41
            );
        },
    ],
    [
        'an anchor on the first seat of ws1 falls back to ws0, skipping larger-index workspaces',
        () => {
            equal(
                findPreviousSeatOccupant(anchorOn(1, SEATS[0]), [
                    wsSeats(2, [[99, SEATS[0]]]),
                    wsSeats(1, []),
                    wsSeats(0, [[52, SEATS[3]]]),
                ]),
                52
            );
        },
    ],
    [
        'the walk follows the caller-supplied seat order (multi-monitor merge)',
        () => {
            // deliberately NOT in reading order: bottom-left, top-right, top-left
            const seats = [
                rect(0, 540, 960, 540),
                rect(960, 0, 960, 540),
                rect(0, 0, 960, 540),
            ];
            equal(
                findPreviousSeatOccupant(anchorOn(1, seats[1]), [
                    wsSeats(1, [[71, seats[0]]], seats),
                ]),
                71
            );
        },
    ],
    [
        'smaller workspaces are walked in the passed array order',
        () => {
            equal(
                findPreviousSeatOccupant(anchorOn(2, SEATS[0]), [
                    wsSeats(2, [[70, SEATS[0]]]),
                    wsSeats(1, [[61, SEATS[3]]]),
                    wsSeats(0, [[60, SEATS[2]]]),
                ]),
                61
            );
        },
    ],
    [
        'an anchor rect with no positive seat intersection resolves nobody',
        () => {
            equal(
                findPreviousSeatOccupant(
                    anchorOn(1, rect(5000, 5000, 100, 100)),
                    [wsSeats(1, [[81, SEATS[0]]])]
                ),
                null
            );
        },
    ],
    [
        'the first seat of ws0 with nothing before it resolves nobody',
        () => {
            equal(
                findPreviousSeatOccupant(anchorOn(0, SEATS[0]), [
                    wsSeats(0, [[82, SEATS[0]]]),
                ]),
                null
            );
        },
    ],
    [
        'a window seated on no tile does not occupy any seat',
        () => {
            equal(
                findPreviousSeatOccupant(anchorOn(1, SEATS[2]), [
                    wsSeats(1, [[91, rect(-500, -500, 100, 100)]]),
                ]),
                null
            );
        },
    ],
    [
        'when several windows share a seat, the larger intersection occupies it',
        () => {
            equal(
                findPreviousSeatOccupant(anchorOn(1, SEATS[2]), [
                    wsSeats(1, [
                        [92, rect(960, 0, 720, 540)],
                        [93, rect(960, 0, 480, 540)],
                    ]),
                ]),
                92
            );
        },
    ],
    [
        'an empty workspaces list resolves nobody',
        () => {
            equal(findPreviousSeatOccupant(anchorOn(1, SEATS[2]), []), null);
        },
    ],
    // --- matchRectToSeat -----------------------------------------------
    [
        'an exact rect match returns its seat index',
        () => {
            equal(matchRectToSeat(SEATS[2], SEATS), 2);
        },
    ],
    [
        'a rect with no positive intersection matches no seat (-1)',
        () => {
            equal(matchRectToSeat(rect(5000, 5000, 100, 100), SEATS), -1);
        },
    ],
    [
        'edge-adjacent contact at the seam between two seats matches neither',
        () => {
            // zero-width rect on the seat0/seat1 seam: zero area everywhere
            equal(matchRectToSeat(rect(960, 0, 0, 540), SEATS), -1);
        },
    ],
    [
        'equal-area overlaps keep the reading-order-first seat',
        () => {
            // spans the vertical seam: 480*540 of overlap with each of
            // seat 0 and seat 1 — the tie must resolve to seat 0
            equal(matchRectToSeat(rect(480, 0, 960, 540), SEATS), 0);
        },
    ],
    // --- AREA_EPSILON ---------------------------------------------------
    [
        'AREA_EPSILON mirrors the planner constant',
        () => {
            equal(AREA_EPSILON, 1e-9);
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
