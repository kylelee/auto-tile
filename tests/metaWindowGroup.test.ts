/**
 * Self-asserting node tests for the GI-free alt-tab window group proxy.
 * No framework: plain node:assert.
 *
 * Run with:
 *   npx esbuild tests/metaWindowGroup.test.ts --bundle \
 *     --platform=node --format=cjs --outfile=/tmp/metaWindowGroup.test.cjs
 *   node /tmp/metaWindowGroup.test.cjs
 */

import { deepEqual, equal } from 'node:assert/strict';
import MetaWindowGroup from '../src/components/altTab/MetaWindowGroup';

interface FakeWindow {
    title: string;
    raisedBy: string[];
    activatedWith: number[];
    connectCalls: unknown[][];
    unmanagedHandlers: (() => void)[];
    workspace: { id: number };
    raise(by: string): void;
    activate(time: number): void;
    connect(signal: string, handler: () => void): number;
    connectObject(...args: unknown[]): number;
    emitUnmanaged(): void;
}

function fakeWindow(title: string): FakeWindow {
    const win = {
        title,
        raisedBy: [] as string[],
        activatedWith: [] as number[],
        connectCalls: [] as unknown[][],
        unmanagedHandlers: [] as (() => void)[],
        workspace: { id: title.length },
        get_workspace() {
            return win.workspace;
        },
        raise(by: string) {
            win.raisedBy.push(by);
        },
        activate(time: number) {
            win.activatedWith.push(time);
        },
        connect(signal: string, handler: () => void) {
            win.connectCalls.push([signal, handler]);
            if (signal === 'unmanaged') {
                win.unmanagedHandlers.push(handler);
            }
            return win.connectCalls.length;
        },
        connectObject(...args: unknown[]) {
            win.connectCalls.push(args);
            return 7;
        },
        emitUnmanaged() {
            win.unmanagedHandlers.forEach(h => h());
        },
    };
    return win;
}

const scenarios: [string, () => void][] = [
    [
        '1. method proxying: a method unknown to the group runs on every window',
        () => {
            const a = fakeWindow('aa');
            const b = fakeWindow('bb');
            const group = new MetaWindowGroup([a, b]);
            (group as unknown as { raise(by: string): void }).raise('kbd');
            deepEqual(a.raisedBy, ['kbd']);
            deepEqual(b.raisedBy, ['kbd']);
        },
    ],
    [
        '2. property proxying: a plain property reads from the first window; get_workspace reads through',
        () => {
            const a = fakeWindow('first');
            const b = fakeWindow('second');
            const group = new MetaWindowGroup([a, b]);
            equal((group as unknown as { title: string }).title, 'first');
            equal(group.get_workspace(), a.workspace);
        },
    ],
    [
        '3. activate: every window is activated, the time is refreshed from the shell between windows',
        () => {
            const original = (globalThis as { global?: unknown }).global;
            (globalThis as { global?: unknown }).global = {
                get_current_time: () => 42,
            };
            try {
                const a = fakeWindow('a');
                const b = fakeWindow('b');
                const group = new MetaWindowGroup([a, b]);
                group.activate(5);
                deepEqual(a.activatedWith, [5]);
                deepEqual(b.activatedWith, [42]);
            } finally {
                (globalThis as { global?: unknown }).global = original;
            }
        },
    ],
    [
        '4. connect/connectObject proxy to the first window and return its id',
        () => {
            const a = fakeWindow('a');
            const b = fakeWindow('b');
            const group = new MetaWindowGroup([a, b]);
            const handler = () => undefined;
            // the constructor's 'unmanaged' subscription is a's first
            // connection, so 'raised' gets a's next id
            equal(group.connect('raised', handler), 2);
            equal(group.connectObject('raised', handler, 1), 7);
            equal(a.unmanagedHandlers.length, 1);
            equal(b.unmanagedHandlers.length, 1);
            equal(a.connectCalls.length, 3); // unmanaged + raised + connectObject
        },
    ],
    [
        '5. onAllWindowsUnmanaged fires exactly once, after the last window of the group goes away',
        () => {
            const a = fakeWindow('a');
            const b = fakeWindow('b');
            const group = new MetaWindowGroup([a, b]);
            let fired = 0;
            group.onAllWindowsUnmanaged(() => {
                fired++;
            });
            a.emitUnmanaged();
            equal(fired, 0);
            b.emitUnmanaged();
            equal(fired, 1);
            // extra unmanaged emissions never re-fire the handler
            a.emitUnmanaged();
            equal(fired, 1);
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
