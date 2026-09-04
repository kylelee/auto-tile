import type Layout from './Layout';

type Tile = Layout['tiles'][number];

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isTile(value: unknown): value is Tile {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const { x, y, width, height, groups } = value as Record<string, unknown>;
    return (
        isFiniteNumber(x) &&
        isFiniteNumber(y) &&
        isFiniteNumber(width) &&
        isFiniteNumber(height) &&
        Array.isArray(groups) &&
        groups.every(group => Number.isInteger(group))
    );
}

/**
 * Crash-class validator for JSON-imported layouts (C19/C39/§5 P1-6): drops
 * every layout whose shape could poison the library with malformed geometry
 * (NaN/Infinity/non-number x/y/width/height, non-integer groups). Kept
 * layouts are the ORIGINAL objects — no reconstruction, no copying — so the
 * existing `JSON.parse(...) as Layout[]` structural semantics are unchanged.
 * Geometric range/overlap invariants are deliberately out of scope; invalid
 * input is silently dropped.
 */
export function validateLayouts(input: unknown): Layout[] {
    if (!Array.isArray(input)) {
        return [];
    }
    return input.filter((layout): layout is Layout => {
        if (typeof layout !== 'object' || layout === null) {
            return false;
        }
        const { id, tiles } = layout as Record<string, unknown>;
        return (
            typeof id === 'string' &&
            Array.isArray(tiles) &&
            tiles.length > 0 &&
            tiles.every(isTile)
        );
    });
}
