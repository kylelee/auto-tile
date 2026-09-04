#!/usr/bin/env node
//
// Per-file fallback for the shexli analyzer (used by ./scripts/check_extension.sh --per-file).
//
// shexli 0.2.1 segfaults once a package's analysis accumulates enough input —
// empirically driven by total input size, not code structure (a 6-line file
// padded with 2000 blank lines crashes it; a 71KB minified one-line file does
// not). Whole-package analysis of AutoTile therefore dies. This script gets a
// verdict anyway:
//
//   1. Every .js file is analyzed alone in a mini-package { metadata.json,
//      <file> }, renamed to its ROLE so role-dependent rules apply: files
//      reachable from extension.js become extension.js (shell rules), files
//      reachable from prefs.js become prefs.js (prefs rules), shared files
//      are analyzed under both names.
//   2. A file that crashes alone is covered adaptively: units (top-level
//      statements, class-body members, function-body statements) are packed
//      into small line-budgeted chunks; a chunk that still crashes is split
//      in half, and an oversized single unit is descended into one level
//      (class → methods → statements). Chunks are rebuilt as valid JS with a
//      one-line wrapper header, so a finding at chunk line L maps back to the
//      original file arithmetically; chunk text is never blank-line padded
//      (padding is what crashes shexli).
//
// Caveat: cross-file rules (reachability, transitive import segregation) are
// NOT covered in this mode; the import graph computed here flags unreachable
// files itself.
//
// Usage: node scripts/shexli_per_file.mjs <package-dir> <shexli-executable> [--strict] [--budget=150]
// Exit:  0 ok (warnings allowed unless --strict) · 1 blocking findings · 3 some input could not be analyzed

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);

let parser;
try {
    parser = require('@babel/parser');
} catch {
    console.error('❌ @babel/parser not found — run `npm install` first');
    process.exit(2);
}

const args = process.argv.slice(2);
const pkgDir = path.resolve(args[0] ?? '');
const shexliBin = args[1] ?? '';
const strict = args.includes('--strict');
const BUDGET = Number(args.find((a) => a.startsWith('--budget='))?.slice(9)) || 150;

if (!pkgDir || !shexliBin || !fs.existsSync(path.join(pkgDir, 'metadata.json'))) {
    console.error('Usage: node scripts/shexli_per_file.mjs <package-dir> <shexli-executable> [--strict] [--budget=N]');
    process.exit(2);
}

const rel = (p) => path.relative(pkgDir, p);

function walkJs(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walkJs(p));
        else if (entry.name.endsWith('.js')) out.push(p);
    }
    return out;
}

const allFiles = walkJs(pkgDir).map(rel).sort();
const sources = new Map(allFiles.map((f) => [f, fs.readFileSync(path.join(pkgDir, f), 'utf8')]));

// --- import graph ----------------------------------------------------------
// ESM:  import x from './a.js' / import('./a.js')
// legacy: Me.imports.a.b.Export → a/b.js when that file exists, else a.js
function importsOf(file, src) {
    const edges = new Set();
    const tryEdge = (target) => {
        const normalized = path.normalize(path.join(path.dirname(file), target));
        if (allFiles.includes(normalized)) edges.add(normalized);
    };
    for (const m of src.matchAll(/from\s+["'](\.[^"']+)["']/g)) tryEdge(m[1]);
    for (const m of src.matchAll(/import\(\s*["'](\.[^"']+)["']\s*\)/g)) tryEdge(m[1]);
    for (const m of src.matchAll(/Me\.imports\.([A-Za-z0-9_.]+)/g)) {
        const segs = m[1].split('.').slice(0, -1);
        while (segs.length > 0) {
            const candidate = segs.join('/') + '.js';
            if (allFiles.includes(candidate)) {
                edges.add(candidate);
                break;
            }
            segs.pop();
        }
    }
    return [...edges];
}

const graph = new Map(allFiles.map((f) => [f, importsOf(f, sources.get(f))]));

function reachable(start) {
    const seen = new Set();
    const queue = [start];
    while (queue.length > 0) {
        for (const next of graph.get(queue.shift()) ?? []) {
            if (!seen.has(next)) {
                seen.add(next);
                queue.push(next);
            }
        }
    }
    return seen;
}

const shellSide = reachable('extension.js');
const prefsSide = reachable('prefs.js');

// --- shexli runner ---------------------------------------------------------
const metadata = fs.readFileSync(path.join(pkgDir, 'metadata.json'));

