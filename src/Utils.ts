import { parse } from "shell-quote";
import { CompletionHandler } from "./types"

const _astralRegex = '[\uD800-\uDBFF][\uDC00-\uDFFF]';

const astralRegex = (opts: any = {}) => opts && opts.exact ?
                                        new RegExp(`^${_astralRegex}$`) :
                                        new RegExp(_astralRegex, 'g');

export const ansiRegex = () => {
    const pattern = [
        '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[a-zA-Z\\d]*)*)?\\u0007)',
        '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PRZcf-ntqry=><~]))'
    ].join('|');

    return new RegExp(pattern, 'g');
};


export const stripAnsi = (input: any) => typeof input === 'string' ?
                                         input.replace(ansiRegex(), '') : input;


export function stringLength(input: string): number {
    return stripAnsi(input).replace(astralRegex(), ' ').length;
}

/**
 * Detects all the word boundaries on the given input
 */
export function wordBoundaries(input: string, leftSide = true): number[] {
    let match;
    const words: number[] = [];
    const rx = /\w+/g;

    while ((match = rx.exec(input))) {
        if (leftSide) {
            words.push(match.index);
        } else {
            words.push(match.index + match[0].length);
        }
    }

    return words;
}

/**
 * The closest left (or right) word boundary of the given input at the
 * given offset.
 */
export function closestLeftBoundary(input: string, offset: number): number {
    const found = wordBoundaries(input, true)
        .reverse()
        .find(x => x < offset);
    return found == null ? 0 : found;
}

export function closestRightBoundary(input: string, offset: number): number {
    const found = wordBoundaries(input, false).find(x => x > offset);
    return found == null ? input.length : found;
}

/**
 * Convert offset at the given input to col/row location
 *
 * This function is not optimized and practically emulates via brute-force
 * the navigation on the terminal, wrapping when they reach the column width.
 */
export function offsetToColRow(input: string, offset: number,
    maxCols: number): { row: number; col: number } {
    let row = 0,
        col = 0;

    for (let i = 0; i < offset; ++i) {
        const chr = input.charAt(i);
        if (chr == "\n") {
            col = 0;
            row += 1;
        } else {
            col += 1;
            if (col > maxCols) {
                col = 0;
                row += 1;
            }
        }
    }

    return {row, col};
}

/**
 * Counts the lines in the given input
 */
export function countLines(input: string, maxCols: number): number {
    return offsetToColRow(input, input.length, maxCols).row + 1;
}

/**
 * Checks if there is an incomplete input
 *
 * An incomplete input is considered:
 * - An input that contains unterminated single quotes
 * - An input that contains unterminated double quotes
 * - An input that ends with "\"
 * - An input that has an incomplete boolean shell expression (&& and ||)
 * - An incomplete pipe expression (|)
 */
export function isIncompleteInput(input: string): boolean {
    // Empty input is not incomplete
    if (input.trim() == "") {
        return false;
    }

    // Check for dangling single-quote strings
    if ((input.match(/'/g) || []).length % 2 !== 0) {
        return true;
    }

    // Check for dangling double-quote strings
    if ((input.match(/"/g) || []).length % 2 !== 0) {
        return true;
    }

    // Check for dangling boolean or pipe operations
    let x = input.split(/(\|\||\||&&)/g).pop()
    if (x && x.trim() === '') {
        return true;
    }

    // Check for tailing slash
    return input.endsWith("\\") && !input.endsWith("\\\\");
}

/**
 * Returns true if the expression ends on a tailing whitespace
 */
export function hasTailingWhitespace(input: string): boolean {
    return input.match(/[^\\][ \t]$/m) != null;
}

/**
 * Returns the last expression in the given input
 */
export function getLastToken(input: string): string {
    // Empty expressions
    if (input.trim() === "") {
        return "";
    }
    if (hasTailingWhitespace(input)) {
        return "";
    }

    // Last token
    const tokens = parse(input);
    return tokens.pop() || "";
}

/**
 * Returns the auto-complete candidates for the given input
 */
export function collectAutocompleteCandidates(callbacks: CompletionHandler[],
    input: string): string[] {
    const tokens = parse(input);
    let index = tokens.length - 1;
    let expr = tokens[index] || "";

    // Empty expressions
    if (input.trim() === "") {
        index = 0;
        expr = "";
    } else if (hasTailingWhitespace(input)) {
        // Expressions with danging space
        index += 1;
        expr = "";
    }

    let res: string[] = []
    // Collect all auto-complete candidates from the callbacks
    const all = callbacks.reduce((candidates, {fn, args}) => {
        try {
            return candidates.concat(fn(index, tokens, ...args));
        } catch (e) {
            // @ts-ignore
            console.error("Auto-complete error:", e);
            return candidates;
        }
    }, res);

    // Filter only the ones starting with the expression
    return all.filter(txt => txt.startsWith(expr));
}

