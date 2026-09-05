/**
 * Pure, GI-free planner for the "auto-fill freed tiles" cascade.
 *
 * Everything here works in ONE consistent rect space supplied by the
 * executor: per-monitor proportions (0..1 coordinates relative to a
 * monitor work area) for single-monitor cascades, or global pixels for
 * cascades spanning several monitors (per-monitor proportion rects of
 * different monitors would overlap each other). The planner itself is
 * space-agnostic, which keeps it runnable under plain node with zero
 * imports.
 *
 * Occupancy parity with tilingManager: a tile is occupied when ANY
 * window rect overlaps it with a positive-area intersection (the
 * _findEmptyTile / _getTiledWindowRects convention: frame rects of
 * windows with an assigned tile, not minimized, not maximized).
 *
 * Floating candidates: untiled (floating) windows of the workspaces
 * to the right are LAST-RANK pull candidates - strictly after all
 * tiled candidates of the same source workspace, taken in snapshot
 * order (tiled windows by rank, then floating windows by snapshot
 * order); a floating window never blocks compaction and never
 * compacts itself.
 *
 * Index conventions used by every exported function:
 * - tile indexes refer to the READING-ORDER-sorted tile array (rows
 *   top-to-bottom, left-to-right within a row - the sort used by
 *   tilingManager._findEmptyTile), not to the caller's original order;
 * - window indexes refer to the caller's windowRects array.
 */

export interface RectLike {
    x: number;
    y: number;
    width: number;
    height: number;
}

export type TileLike = RectLike;

/** per-workspace payload the executor supplies to the cascade */
export interface WorkspaceSnapshot {
    tiles: TileLike[];
    windowRects: RectLike[];
    /** executor-decided movable subset of windowRects indexes */
    movableWindowIndexes: number[];
    /**
     * indexes into windowRects of untiled (floating) windows that
     * passed all non-geometric guards: last-rank pull candidates,
     * never blocking and never compacting. Absent = no floating
     * candidates.
     */
    floatingWindowIndexes?: number[];
}

/** same-workspace compaction move */
export interface CompactionMove {
    windowIndex: number;
    fromTileIndex: number;
    toTileIndex: number;
}

/**
 * One planned relocation of the cascade; `kind` discriminates the two
 * shapes:
 * - 'compact': the window already lives on toWs (fromWs === toWs) and
 *   shifts from fromTileIndex to tileIndex to close a gap;
 * - 'pull': the window moves from a LATER workspace (fromWs > toWs)
 *   into tileIndex, a free reading-order tile of toWs.
 *
 * windowIndex always indexes the windowRects array of the fromWs
 * snapshot; fromTileIndex is the window's matched reading-order tile
 * on fromWs, or -1 for a floating pull (the window has no matched
 * tile on its source workspace); tileIndex is the destination
 * reading-order tile on toWs.
 */
export interface CascadeMove {
    kind: 'compact' | 'pull';
    fromWs: number;
    toWs: number;
    windowIndex: number;
    fromTileIndex: number;
    tileIndex: number;
}

/** intersections at or below this area count as "no overlap" */
const AREA_EPSILON = 1e-9;

/** fraction of a window rect's area that must lie inside one tile */
const MOSTLY_INSIDE_RATIO = 0.5;

function intersectionArea(a: RectLike, b: RectLike): number {
    const left = Math.max(a.x, b.x);
    const top = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.width, b.x + b.width);
    const bottom = Math.min(a.y + a.height, b.y + b.height);
    if (right <= left || bottom <= top) return 0;
    return (right - left) * (bottom - top);
}

function rectsOverlap(a: RectLike, b: RectLike): boolean {
    return intersectionArea(a, b) > AREA_EPSILON;
}

/**
 * Reading-order comparator: rows top-to-bottom, left-to-right within a
 * row. Exported for executors that must sort (rect, provenance) pairs
 * in the exact same order the planner uses for tile indexes.
 */
export function compareTilesInReadingOrder(a: TileLike, b: TileLike): number {
    return a.y - b.y || a.x - b.x;
}

function byMoverRank(
    a: { windowIndex: number; rank: number },
    b: { windowIndex: number; rank: number }
): number {
    return a.rank - b.rank || a.windowIndex - b.windowIndex;
}

export function sortTilesInReadingOrder(tiles: TileLike[]): TileLike[] {
    // Array.prototype.sort is stable (ES2019+): equally positioned
    // tiles keep their input order
    return [...tiles].sort(compareTilesInReadingOrder);
}

