/**
 * Self-asserting node tests for the GI-free insert-after-focused planner.
 * No framework: plain node:assert.
 *
 * Run with:
 *   npx esbuild tests/insertionPlanner.test.ts --bundle \
 *     --platform=node --format=cjs --outfile=/tmp/insertionPlanner.test.cjs
 *   node /tmp/insertionPlanner.test.cjs
 */

import { AssertionError } from 'node:assert';
import { deepEqual, equal, ok } from 'node:assert/strict';
import {
    buildWorkspaceChain,
    isSlotOccupied,
    mapWindowsToSlots,
    planInsertion,
    type ChainInputs,
    type ChainSlot,
    type InsertionFallback,
    type InsertionPlan,
    type PlanInsertionOptions,
} from '../src/components/tilingsystem/insertionPlanner';
import * as plannerModule from '../src/components/tilingsystem/insertionPlanner';

/** unwrap a plan result, failing the scenario on any fallback cause */
const asPlan = (p: InsertionPlan | InsertionFallback): InsertionPlan => {
    if ('fallback' in p) throw new Error(`unexpected fallback: ${p.fallback}`);
    return p;
};

/** the injected contract task 4 consumes; pinned verbatim by the scenarios */
type FindFirstVacancyOpts = {
    fromWs: number;
    nWorkspaces: number;
    allowCrossWorkspace: boolean;
    allowAppend: boolean;
    getChain: PlanInsertionOptions['getChain'];
    inputs: ChainInputs;
    getWorkspaceByIndex: PlanInsertionOptions['getWorkspaceByIndex'];
};

type FindFirstVacancyResult = {
    wsIndex: number;
    slot: ChainSlot;
    appendWorkspace: boolean;
};

/**
 * Resolved through the module namespace on purpose: while the export does
 * not exist yet (red phase) a named import would break the esbuild bundle
 * with "no matching export" - through the namespace the file still bundles
 * and every scenario below fails with an AssertionError instead.
 */
const findFirstVacancy = (
    opts: FindFirstVacancyOpts
): FindFirstVacancyResult | null => {
    const fn = (
        plannerModule as unknown as {
            findFirstVacancy?: (
                o: FindFirstVacancyOpts
            ) => FindFirstVacancyResult | null;
        }
    ).findFirstVacancy;
    if (typeof fn !== 'function') {
        throw new AssertionError({
            message: 'findFirstVacancy not implemented',
        });
    }
    return fn(opts);
};

// ---------------------------------------------------------------------------
// fakes: structurally complete for everything the pure planner touches
// ---------------------------------------------------------------------------

interface RectLike {
    x: number;
    y: number;
    width: number;
    height: number;
    overlap(other: RectLike): boolean;
}

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
    // Mtk.Rectangle.overlap semantics: intersection with positive area
    overlap(other: RectLike): boolean {
        return (
            this.x < other.x + other.width &&
            other.x < this.x + this.width &&
            this.y < other.y + other.height &&
            other.y < this.y + this.height
        );
    },
});

/** strip the fake method so rects can be deep-compared as plain data */
const plain = (r: RectLike) => ({
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
});

interface TileLike {
    x: number;
    y: number;
    width: number;
    height: number;
    groups: number[];
}

const tile = (
    x: number,
    y: number,
    width: number,
    height: number
): TileLike => ({
    x,
    y,
    width,
    height,
    groups: [],
});

/** cast a structurally-complete fake into the injected Meta/Mtk param type */
const asMeta = <T>(fake: unknown): T => fake as T;

interface FakeWindow {
    assignedTile: TileLike | undefined;
    minimized: boolean;
    maximizedVertically: boolean;
    maximizedHorizontally: boolean;
    windowType: number;
    get_monitor(): number;
    get_frame_rect(): RectLike;
    get_workspace(): FakeWorkspace;
    get_transient_for(): unknown;
    is_attached_dialog(): boolean;
    is_on_all_workspaces(): boolean;
    allows_move(): boolean;
    allows_resize(): boolean;
    is_fullscreen(): boolean;
}

