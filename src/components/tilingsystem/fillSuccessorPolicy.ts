/**
 * Pure, GI-free focus policy for the "fill freed tiles" cascade (zero
 * runtime imports on purpose: testable under plain node).
 *
 * After FreeTileFiller applies its cascade, focus should deterministically
 * land on:
 * - the window the cascade moved INTO the closed window's tile
 *   (pickFillSuccessor, driven by the applied-move records);
 * - or, when no mover landed there, the window seated on the previous
 *   occupied seat of the global reading order (findPreviousSeatOccupant,
 *   walking back across monitors and workspaces).
 *
 * Geometry semantics mirror freeTileFillPlanner: every intersection test
 * compares against AREA_EPSILON (never a bare > 0), and seat matching
 * keeps the reading-order-first seat on area ties (strictly-greater
 * updates, like matchWindowToTile). matchRectToSeat is exported so the
 * executor gathering its seat map reuses the exact same matching rule.
 */

export interface RectLike {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** one cascade relocation the filler actually applied */
export interface FillMoveRecord {
    windowId: number;
    toWsIndex: number;
    destRect: RectLike;
}

/** the closed window's seat, as captured at unmanage time */
export interface SuccessorAnchor {
    wsIndex: number;
    frameRect: RectLike;
}

/** intersections at or below this area count as "no overlap" */
export const AREA_EPSILON = 1e-9;

export function positiveAreaIntersection(a: RectLike, b: RectLike): number {
    const left = Math.max(a.x, b.x);
    const top = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.width, b.x + b.width);
    const bottom = Math.min(a.y + a.height, b.y + b.height);
    if (right <= left || bottom <= top) return 0;
    return (right - left) * (bottom - top);
}

/**
 * The window the cascade moved into the closed window's tile: the move
 * landing on the anchor workspace whose destination overlaps the anchor
 * frame rect. Multiple hits are defensive only (a single pass moves at
 * most one window per tile); the largest intersection wins and area
 * ties resolve to the LAST record, i.e. the latest applied move —
 * deliberately the opposite of matchRectToSeat, whose equal-area rule
 * keeps the FIRST seat (there the reading-order-first seat is the
 * meaningful winner).
 * Edge-adjacent contact (intersection <= AREA_EPSILON) never matches.
 */
export function pickFillSuccessor(
    moves: FillMoveRecord[],
    anchor: SuccessorAnchor
): number | null {
    let successorId: number | null = null;
    let bestArea = 0;
    for (const record of moves) {
        if (record.toWsIndex !== anchor.wsIndex) continue;
        const area = positiveAreaIntersection(
            record.destRect,
            anchor.frameRect
        );
        if (area <= AREA_EPSILON) continue;
        // >= (not >): equal areas keep the later record (latest applied)
        if (area >= bestArea) {
            bestArea = area;
            successorId = record.windowId;
        }
    }
    return successorId;
}

/** a window of a workspace, addressed by id, seated near frameRect */
export interface SeatWindow {
    windowId: number;
    frameRect: RectLike;
}

/** per-workspace seat map the executor gathers for the walk-back */
export interface WsSeats {
    wsIndex: number;
    /** every tile of this workspace across monitors, pre-sorted in global reading order */
    seats: RectLike[];
    windows: SeatWindow[];
}

/**
 * Reading-order fallback: the window seated on the first OCCUPIED seat
 * strictly BEFORE the anchor seat — walking the anchor workspace from
 * anchorSeat-1 down to seat 0, then every smaller-index workspace in the
 * passed array order from its last seat to its first. Pure and
 * deterministic: no re-sorting, the caller-supplied order is the walk
 * order. Returns null when the anchor seat cannot be resolved (no
 * positive intersection with any seat) or no previous seat is occupied.
 */
export function findPreviousSeatOccupant(
    anchor: SuccessorAnchor,
    workspaces: WsSeats[]
): number | null {
    let anchorWs: WsSeats | null = null;
    for (const workspace of workspaces) {
        if (workspace.wsIndex === anchor.wsIndex) {
            anchorWs = workspace;
            break;
        }
    }
    if (anchorWs === null) return null;

    const anchorSeatIndex = matchRectToSeat(anchor.frameRect, anchorWs.seats);
    if (anchorSeatIndex < 0) return null;

    const anchorOccupancy = buildSeatOccupancy(anchorWs);
    for (let seat = anchorSeatIndex - 1; seat >= 0; seat--) {
        const occupant = anchorOccupancy[seat];
        if (occupant !== null) return occupant.windowId;
    }

    for (const workspace of workspaces) {
        if (workspace.wsIndex >= anchor.wsIndex) continue;
        const occupancy = buildSeatOccupancy(workspace);
        for (let seat = workspace.seats.length - 1; seat >= 0; seat--) {
            const occupant = occupancy[seat];
            if (occupant !== null) return occupant.windowId;
        }
    }
    return null;
}

/** which window ends up owning a seat, and by how much overlap */
interface SeatOccupant {
    windowId: number;
    area: number;
}

/**
 * The seat a rect belongs to: the index, in the caller-supplied
 * reading-order seat array, of the seat sharing the largest
 * positive-area intersection with the rect. Area ties keep the FIRST
 * seat (strictly-greater updates), so the reading-order-first seat
 * wins — deliberately the opposite of pickFillSuccessor, where equal
 * areas resolve to the LAST record because there the latest applied
 * move is the meaningful winner. Returns -1 when no seat intersects
 * the rect beyond AREA_EPSILON.
 */
export function matchRectToSeat(rect: RectLike, seats: RectLike[]): number {
    let bestIndex = -1;
    let bestArea = AREA_EPSILON;
    for (let index = 0; index < seats.length; index++) {
        const area = positiveAreaIntersection(rect, seats[index]);
        // strictly greater: area ties keep the reading-order-first seat
        if (area > bestArea) {
            bestArea = area;
            bestIndex = index;
        }
    }
    return bestIndex;
}

function buildSeatOccupancy(ws: WsSeats): (SeatOccupant | null)[] {
    const occupancy: (SeatOccupant | null)[] = ws.seats.map(() => null);
    for (const seatWindow of ws.windows) {
        const seatIndex = matchRectToSeat(seatWindow.frameRect, ws.seats);
        // a window overlapping no seat (-1) takes part in no occupancy
        if (seatIndex < 0) continue;
        const area = positiveAreaIntersection(
            seatWindow.frameRect,
            ws.seats[seatIndex]
        );
        const current = occupancy[seatIndex];
        // strictly greater: equal areas keep the earlier window
        if (current === null || area > current.area) {
            occupancy[seatIndex] = { windowId: seatWindow.windowId, area };
        }
    }
    return occupancy;
}
