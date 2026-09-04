/**
 * Self-asserting node tests for the GI-free signal-handling bookkeeping.
 * No framework: plain node:assert.
 *
 * Run with:
 *   npx esbuild tests/signalHandling.test.ts --bundle \
 *     --platform=node --format=cjs --outfile=/tmp/signalHandling.test.cjs
 *   node /tmp/signalHandling.test.cjs
 */

import { deepEqual, equal, ok } from 'node:assert/strict';
import SignalHandling from '../src/utils/signalHandling';

interface FakeTarget {
    connect(signal: string, handler: () => void): number;
    disconnect(id: number): void;
    emit(signal: string): void;
    disconnected: number[];
}

function target(): FakeTarget {
    const handlers: Record<string, (() => void)[]> = {};
    let nextId = 1;
    return {
        disconnected: [],
        connect(signal: string, handler: () => void): number {
            (handlers[signal] ??= []).push(handler);
            return nextId++;
        },
        disconnect(id: number): void {
            this.disconnected.push(id);
        },
        emit(signal: string): void {
            (handlers[signal] ?? []).forEach(h => h());
        },
    };
}

const scenarios: [string, () => void][] = [
    [
        '1. connect routes through the target and the handler fires on emit',
        () => {
            const signals = new SignalHandling();
            const a = target();
            let fired = 0;
            signals.connect(a, 'changed', () => {
                fired++;
            });
            a.emit('changed');
            a.emit('other'); // not connected
            equal(fired, 1);
            deepEqual(a.disconnected, []);
        },
    ],
    [
        '2. disconnect() releases every tracked handler exactly once and reports whether anything was released',
        () => {
            const signals = new SignalHandling();
            const a = target();
            const b = target();
            signals.connect(a, 'x', () => undefined);
            signals.connect(b, 'y', () => undefined);
            equal(signals.disconnect(), true);
            equal(a.disconnected.length, 1);
            equal(b.disconnected.length, 1);
            // nothing tracked anymore: no further disconnects, false result
            equal(signals.disconnect(), false);
            deepEqual(a.disconnected, [1]);
            deepEqual(b.disconnected, [1]); // each target numbers its own ids
        },
    ],
    [
        '3. disconnect(obj) releases every tracked signal of that object and returns the last released key',
        () => {
            const signals = new SignalHandling();
            const a = target();
            const b = target();
            // one object connected to two different signal names: both entries
            // must be released (distinct keys; the same key on a second object
            // would overwrite the first entry — scenario 4)
            signals.connect(a, 'x', () => undefined);
            signals.connect(a, 'y', () => undefined);
            signals.connect(b, 'z', () => undefined);
            // the released signal key string (the last one, truthy), not a boolean
            equal(signals.disconnect(a), 'y');
            // both ids released, in connection order
            deepEqual(a.disconnected, [1, 2]);
            // other objects are untouched
            deepEqual(b.disconnected, []);
            // an object with no tracked signals left reports undefined
            equal(signals.disconnect(a), undefined);
            equal(signals.disconnect(b), 'z');
            deepEqual(b.disconnected, [1]); // each target numbers its own ids
        },
    ],
    [
        '4. current keying semantics: reconnecting the same signal key tracks the latest handler id',
        () => {
            const signals = new SignalHandling();
            const a = target();
            const first = signals.connect(a, 'x', () => undefined);
            const second = signals.connect(a, 'x', () => undefined);
            ok(first !== second);
            signals.disconnect();
            // only the latest connection of the same key is tracked and released
            deepEqual(a.disconnected, [second]);
        },
    ],
    [
        '5. re-attach cycle stays clean: disconnect(stage) releases all its keys across repeated grab cycles',
        () => {
            const signals = new SignalHandling();
            const stage = target();
            // first grab cycle: the two grab-time stage handlers
            signals.connect(stage, 'touch-event', () => undefined);
            signals.connect(stage, 'captured-event', () => undefined);
            // grab end releases BOTH stage keys at once; the last
            // released key (insertion order) is 'captured-event'
            equal(signals.disconnect(stage), 'captured-event');
            deepEqual(stage.disconnected, [1, 2]);
            // second grab cycle re-registers the same two keys into an
            // empty map, then releases them again — no accumulation
            signals.connect(stage, 'touch-event', () => undefined);
            signals.connect(stage, 'captured-event', () => undefined);
            equal(signals.disconnect(stage), 'captured-event');
            deepEqual(stage.disconnected, [1, 2, 3, 4]);
            // map fully empty: no residual ids after repeated cycles
            equal(signals.disconnect(), false);
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