interface FakeWorkspace {
    index(): number;
    windows: FakeWindow[];
}

interface WindowDef {
    frame: RectLike;
    monitor?: number;
    tiled?: boolean;
    minimized?: boolean;
    maximized?: boolean;
    movable?: boolean;
    fullscreen?: boolean;
}

interface WorldDef {
    monitorsInRowOrder: number[];
    /** per-monitor work area; defaults to a single 900x900 monitor */
    workAreas?: Record<number, RectLike>;
    tilesFor: (monitor: number, wsIndex: number) => TileLike[];
    /** windows per workspace, in MRU order */
    windowsByWs: Record<number, WindowDef[]>;
    nWorkspaces?: number;
    /** workspaces getWorkspaceByIndex reports as not inspectable */
    missingWorkspaces?: number[];
}

const DEFAULT_AREA = rect(0, 0, 900, 900);

function makeWorld(def: WorldDef) {
    const areaOf = (m: number): RectLike => def.workAreas?.[m] ?? DEFAULT_AREA;

    const inputs: ChainInputs = {
        monitorsInRowOrder: def.monitorsInRowOrder,
        getWorkAreaForMonitor: (m: number) => asMeta(areaOf(m)),
        getTilesForMonitor: (m: number, wsIndex: number) =>
            asMeta(def.tilesFor(m, wsIndex)),
        getWindows: (ws: unknown) => asMeta((ws as FakeWorkspace).windows),
        rectFromTile: (t: TileLike, container: unknown) => {
            const c = container as RectLike;
            return asMeta(
                rect(
                    c.x + t.x * c.width,
                    c.y + t.y * c.height,
                    t.width * c.width,
                    t.height * c.height
                )
            );
        },
    };

    const wsObjects = new Map<number, FakeWorkspace>();
    const handles = new Map<string, FakeWindow>();
    for (const key of Object.keys(def.windowsByWs)) {
        const wsIndex = Number(key);
        const ws: FakeWorkspace = {
            index: () => wsIndex,
            windows: [],
        };
        def.windowsByWs[wsIndex].forEach((d, i) => {
            const tiled = d.tiled ?? true;
            const movable = d.movable ?? true;
            const window: FakeWindow = {
                assignedTile: tiled ? tile(0, 0, 1, 1) : undefined,
                minimized: d.minimized ?? false,
                maximizedVertically: d.maximized ?? false,
                maximizedHorizontally: d.maximized ?? false,
                windowType: 0, // Meta.WindowType.NORMAL
                get_monitor: () => d.monitor ?? 0,
                get_frame_rect: () => d.frame,
                get_workspace: () => ws,
                get_transient_for: () => null,
                is_attached_dialog: () => false,
                is_on_all_workspaces: () => false,
                allows_move: () => movable,
                allows_resize: () => movable,
                is_fullscreen: () => d.fullscreen ?? false,
            };
            ws.windows.push(window);
            handles.set(`${wsIndex}:${i}`, window);
        });
        wsObjects.set(wsIndex, ws);
    }

    const opts = (
        overrides: Partial<PlanInsertionOptions> = {}
    ): PlanInsertionOptions => ({
        allowCrossWorkspace: false,
        allowAppend: false,
        getChain: (wsIndex: number) => buildWorkspaceChain(wsIndex, inputs),
        nWorkspaces:
            def.nWorkspaces ??
            Math.max(...Object.keys(def.windowsByWs).map(Number)) + 1,
        inputs,
        getWorkspaceByIndex: (i: number) =>
            def.missingWorkspaces?.includes(i)
                ? null
                : asMeta(wsObjects.get(i) ?? null),
        ...overrides,
    });

    return {
        inputs,
        opts,
        /** the live fake workspace object, as the planner receives it */
        ws: (wsIndex: number): FakeWorkspace => {
            const w = wsObjects.get(wsIndex);
            if (!w) throw new Error(`no workspace ${wsIndex}`);
            return w;
        },
        /** window handle: ws index + position in that workspace's MRU list */
        win: (wsIndex: number, i: number): FakeWindow => {
            const w = handles.get(`${wsIndex}:${i}`);
            if (!w) throw new Error(`no window ${wsIndex}:${i}`);
            return w;
        },
    };
}