export function matchWindowToTile(
    rect: RectLike,
    sortedTiles: TileLike[]
): number {
    let bestIndex = -1;
    let bestArea = AREA_EPSILON;
    for (let index = 0; index < sortedTiles.length; index++) {
        const area = intersectionArea(rect, sortedTiles[index]);
        // strictly greater: area ties keep the reading-order-first tile
        if (area > bestArea) {
            bestArea = area;
            bestIndex = index;
        }
    }
    return bestIndex;
}

export function rectMostlyInsideTile(rect: RectLike, tile: TileLike): boolean {
    return (
        intersectionArea(rect, tile) >=
        MOSTLY_INSIDE_RATIO * rect.width * rect.height
    );
}

export function isSeatedOnSingleTile(
    rect: RectLike,
    sortedTiles: TileLike[]
): boolean {
    const halfArea = MOSTLY_INSIDE_RATIO * rect.width * rect.height;
    let seats = 0;
    for (const tile of sortedTiles) {
        if (intersectionArea(rect, tile) >= halfArea) seats++;
    }
    return seats === 1;
}

interface Seating {
    moves: CompactionMove[];
    /**
     * occupancy[tileIndex] is true when the reading-order tile hosts a
     * window after compaction (movers on their seats, stay-put windows
     * and blockers on their tiles)
     */
    occupancy: boolean[];
}

/**
 * Seat the movable windows onto reading-order seats. Windows whose
 * index is not in `movers`, and movable windows that fail
 * isSeatedOnSingleTile (e.g. rects spanning several tiles), never move
 * and mark every tile they overlap as occupied. Windows in `gone` have
 * already been pulled elsewhere by an earlier cascade step: they
 * neither move nor block. The k-th movable window by matched-tile rank
 * takes the k-th seat; movers left without a seat stay put and keep
 * their current tile occupied.
 */
function computeSeating(
    sortedTiles: TileLike[],
    windowRects: RectLike[],
    movers: number[],
    gone: Set<number> = new Set()
): Seating {
    const movable = new Set(movers);
    const occupancy = sortedTiles.map(() => false);
    const movableRanked: { windowIndex: number; rank: number }[] = [];

    for (let index = 0; index < windowRects.length; index++) {
        if (gone.has(index)) continue;
        const windowRect = windowRects[index];
        if (
            movable.has(index) &&
            isSeatedOnSingleTile(windowRect, sortedTiles)
        ) {
            movableRanked.push({
                windowIndex: index,
                rank: matchWindowToTile(windowRect, sortedTiles),
            });
        } else {
            for (
                let tileIndex = 0;
                tileIndex < sortedTiles.length;
                tileIndex++
            ) {
                if (rectsOverlap(windowRect, sortedTiles[tileIndex]))
                    occupancy[tileIndex] = true;
            }
        }
    }

    const seats: number[] = [];
    for (let tileIndex = 0; tileIndex < occupancy.length; tileIndex++) {
        if (!occupancy[tileIndex]) seats.push(tileIndex);
    }

    movableRanked.sort(byMoverRank);

    const moves: CompactionMove[] = [];
    for (let seatSlot = 0; seatSlot < movableRanked.length; seatSlot++) {
        const mover = movableRanked[seatSlot];
        if (seatSlot >= seats.length) {
            // more movers than seats: later windows stay put
            occupancy[mover.rank] = true;
            continue;
        }
        const toTileIndex = seats[seatSlot];
        if (toTileIndex !== mover.rank) {
            moves.push({
                windowIndex: mover.windowIndex,
                fromTileIndex: mover.rank,
                toTileIndex,
            });
        }
        occupancy[toTileIndex] = true;
    }

    return { moves, occupancy };
}

export function planCompaction(
    tiles: TileLike[],
    windowRects: RectLike[]
): CompactionMove[] {
    const sortedTiles = sortTilesInReadingOrder(tiles);
    const allWindowIndexes = windowRects.map((_windowRect, index) => index);
    return computeSeating(sortedTiles, windowRects, allWindowIndexes).moves;
}

export function computeFreeTiles(
    tiles: TileLike[],
    windowRects: RectLike[]
): number[] {
    const sortedTiles = sortTilesInReadingOrder(tiles);
    const freeTiles: number[] = [];
    for (let tileIndex = 0; tileIndex < sortedTiles.length; tileIndex++) {
        const tile = sortedTiles[tileIndex];
        let overlapped = false;
        for (const windowRect of windowRects) {
            if (rectsOverlap(tile, windowRect)) {
                overlapped = true;
                break;
            }
        }
        if (!overlapped) freeTiles.push(tileIndex);
    }
    return freeTiles;
}

interface WsState {
    sortedTiles: TileLike[];
    windowRects: RectLike[];
    movable: Set<number>;
    /** window indexes already pulled away by earlier cascade steps */
    consumed: Set<number>;
    /** untiled last-rank pull candidates, never blocking */
    floating: Set<number>;
}

