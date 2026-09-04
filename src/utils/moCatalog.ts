// Pure GNU .mo catalog reader plus Chinese locale aliasing.
//
// The Chinese catalogs are stored under script-based directory names
// (zh_Simplified / zh_Traditional) while libc gettext only ever probes the
// locale names reported by the environment (zh_CN, zh_TW, ...), so lookups
// for those locales are done here instead of by the system gettext.
//
// This module must stay free of imports: it is shared verbatim by the
// extension process (src/translations.ts) and the preferences process
// (src/prefs.ts), which have disjoint GI namespaces.

const MO_MAGIC = 0x950412de;

// glibc reports region codes only; map them to the catalog directory names
const CHINESE_CATALOG_ALIASES: Record<string, string> = {
    zh: 'zh_Simplified',
    zh_CN: 'zh_Simplified',
    zh_SG: 'zh_Simplified',
    zh_TW: 'zh_Traditional',
    zh_HK: 'zh_Traditional',
};

export function chineseCatalogFor(candidate: string): string | null {
    // strip charset ('zh_CN.utf-8') and modifier ('zh_TW@big5') parts
    const locale = candidate.split(/[.@]/, 1)[0];
    return CHINESE_CATALOG_ALIASES[locale] ?? null;
}

type PluralFormula = (n: number) => number;

export class MoCatalog {
    private readonly _messages: Map<string, string>;
    private readonly _plural: { nplurals: number; formula: PluralFormula } | null;

    private constructor(
        messages: Map<string, string>,
        plural: { nplurals: number; formula: PluralFormula } | null,
    ) {
        this._messages = messages;
        this._plural = plural;
    }

    static fromBytes(bytes: Uint8Array): MoCatalog | null {
        // little-endian layout: magic, revision, count, originals table,
        // translations table, hash size, hash offset, then <length, offset>
        // pairs for every entry of both tables
        if (bytes.length < 28) return null;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (view.getUint32(0, true) !== MO_MAGIC) return null;

        const count = view.getUint32(8, true);
        const originalsTable = view.getUint32(12, true);
        const translationsTable = view.getUint32(16, true);
        if (
            count === 0 ||
            originalsTable + count * 8 > bytes.length ||
            translationsTable + count * 8 > bytes.length
        )
            return null;

        const decoder = new TextDecoder('utf-8');
        const readEntry = (table: number, index: number): string => {
            const length = view.getUint32(table + index * 8, true);
            const offset = view.getUint32(table + index * 8 + 4, true);
            return decoder.decode(bytes.subarray(offset, offset + length));
        };

        const messages = new Map<string, string>();
        for (let i = 0; i < count; i++) {
            const msgid = readEntry(originalsTable, i);
            const msgstr = readEntry(translationsTable, i);
            if (msgid.length > 0 || msgstr.length > 0) messages.set(msgid, msgstr);
        }

        return new MoCatalog(messages, parsePluralForms(messages.get('') ?? ''));
    }

    gettext(msgid: string): string | null {
        const translation = this._messages.get(msgid);
        if (!translation) return null;
        return translation.split('\u0000', 1)[0] ?? translation;
    }

    pgettext(context: string, msgid: string): string | null {
        return this.gettext(`${context}\u0004${msgid}`);
    }

    ngettext(singular: string, plural: string, n: number): string | null {
        const entry =
            this._messages.get(`${singular}\u0000${plural}`) ??
            this._messages.get(singular);
        if (!entry) return null;
        const forms = entry.split('\u0000');
        let index: number;
        if (this._plural) {
            index = Math.min(Math.max(this._plural.formula(n), 0), forms.length - 1);
        } else {
            // no Plural-Forms header: gettext's documented fallback is
            // nplurals=1, keep a safe English-style guess when several
            // forms are present anyway
            index = forms.length === 1 ? 0 : n === 1 ? 0 : 1;
        }
        return forms[index];
    }
}