// ---------------------------------------------------------------------------
// layouts in normalized coordinates + the matching pixel frames
// ---------------------------------------------------------------------------

const W = 900;

const thirds: TileLike[] = [
    tile(0, 0, 1 / 3, 1),
    tile(1 / 3, 0, 1 / 3, 1),
    tile(2 / 3, 0, 1 / 3, 1),
];
const quarters: TileLike[] = [0, 0.25, 0.5, 0.75].map(x => tile(x, 0, 0.25, 1));
const halves: TileLike[] = [tile(0, 0, 0.5, 1), tile(0.5, 0, 0.5, 1)];

const frameOf = (t: TileLike): RectLike =>
    rect(t.x * W, t.y * W, t.width * W, t.height * W);

/** bounding-box frame of consecutive tiles (a span window's frame rect) */
const frameSpanOf = (from: TileLike, to: TileLike): RectLike =>
    rect(
        from.x * W,
        from.y * W,
        (to.x + to.width - from.x) * W,
        (to.y + to.height - from.y) * W
    );

/**
 * comparable form of a plan's moves: [window, targetWs, targetSlotIndex,
 * tile]; the planner builds its own chains, so slots are compared by index
 * and tiles by reference or plain structure
 */
const moveTuples = (plan: InsertionPlan) =>
    plan.moves.map(m => [
        m.window,
        m.target.wsIndex,
        m.target.slot.slotIndex,
        m.target.tile,
    ]);