export function planFillCascade(
    snapshot: (wsIndex: number) => WorkspaceSnapshot | null
): CascadeMove[] {
    const moves: CascadeMove[] = [];
    const states = new Map<number, WsState>();

    // ws indexes are CASCADE-RELATIVE: the planner queries snapshot(0),
    // snapshot(1), ... where 0 is the workspace whose freed tiles
    // triggered the cascade. An executor owning an absolute trigger
    // offset wraps its snapshot with it and adds the offset back to
    // fromWs/toWs. A null return means "no workspace here" and ENDS
    // the iteration: the cascade walks strictly rightward and never
    // wraps around.
    const getState = (wsIndex: number): WsState | null => {
        const cached = states.get(wsIndex);
        if (cached) return cached;
        const snap = snapshot(wsIndex);
        if (!snap) return null;
        const state: WsState = {
            sortedTiles: sortTilesInReadingOrder(snap.tiles),
            windowRects: snap.windowRects,
            movable: new Set(snap.movableWindowIndexes),
            consumed: new Set(),
            floating: new Set(snap.floatingWindowIndexes ?? []),
        };
        states.set(wsIndex, state);
        return state;
    };

    for (let ws = 0; ; ws++) {
        const state = getState(ws);
        if (!state) break;

        // 1) compaction pass: consumed windows already left this ws
        // and neither move nor block; floating windows are gone for
        // seating purposes too (last-rank candidates, never blocking);
        // movable windows that span tiles (not seated) block like any
        // other excluded window
        const movers: number[] = [];
        for (const windowIndex of state.movable) {
            if (!state.consumed.has(windowIndex)) movers.push(windowIndex);
        }
        const seating = computeSeating(
            state.sortedTiles,
            state.windowRects,
            movers,
            new Set([...state.consumed, ...state.floating])
        );
        for (const move of seating.moves) {
            moves.push({
                kind: 'compact',
                fromWs: ws,
                toWs: ws,
                windowIndex: move.windowIndex,
                fromTileIndex: move.fromTileIndex,
                tileIndex: move.toTileIndex,
            });
        }

        // 2) fill pass: pull the frontmost movable window of the
        // nearest right workspace into each free reading-order tile
        const freeTiles: number[] = [];
        for (
            let tileIndex = 0;
            tileIndex < seating.occupancy.length;
            tileIndex++
        ) {
            if (!seating.occupancy[tileIndex]) freeTiles.push(tileIndex);
        }

        for (let freeSlot = 0; freeSlot < freeTiles.length; freeSlot++) {
            let sourceWs = -1;
            let sourceState: WsState | null = null;
            let sourceWindow = -1;
            let sourceRank = -1;
            // nearest right ws that still has a pullable window
            for (let right = ws + 1; sourceWs < 0; right++) {
                const rightState = getState(right);
                if (!rightState) break;
                for (const windowIndex of rightState.movable) {
                    if (rightState.consumed.has(windowIndex)) continue;
                    const rank = matchWindowToTile(
                        rightState.windowRects[windowIndex],
                        rightState.sortedTiles
                    );
                    // matches no tile: cannot be ranked as frontmost
                    if (rank < 0) continue;
                    if (sourceWindow < 0 || rank < sourceRank) {
                        sourceWs = right;
                        sourceState = rightState;
                        sourceWindow = windowIndex;
                        sourceRank = rank;
                    }
                }
                // floating fallback: only when the tile scan above
                // missed this workspace, strictly after all its tiled
                // candidates; first floating window in snapshot order
                // (= executor MRU order), matchWindowToTile result
                // ignored - membership in floating is the only
                // classification. Breaking here stops the rightward
                // scan (outer condition), so a nearer floating window
                // wins over any farther workspace's tiled candidate.
                if (sourceWs < 0) {
                    for (const windowIndex of rightState.floating) {
                        if (rightState.consumed.has(windowIndex)) continue;
                        sourceWs = right;
                        sourceState = rightState;
                        sourceWindow = windowIndex;
                        sourceRank = -1;
                        break;
                    }
                }
            }
            if (!sourceState) break; // no pullable window on any right ws

            // the pulled window is consumed at its source ws: the
            // snapshot data stays untouched, later cascade steps on
            // that ws must not see (or move) it anymore
            sourceState.consumed.add(sourceWindow);
            moves.push({
                kind: 'pull',
                fromWs: sourceWs,
                toWs: ws,
                windowIndex: sourceWindow,
                fromTileIndex: sourceRank,
                tileIndex: freeTiles[freeSlot],
            });
        }
    }

    return moves;
}