function runShexli(fileContent, roleName) {
    const tmp = fs.mkdtempSync('/tmp/shexli-per-file-');
    try {
        fs.writeFileSync(path.join(tmp, 'metadata.json'), metadata);
        fs.writeFileSync(path.join(tmp, roleName), fileContent);
        const res = spawnSync(shexliBin, ['--format', 'json', tmp], { timeout: 60_000, encoding: 'utf8' });
        if (res.error || res.status === null || res.status >= 128) return { kind: 'crashed' };
        if (res.status !== 0) return { kind: 'failed' };
        return { kind: 'ok', json: JSON.parse(res.stdout) };
    } catch {
        return { kind: 'failed' };
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

// --- chunk machinery -------------------------------------------------------
// A unit is a syntactically self-contained slice of the original file:
//   kind 'plain'     — any top-level statement (imports included)
//   kind 'method'    — a class-body member, valid inside a `class {}` wrapper
//   kind 'statement' — a statement, valid inside a `function () {}` wrapper
// Wrappers occupy exactly one header line, so chunk line L maps back to the
// original file via  origLine = L + unit.start - firstContentLine.
function unit(node, kind) {
    return { start: node.loc.start.line, end: node.loc.end.line, kind };
}

function methodUnits(classBody) {
    return classBody.body.map((m) => unit(m, 'method'));
}

function statementUnits(block) {
    return block.body.map((s) => unit(s, 'statement'));
}

// Find the next decomposition level inside a unit that crashed alone.
function innerUnits(node) {
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
        return node.body.body.length > 0 ? methodUnits(node.body) : null;
    }
    if (node.type === 'MethodDefinition' || node.type === 'ClassProperty' || node.type === 'PropertyDefinition' || node.type === 'StaticBlock') {
        const fn = node.value ?? node.body;
        if (fn && (fn.type === 'FunctionExpression' || fn.type === 'ArrowFunctionExpression') && fn.body?.type === 'BlockStatement') {
            return fn.body.body.length > 0 ? statementUnits(fn.body) : null;
        }
        return null;
    }
    if (node.type === 'FunctionDeclaration' && node.body.body.length > 0) {
        return statementUnits(node.body);
    }
    let candidate = null;
    const visit = (n) => {
        if (candidate) return;
        if (n.type === 'ClassExpression' && n.body?.body?.length > 0) {
            candidate = methodUnits(n.body);
            return;
        }
        for (const key of Object.keys(n)) {
            if (key === 'loc' || key.endsWith('Comments')) continue;
            const child = n[key];
            if (Array.isArray(child)) child.forEach((c) => c && typeof c.type === 'string' && visit(c));
            else if (child && typeof child.type === 'string') visit(child);
        }
    };
    visit(node);
    return candidate;
}

function parseUnits(src) {
    const ast = parser.parse(src, { sourceType: 'unambiguous' });
    return { ast, units: ast.program.body.map((n) => unit(n, 'plain')) };
}

const WRAPPERS = {
    plain: { header: null, firstContentLine: 1 },
    method: { header: 'class __shexli_chunk__ {', footer: '}', firstContentLine: 2 },
    statement: { header: 'function __shexli_chunk__() {', footer: '}', firstContentLine: 2 },
};

function buildChunk(lines, units) {
    const { header, footer, firstContentLine } = WRAPPERS[units[0].kind];
    const body = lines.slice(units[0].start - 1, units[units.length - 1].end).join('\n');
    const content = (header ? `${header}\n` : '') + body + (footer ? `\n${footer}` : '') + '\n';
    return { content, delta: units[0].start - firstContentLine };
}

function packBatches(units) {
    const batches = [];
    let batch = [];
    const flush = () => {
        if (batch.length > 0) batches.push(batch);
        batch = [];
    };
    for (const u of units) {
        if (batch.length > 0 && (u.kind !== batch[0].kind || u.start - batch[0].start >= BUDGET)) flush();
        batch.push(u);
        if (u.end - batch[0].start + 1 >= BUDGET) flush();
    }
    flush();
    return batches;
}

// --- analysis --------------------------------------------------------------
const findings = new Map(); // key: rule|file|line|message
const uncoveredRanges = [];

function collect(json, file, delta) {
    for (const f of json.findings ?? []) {
        for (const ev of f.evidence ?? []) {
            const origLine = (ev.line ?? 0) + delta;
            const key = `${f.rule_id}|${file}|${origLine}|${f.message}`;
            if (!findings.has(key)) {
                findings.set(key, { rule: f.rule_id, severity: f.severity, message: f.message, help: f.help, file, line: origLine });
            }
        }
    }
}

function attempt(content, roleName, file, delta) {
    const res = runShexli(content, roleName);
    if (res.kind === 'ok') {
        collect(res.json, file, delta);
        return true;
    }
    return false;
}

function coverUnits(lines, units, roleName, file, nodeFor) {
    for (const batch of packBatches(units)) {
        const { content, delta } = buildChunk(lines, batch);
        if (attempt(content, roleName, file, delta)) continue;

        if (batch.length > 1) {
            const mid = Math.ceil(batch.length / 2);
            coverUnits(lines, batch.slice(0, mid), roleName, file, nodeFor);
            coverUnits(lines, batch.slice(mid), roleName, file, nodeFor);
            continue;
        }
        const inner = nodeFor(batch[0].start);
        if (inner && inner.length > 0) {
            coverUnits(lines, inner, roleName, file, nodeFor);
        } else {
            uncoveredRanges.push(`${file}:${batch[0].start}-${batch[0].end}`);
        }
    }
}

function analyzeFile(file) {
    const src = sources.get(file);
    const roles = new Set();
    if (file === 'extension.js' || shellSide.has(file)) roles.add('extension.js');
    if (file === 'prefs.js' || prefsSide.has(file)) roles.add('prefs.js');
    if (roles.size === 0) roles.add('extension.js'); // unreachable: generic rules only

    for (const role of roles) {
        if (attempt(src, role, file, 0)) continue;

        const lines = src.split('\n');
        const { ast, units } = parseUnits(src);
        const nodesByLine = new Map();
        for (const n of ast.program.body) {
            nodesByLine.set(n.loc.start.line, n);
            if (n.type === 'ClassDeclaration') {
                for (const m of n.body.body) nodesByLine.set(m.loc.start.line, m);
            }
        }
        const nodeFor = (startLine) => {
            const n = nodesByLine.get(startLine);
            return n ? innerUnits(n) : null;
        };
        coverUnits(lines, units, role, file, nodeFor);
    }
}

for (const file of allFiles) analyzeFile(file);

// --- report ----------------------------------------------------------------
// A file whose name appears in a string/template literal (e.g. a script
// spawned with `gjs -m path/to/x.js`) is used at runtime even though no
// module imports it — resources/monitorDescription.js works that way.
const runtimeRefs = new Set();
for (const src of sources.values()) {
    for (const m of src.matchAll(/[A-Za-z0-9_./-]+\.js\b/g)) {
        const base = m[0].replace(/^.*\//, '');
        for (const f of allFiles) {
            if (path.basename(f) === base) runtimeRefs.add(f);
        }
    }
}

const unreachable = allFiles.filter(
    (f) => f !== 'extension.js' && f !== 'prefs.js' && !shellSide.has(f) && !prefsSide.has(f) && !runtimeRefs.has(f),
);
if (unreachable.length > 0) {
    console.log('⚠️  Not reachable from extension.js or prefs.js (EGO flags these):');
    for (const f of unreachable) console.log(`     ${f}`);
    console.log();
}

const bySeverity = { error: [], warning: [], manual_review: [] };
for (const f of findings.values()) bySeverity[f.severity]?.push(f);
const ordered = [...bySeverity.error, ...bySeverity.warning, ...bySeverity.manual_review].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line,
);
for (const f of ordered) {
    console.log(`${f.rule}  ${f.severity}`);
    console.log(`  ${f.message.split('\n')[0]}`);
    console.log(`  --> ${f.file}:${f.line}`);
    if (f.help) console.log(`  = help: ${f.help}`);
    console.log();
}

const errs = bySeverity.error.length;
const warns = bySeverity.warning.length;
const manuals = bySeverity.manual_review.length;
console.log(
    `shexli(per-file): ${findings.size > 0 ? 'issues_found' : 'clean'} ` +
        `(${findings.size} findings, ${errs} errors, ${warns} warnings, ${manuals} manual_review; ` +
        `${allFiles.length} files, ${uncoveredRanges.length} uncovered ranges)`,
);

if (uncoveredRanges.length > 0) {
    console.log();
    console.log('💥 Line ranges that could not be analyzed even at statement level:');
    for (const r of uncoveredRanges) console.log(`     ${r}`);
}
if (uncoveredRanges.length > 0) process.exit(3);
if (errs > 0 || (strict && warns > 0)) process.exit(1);
process.exit(0);