const scenarios: [string, () => void][] = [
    [
        '1. buildWorkspaceChain: per-monitor reading order, monitors in row order, pixel rects, no input mutation',
        () => {
            const m1Tiles = [tile(0.5, 0, 0.5, 0.5), tile(0, 0, 0.5, 0.5)]; // deliberately unsorted
            const m0Tiles = [tile(0, 0, 1, 1)];
            const world = makeWorld({
                monitorsInRowOrder: [1, 0],
                workAreas: {
                    1: rect(0, 0, 1000, 1000),
                    0: rect(1000, 0, 1000, 1000),
                },
                tilesFor: m => (m === 1 ? m1Tiles : m0Tiles),
                windowsByWs: { 0: [] },
            });
            const chain = buildWorkspaceChain(0, world.inputs);
            deepEqual(
                chain.map(s => [s.slotIndex, s.monitorIndex]),
                [
                    [0, 1],
                    [1, 1],
                    [2, 0],
                ]
            );
            ok(chain[0].tile === m1Tiles[1] && chain[1].tile === m1Tiles[0]);
            deepEqual(plain(chain[0].tileRect), {
                x: 0,
                y: 0,
                width: 500,
                height: 500,
            });
            deepEqual(plain(chain[1].tileRect), {
                x: 500,
                y: 0,
                width: 500,
                height: 500,
            });
            deepEqual(plain(chain[2].tileRect), {
                x: 1000,
                y: 0,
                width: 1000,
                height: 1000,
            });
            // the injected live array must not be permuted
            ok(m1Tiles[0].x === 0.5 && m1Tiles[1].x === 0);
        },
    ],
    [
        '2. occupancy truth: assigned tile + not minimized + not maximized; span windows cover slot ranges; drifted windows are skipped',
        () => {
            const world = makeWorld({
                monitorsInRowOrder: [0],
                tilesFor: () => thirds,
                windowsByWs: {
                    0: [
                        { frame: frameSpanOf(thirds[0], thirds[1]) }, // span 0-1
                        { frame: frameOf(thirds[1]), minimized: true },
                        { frame: frameOf(thirds[2]), maximized: true },
                        { frame: rect(5000, 5000, 10, 10) }, // drifted
                        { frame: frameOf(thirds[2]), tiled: false },
                    ],
                },
            });
            const chain = buildWorkspaceChain(0, world.inputs);
            const ws = world.ws(0);

            deepEqual(mapWindowsToSlots(chain, asMeta(ws), world.inputs), [
                { window: world.win(0, 0), startSlot: 0, endSlot: 1 },
            ]);

            // only the span counts: it covers slots 0 and 1
            equal(isSlotOccupied(chain, 0, asMeta(ws), world.inputs), true);
            equal(isSlotOccupied(chain, 1, asMeta(ws), world.inputs), true);
            equal(isSlotOccupied(chain, 2, asMeta(ws), world.inputs), false);
        },
    ],
    [
        '3. zero-move fast path: the slot right after the anchor is free',
        () => {
            const world = makeWorld({
                monitorsInRowOrder: [0],
                tilesFor: () => thirds,
                windowsByWs: { 0: [{ frame: frameOf(thirds[0]) }] },
            });
            const plan = asPlan(
                planInsertion(asMeta(world.win(0, 0)), world.opts())
            );
            deepEqual(
                [
                    plan.newWindowTarget.wsIndex,
                    plan.newWindowTarget.slot.slotIndex,
                ],
                [0, 1]
            );
            ok(plan.newWindowTarget.slot.tile === thirds[1]);
            deepEqual(plan.moves, []);
            equal(plan.switchView, false);
            equal(plan.appendWorkspace, undefined);
        },
    ],
    [
        '4. in-chain cascade: occupants behind the anchor shift one slot forward into a tail vacancy',
        () => {
            const world = makeWorld({
                monitorsInRowOrder: [0],
                tilesFor: () => quarters,
                windowsByWs: {
                    0: [
                        { frame: frameOf(quarters[0]) }, // anchor
                        { frame: frameOf(quarters[1]) },
                        { frame: frameOf(quarters[2]) },
                        // slot 3 free
                    ],
                },
            });
            const plan = asPlan(
                planInsertion(asMeta(world.win(0, 0)), world.opts())
            );
            deepEqual(
                [
                    plan.newWindowTarget.wsIndex,
                    plan.newWindowTarget.slot.slotIndex,
                ],
                [0, 1]
            );
            ok(plan.newWindowTarget.slot.tile === quarters[1]);
            // pre-sorted by target key descending
            deepEqual(moveTuples(plan), [
                [world.win(0, 2), 0, 3, quarters[3]],
                [world.win(0, 1), 0, 2, quarters[2]],
            ]);
            equal(plan.switchView, false);
            equal(plan.appendWorkspace, undefined);
        },
    ],
    [
        '5. span occupant shifts as a whole: bounding-box tile over the covered target slots',
        () => {
            const world = makeWorld({
                monitorsInRowOrder: [0],
                tilesFor: () => quarters,
                windowsByWs: {
                    0: [
                        { frame: frameOf(quarters[0]) }, // anchor
                        { frame: frameSpanOf(quarters[1], quarters[2]) }, // spans 1-2
                        // slot 3 free
                    ],
                },
            });
            const plan = asPlan(
                planInsertion(asMeta(world.win(0, 0)), world.opts())
            );
            deepEqual(moveTuples(plan), [
                // the first covered target slot, with the span's bounding
                // box as the only tile truth
                [world.win(0, 1), 0, 2, tile(0.5, 0, 0.5, 1)],
            ]);
            deepEqual(
                [
                    plan.newWindowTarget.wsIndex,
                    plan.newWindowTarget.slot.slotIndex,
                ],
                [0, 1]
            );
            ok(plan.newWindowTarget.slot.tile === quarters[1]);
            equal(plan.switchView, false);
        },
    ],
    [
        '6. cross-workspace pull: anchor ws tail full, vacancy on the next ws; new window stays on the anchor ws',
        () => {
            const world = makeWorld({
                monitorsInRowOrder: [0],
                tilesFor: () => halves,
                windowsByWs: {
                    0: [
                        { frame: frameOf(halves[0]) }, // anchor
                        { frame: frameOf(halves[1]) },
                    ],
                    1: [{ frame: frameOf(halves[0]) }], // slot 1 free
                },
            });
            const plan = asPlan(
                planInsertion(
                    asMeta(world.win(0, 0)),
                    world.opts({ allowCrossWorkspace: true })
                )
            );
            deepEqual(
                [
                    plan.newWindowTarget.wsIndex,
                    plan.newWindowTarget.slot.slotIndex,
                ],
                [0, 1]
            );
            ok(plan.newWindowTarget.slot.tile === halves[1]);
            deepEqual(moveTuples(plan), [
                [world.win(1, 0), 1, 1, halves[1]],
                [world.win(0, 1), 1, 0, halves[0]],
            ]);
            equal(plan.switchView, false);
        },
    ],
    [
        '7. anchor at chain tail: new window takes slot 0 of the next chain with tiles and the view follows it',
        () => {
            const world = makeWorld({
                monitorsInRowOrder: [0],
                tilesFor: () => halves,
                windowsByWs: {
                    0: [
                        { frame: frameOf(halves[0]) },
                        { frame: frameOf(halves[1]) }, // anchor on the tail
                    ],
                    1: [{ frame: frameOf(halves[0]) }], // slot 1 free
                },
            });
            const plan = asPlan(
                planInsertion(
                    asMeta(world.win(0, 1)),
                    world.opts({ allowCrossWorkspace: true })
                )
            );
            deepEqual(moveTuples(plan), [[world.win(1, 0), 1, 1, halves[1]]]);
            deepEqual(
                [
                    plan.newWindowTarget.wsIndex,
                    plan.newWindowTarget.slot.slotIndex,
                ],
                [1, 0]
            );
            equal(plan.switchView, true);
        },
    ],
    [
        '8. append workspace: every real ws full, allowAppend moves the vacancy to a workspace that does not exist yet',
        () => {
            const world = makeWorld({
                monitorsInRowOrder: [0],
                tilesFor: () => halves,
                windowsByWs: {
                    0: [
                        { frame: frameOf(halves[0]) }, // anchor
                        { frame: frameOf(halves[1]) },
                    ],
                },
                nWorkspaces: 1,
            });
            const plan = asPlan(
                planInsertion(
                    asMeta(world.win(0, 0)),
                    world.opts({ allowCrossWorkspace: true, allowAppend: true })
                )
            );
            deepEqual(
                [
                    plan.newWindowTarget.wsIndex,
                    plan.newWindowTarget.slot.slotIndex,
                ],
                [0, 1]
            );
            ok(plan.newWindowTarget.slot.tile === halves[1]);
            deepEqual(moveTuples(plan), [
                [world.win(0, 1), 1, 0, halves[0]], // the ws to create
            ]);
            equal(plan.switchView, false);
            equal(plan.appendWorkspace, true);
        },
    ],
    [
        '9. append workspace with the anchor on the chain tail: zero moves, switchView follows the new window',
        () => {
            const world = makeWorld({
                monitorsInRowOrder: [0],
                tilesFor: () => halves,
                windowsByWs: {
                    0: [
                        { frame: frameOf(halves[0]) },
                        { frame: frameOf(halves[1]) }, // anchor on the tail
                    ],
                },
                nWorkspaces: 1,
            });
            const plan = asPlan(
                planInsertion(
                    asMeta(world.win(0, 1)),
                    world.opts({ allowCrossWorkspace: true, allowAppend: true })
                )
            );
            deepEqual(
                [
                    plan.newWindowTarget.wsIndex,
                    plan.newWindowTarget.slot.slotIndex,
                ],
                [1, 0]
            );
            deepEqual(plan.moves, []);
            equal(plan.switchView, true);
            equal(plan.appendWorkspace, true);
        },
    ],
    [
        '10. immovable-occupant fallback: an occupant in the shift interval that cannot move voids the plan',
        () => {
            const world = makeWorld({
                monitorsInRowOrder: [0],
                tilesFor: () => quarters,
                windowsByWs: {
                    0: [
                        { frame: frameOf(quarters[0]) }, // anchor
                        { frame: frameOf(quarters[1]), movable: false },
                        { frame: frameOf(quarters[2]) },
                        // slot 3 free
                    ],
                },
            });
            deepEqual(planInsertion(asMeta(world.win(0, 0)), world.opts()), {
                fallback: 'immovable-occupant',
            });

            // same for a fullscreen occupant
            const fs = makeWorld({
                monitorsInRowOrder: [0],
                tilesFor: () => quarters,
                windowsByWs: {
                    0: [
                        { frame: frameOf(quarters[0]) },
                        { frame: frameOf(quarters[1]), fullscreen: true },
                        { frame: frameOf(quarters[2]) },
                    ],
                },
            });
            deepEqual(planInsertion(asMeta(fs.win(0, 0)), fs.opts()), {
                fallback: 'immovable-occupant',
            });
        },
    ],
    [
        '11. immovable-occupant fallback: a span across the insertion boundary never vacates the insertion slot',
        () => {
            const world = makeWorld({
                monitorsInRowOrder: [0],
                tilesFor: () => thirds,
                windowsByWs: {
                    0: [
                        { frame: frameOf(thirds[0]) }, // anchor
                        { frame: frameSpanOf(thirds[0], thirds[1]) }, // spans 0-1
                        // slot 2 free
                    ],
                },
            });
            deepEqual(planInsertion(asMeta(world.win(0, 0)), world.opts()), {
                fallback: 'immovable-occupant',
            });
        },
    ],
    [
        '12. immovable-occupant fallback: a span whose shifted region does not fit the target chain tail',
        () => {
            const world = makeWorld({
                monitorsInRowOrder: [0],
                tilesFor: (m, wsIndex) =>
                    wsIndex === 0 ? thirds : [tile(0, 0, 1, 1)],
                windowsByWs: {
                    0: [
                        { frame: frameOf(thirds[0]) }, // anchor
                        { frame: frameSpanOf(thirds[1], thirds[2]) }, // spans 1-2
                    ],
                    1: [], // single-tile chain, slot 0 free
                },
            });
            deepEqual(
                planInsertion(
                    asMeta(world.win(0, 0)),
                    world.opts({ allowCrossWorkspace: true })
                ),
                { fallback: 'immovable-occupant' }
            );
        },
    ],
    [
        '13. no-vacancy fallback: nothing free anywhere we are allowed to look',
        () => {
            const world = makeWorld({
                monitorsInRowOrder: [0],
                tilesFor: () => halves,
                windowsByWs: {
                    0: [
                        { frame: frameOf(halves[0]) }, // anchor
                        { frame: frameOf(halves[1]) },
                    ],
                },
            });
            deepEqual(planInsertion(asMeta(world.win(0, 0)), world.opts()), {
                fallback: 'no-vacancy',
            });

            // a later workspace with a vacancy exists but is out of reach:
            // cross-workspace search disabled
            const worldNoCross = makeWorld({
                monitorsInRowOrder: [0],
                tilesFor: () => halves,
                windowsByWs: {
                    0: [
                        { frame: frameOf(halves[0]) },
                        { frame: frameOf(halves[1]) },
                    ],
                    1: [{ frame: frameOf(halves[0]) }],
                },
            });
            deepEqual(
                planInsertion(
                    asMeta(worldNoCross.win(0, 0)),
                    worldNoCross.opts()
                ),
                { fallback: 'no-vacancy' }
            );
        },
    ],
    [
        '14. no-vacancy fallback: a workspace inside the shift range cannot be inspected',
        () => {
            const world = makeWorld({
                monitorsInRowOrder: [0],
                tilesFor: () => halves,
                windowsByWs: {
                    0: [
                        { frame: frameOf(halves[0]) }, // anchor
                        { frame: frameOf(halves[1]) },
                    ],
                    1: [], // exists as a chain but is not inspectable
                    2: [], // vacancy lands here
                },
                missingWorkspaces: [1],
            });
            deepEqual(
                planInsertion(
                    asMeta(world.win(0, 0)),
                    world.opts({ allowCrossWorkspace: true })
                ),
                { fallback: 'no-vacancy' }
            );
        },
    ],
    [
        '15. anchor-unmapped fallback: untiled or drifted anchor occupies no slot',
        () => {
            const untiled = makeWorld({
                monitorsInRowOrder: [0],
                tilesFor: () => thirds,
                windowsByWs: {
                    0: [
                        { frame: frameOf(thirds[0]), tiled: false }, // anchor
                        { frame: frameOf(thirds[1]) },
                    ],
                },
            });
            deepEqual(
                planInsertion(asMeta(untiled.win(0, 0)), untiled.opts()),
                { fallback: 'anchor-unmapped' }
            );

            const drifted = makeWorld({
                monitorsInRowOrder: [0],
                tilesFor: () => thirds,
                windowsByWs: {
                    0: [
                        { frame: rect(5000, 5000, 10, 10) }, // anchor, off-layout
                        { frame: frameOf(thirds[1]) },
                    ],
                },
            });
            deepEqual(
                planInsertion(asMeta(drifted.win(0, 0)), drifted.opts()),
                { fallback: 'anchor-unmapped' }
            );
        },
    ],
    [
        '16. findFirstVacancy: empty workspace returns the fromWs slot 0',
        () => {
            const world = makeWorld({
                monitorsInRowOrder: [0],
                tilesFor: () => thirds,
                windowsByWs: { 0: [] },
            });
            const v = findFirstVacancy({ ...world.opts(), fromWs: 0 });
            deepEqual(
                [v?.wsIndex, v?.slot.slotIndex, v?.appendWorkspace],
                [0, 0, false]
            );
            ok(v?.slot.tile === thirds[0]);
        },
    ],
    [
        '17. findFirstVacancy: first vacancy in strict reading order (y-major inside a monitor, monitors in row order)',
        () => {
            const grid: TileLike[] = [
                tile(0, 0, 0.5, 0.5),
                tile(0.5, 0, 0.5, 0.5),
                tile(0, 0.5, 0.5, 0.5),
                tile(0.5, 0.5, 0.5, 0.5),
            ];
            const world = makeWorld({
                monitorsInRowOrder: [1, 0], // monitor 1 reads first
                workAreas: {
                    1: rect(0, 0, 900, 900),
                    0: rect(900, 0, 900, 900),
                },
                tilesFor: m => (m === 1 ? grid : halves),
                windowsByWs: {
                    0: [
                        { frame: frameOf(grid[0]), monitor: 1 },
                        { frame: frameOf(grid[1]), monitor: 1 },
                        { frame: frameOf(grid[3]), monitor: 1 }, // slot 2 free
                        // pixel frames inside monitor 0's work area (x 900+)
                        { frame: rect(900, 0, 450, 900), monitor: 0 },
                        { frame: rect(1350, 0, 450, 900), monitor: 0 },
                    ],
                },
            });
            const v = findFirstVacancy({ ...world.opts(), fromWs: 0 });
            deepEqual(
                [v?.wsIndex, v?.slot.slotIndex, v?.appendWorkspace],
                [0, 2, false]
            );
            ok(v?.slot.tile === grid[2]);
        },
    ],
    [
        '18. findFirstVacancy: no wraparound - full fromWs and later workspaces return null even when ws0 has a vacancy',
        () => {
            const world = makeWorld({
                monitorsInRowOrder: [0],
                tilesFor: () => halves,
                windowsByWs: {
                    0: [{ frame: frameOf(halves[0]) }], // slot 1 stays free
                    1: [
                        { frame: frameOf(halves[0]) },
                        { frame: frameOf(halves[1]) },
                    ],
                    2: [
                        { frame: frameOf(halves[0]) },
                        { frame: frameOf(halves[1]) },
                    ],
                },
                nWorkspaces: 3,
            });
            equal(
                findFirstVacancy({
                    ...world.opts({
                        allowCrossWorkspace: true,
                        allowAppend: false,
                    }),
                    fromWs: 1,
                }),
                null
            );
        },
    ],
    [
        '19. findFirstVacancy: everything full with cross-workspace allowed but no append returns null',
        () => {
            const world = makeWorld({
                monitorsInRowOrder: [0],
                tilesFor: () => halves,
                windowsByWs: {
                    0: [
                        { frame: frameOf(halves[0]) },
                        { frame: frameOf(halves[1]) },
                    ],
                },
                nWorkspaces: 1,
            });
            equal(
                findFirstVacancy({
                    ...world.opts({
                        allowCrossWorkspace: true,
                        allowAppend: false,
                    }),
                    fromWs: 0,
                }),
                null
            );
        },
    ],
    [
        '20. findFirstVacancy: append workspace requires cross-workspace AND append together',
        () => {
            const world = makeWorld({
                monitorsInRowOrder: [0],
                tilesFor: () => quarters, // also the appended ws chain
                windowsByWs: {
                    0: [
                        { frame: frameOf(quarters[0]) },
                        { frame: frameOf(quarters[1]) },
                        { frame: frameOf(quarters[2]) },
                        { frame: frameOf(quarters[3]) },
                    ],
                },
                nWorkspaces: 1,
            });
            const v = findFirstVacancy({
                ...world.opts({
                    allowCrossWorkspace: true,
                    allowAppend: true,
                }),
                fromWs: 0,
            });
            deepEqual(
                [v?.wsIndex, v?.slot.slotIndex, v?.appendWorkspace],
                [1, 0, true]
            );
            ok(v?.slot.tile === quarters[0]);
            // append alone is not enough: both flags must be true together
            equal(
                findFirstVacancy({
                    ...world.opts({
                        allowCrossWorkspace: false,
                        allowAppend: true,
                    }),
                    fromWs: 0,
                }),
                null
            );
        },
    ],
    [
        '21. planInsertion: a chain-tail anchor crosses forward to the next workspace even when an earlier slot on the anchor ws is free',
        () => {
            const world = makeWorld({
                monitorsInRowOrder: [0],
                tilesFor: () => quarters,
                windowsByWs: {
                    0: [
                        { frame: frameOf(quarters[0]) },
                        { frame: frameOf(quarters[1]) },
                        { frame: frameOf(quarters[3]) }, // anchor on the chain tail
                    ],
                    1: [], // vacancy on the next workspace
                },
            });
            const plan = asPlan(
                planInsertion(
                    asMeta(world.win(0, 2)),
                    world.opts({ allowCrossWorkspace: true })
                )
            );
            // the insertion point sits past the chain end, so the new window
            // never back-fills the free slot 2 of the anchor ws: it crosses
            // forward to ws1 slot 0 and the view follows it
            deepEqual(
                [
                    plan.newWindowTarget.wsIndex,
                    plan.newWindowTarget.slot.slotIndex,
                ],
                [1, 0]
            );
            ok(plan.newWindowTarget.slot.tile === quarters[0]);
            deepEqual(plan.moves, []);
            equal(plan.switchView, true);
            equal(plan.appendWorkspace, undefined);
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