function parsePluralForms(
    header: string,
): { nplurals: number; formula: PluralFormula } | null {
    const match = /Plural-Forms:\s*nplurals\s*=\s*(\d+)\s*;\s*plural\s*=\s*([^;\n]+)/.exec(
        header,
    );
    if (!match) return null;
    const formula = compilePluralExpression(match[2]);
    if (!formula) return null;
    return { nplurals: Number(match[1]), formula };
}

// compiles the C-like expression of Plural-Forms headers, e.g.
// "n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 ? 1 : 2",
// into a plain (n -> plural index) function; C integer division semantics
export function compilePluralExpression(source: string): PluralFormula | null {
    const tokens = source.match(/\d+|==|!=|<=|>=|&&|\|\||[A-Za-z_]\w*|[-+*/%<>!?:()]/g);
    if (!tokens) return null;

    let position = 0;
    const peek = (): string | undefined => tokens[position];
    const take = (): string | undefined => tokens[position++];

    const ternary = (): PluralFormula | null => {
        const condition = binary(0);
        if (!condition) return null;
        if (peek() !== '?') return condition;
        take();
        const thenBranch = ternary();
        if (!thenBranch) return null;
        if (take() !== ':') return null;
        const elseBranch = ternary();
        if (!elseBranch) return null;
        return n => (condition(n) !== 0 ? thenBranch(n) : elseBranch(n));
    };

    // operator precedence, loosest first: ||, &&, ==/!=, relational,
    // additive, multiplicative
    const LEVELS: string[][] = [
        ['||'],
        ['&&'],
        ['==', '!='],
        ['<', '>', '<=', '>='],
        ['+', '-'],
        ['*', '/', '%'],
    ];

    const binary = (level: number): PluralFormula | null => {
        if (level >= LEVELS.length) return unary();
        const first = binary(level + 1);
        if (!first) return null;
        let left: PluralFormula = first;
        let token: string | undefined;
        while (
            (token = peek()) !== undefined &&
            LEVELS[level].includes(token as string)
        ) {
            take();
            const right = binary(level + 1);
            if (!right) return null;
            const a = left;
            const b = right;
            const op = token as string;
            left = n => {
                const x = a(n);
                const y = b(n);
                switch (op) {
                    case '||':
                        return x !== 0 || y !== 0 ? 1 : 0;
                    case '&&':
                        return x !== 0 && y !== 0 ? 1 : 0;
                    case '==':
                        return x === y ? 1 : 0;
                    case '!=':
                        return x !== y ? 1 : 0;
                    case '<':
                        return x < y ? 1 : 0;
                    case '>':
                        return x > y ? 1 : 0;
                    case '<=':
                        return x <= y ? 1 : 0;
                    case '>=':
                        return x >= y ? 1 : 0;
                    case '+':
                        return x + y;
                    case '-':
                        return x - y;
                    case '*':
                        return x * y;
                    case '/':
                        return Math.trunc(x / y);
                    case '%':
                        return x % y;
                    default:
                        return 0;
                }
            };
        }
        return left;
    };

    const unary = (): PluralFormula | null => {
        if (peek() === '!') {
            take();
            const operand = unary();
            if (!operand) return null;
            return n => (operand(n) === 0 ? 1 : 0);
        }
        if (peek() === '-') {
            take();
            const operand = unary();
            if (!operand) return null;
            return n => -operand(n);
        }
        return primary();
    };

    const primary = (): PluralFormula | null => {
        const token = take();
        if (token === undefined) return null;
        if (token === '(') {
            const expression = ternary();
            if (!expression || take() !== ')') return null;
            return expression;
        }
        if (token === 'n') return n => n;
        if (/^\d+$/.test(token)) {
            const value = Number(token);
            return () => value;
        }
        return null;
    };

    const formula = ternary();
    if (!formula || position !== tokens.length) return null;
    return formula;
}
