import { Terminal } from 'xterm'
import { HistoryController } from "./HistoryController";
import { LocalEchoControllerOptions } from "./LocalEchoControllerOptions"
import {
    ActivePrompt, CompletionFn, CompletionHandler, TerminalSize
} from "./types"
import {
    closestLeftBoundary, closestRightBoundary, collectAutocompleteCandidates,
    countLines, getLastToken, hasTailingWhitespace, isIncompleteInput,
    offsetToColRow, stringLength
} from "./Utils";


/**
 * A local terminal controller is responsible for displaying messages
 * and handling local echo for the terminal.
 *
 * Local echo supports most of bash-like input primitives. Namely:
 * - Arrow navigation on the input
 * - Alt-arrow for word-boundary navigation
 * - Alt-backspace for word-boundary deletion
 * - Multi-line input for incomplete commands
 * - Auto-complete hooks
 */
export default class LocalEchoController {

    _active = false

    _activeCharPrompt: ActivePrompt | null = null

    _activePrompt: ActivePrompt | null = null

    _autocompleteHandlers: CompletionHandler[] = []

    _cursor = 0

    _input = ""

    _termSize: TerminalSize

    history: HistoryController

    maxAutocompleteEntries: number = 100

    constructor(public term: Terminal,
        options: LocalEchoControllerOptions = {}) {
        this.term.on("data", this.handleTermData.bind(this));
        this.term.on("resize", this.handleTermResize.bind(this));
        this.history = new HistoryController(options.historySize || 10);
        this.maxAutocompleteEntries = options.maxAutocompleteEntries || 100;

        this._termSize = {
            cols: this.term.cols,
            rows: this.term.rows
        };
    }

    private get activePrompt(): string {
        return this._activePrompt ? this._activePrompt.prompt : ''
    }

    private get continuationPrompt(): string {
        return this._activePrompt
               ? this._activePrompt.continuationPrompt || ''
               : ''
    }

    /**
     * Abort a pending read operation
     */
    public abortRead(reason: string = "aborted"): void {
        if (this._activePrompt || this._activeCharPrompt != null) {
            this.term.write("\r\n");
        }
        if (this._activePrompt != null) {
            this._activePrompt.reject(reason);
            this._activePrompt = null;
        }
        if (this._activeCharPrompt != null) {
            this._activeCharPrompt.reject(reason);
            this._activeCharPrompt = null;
        }
        this._active = false;
    }

    /**
     * Register a handler that will be called to satisfy auto-completion
     */
    public addAutocompleteHandler(fn: CompletionFn, ...args: any[]): void {
        this._autocompleteHandlers.push({fn, args});
    }

    /**
     * Prints a message and properly handles new-lines
     */
    public print(message: string): void {
        const normInput = message.replace(/[\r\n]+/g, "\n");
        this.term.write(normInput.replace(/\n/g, "\r\n"));
    }

    /**
     * Prints a list of items using a wide-format
     */
    public printWide(items: string[], padding = 2): void {
        if (items.length == 0) {
            return this.println("");
        }

        // Compute item sizes and matrix row/cols
        const itemWidth =
            items.reduce((width, item) => Math.max(width, item.length), 0) +
            padding;
        const wideCols = Math.floor(this._termSize.cols / itemWidth);
        const wideRows = Math.ceil(items.length / wideCols);

        // Print matrix
        let i = 0;
        for (let row = 0; row < wideRows; ++row) {
            let rowStr = "";

            // Prepare columns
            for (let col = 0; col < wideCols; ++col) {
                if (i < items.length) {
                    let item = items[i++];
                    item += " ".repeat(itemWidth - item.length);
                    rowStr += item;
                }
            }
            this.println(rowStr);
        }
    }

    /**
     * Prints a message and changes line
     */
    public println(message: string): void {
        this.print(message + "\n");
    }

    /**
     * Return a promise that will resolve when the user has completed
     * typing a single line
     */
    public read(prompt: string, continuationPrompt = "> "): Promise<string> {
        return new Promise((resolve, reject) => {
            this.term.write(prompt);
            this._activePrompt = {
                prompt, continuationPrompt, resolve, reject
            };

            this._input = "";
            this._cursor = 0;
            this._active = true;
        });
    }

    /**
     * Return a promise that will be resolved when the user types a single
     * character.
     *
     * This can be active in addition to `.read()` and will be resolved in
     * priority before it.
     */
    public readChar(prompt: string): Promise<any> {
        return new Promise((resolve, reject) => {
            this.term.write(prompt);
            this._activeCharPrompt = {
                prompt,
                resolve,
                reject
            };
        });
    }

    /**
     * Remove a previously registered auto-complete handler
     */
    public removeAutocompleteHandler(fn: CompletionFn): void {
        const idx = this._autocompleteHandlers.findIndex(e => e.fn === fn);
        if (idx === -1) {
            return;
        }

        this._autocompleteHandlers.splice(idx, 1);
    }

    /**
     * Advances the `offset` as required in order to accompany the prompt
     * additions to the input.
     */
    private applyPromptOffset(input: string, offset: number): number {
        const newInput = this.applyPrompts(input.substr(0, offset));
        return stringLength(newInput);
    }

    /**
     * Apply prompts to the given input
     */
    private applyPrompts(input: string): string {
        return this.activePrompt
            + input.replace(/\n/g, "\n" + this.continuationPrompt);
    }

    /**
     * Clears the current prompt
     *
     * This function will erase all the lines that display the current prompt
     * and move the cursor in the beginning of the first line of the prompt.
     */
    private clearInput(): void {
        const currentPrompt = this.applyPrompts(this._input);

        // Get the overall number of lines to clear
        const allRows = countLines(currentPrompt, this._termSize.cols);

        // Get the line we are currently in
        const promptCursor = this.applyPromptOffset(this._input, this._cursor);
        const {row} = offsetToColRow(
            currentPrompt,
            promptCursor,
            this._termSize.cols
        );

        // First move on the last line
        const moveRows = allRows - row - 1;
        for (let i = 0; i < moveRows; ++i) {
            this.term.write("\x1B[E");
        }

        // Clear current input line(s)
        this.term.write("\r\x1B[K");
        for (let i = 1; i < allRows; ++i) {
            this.term.write("\x1B[F\x1B[K");
        }
    }

    /**
     * Erase a character at cursor location
     */
    private handleCursorErase(backspace: boolean): void {
        const {_cursor, _input} = this;
        if (backspace) {
            if (_cursor <= 0) {
                return;
            }
            const newInput = _input.substr(0, _cursor - 1) +
                _input.substr(_cursor);
            this.clearInput();
            this._cursor -= 1;
            this.setInput(newInput, false);
        } else {
            const newInput = _input.substr(0, _cursor) +
                _input.substr(_cursor + 1);
            this.setInput(newInput);
        }
    }

    /**
     * Insert character at cursor location
     */
    private handleCursorInsert(data: string): void {
        const {_cursor, _input} = this;
        const newInput = _input.substr(0, _cursor) + data +
            _input.substr(_cursor);
        this._cursor += data.length;
        this.setInput(newInput);
    }

    /**
     * Move cursor at given direction
     */
    private handleCursorMove(dir: number): void {
        if (dir > 0) {
            const num = Math.min(dir, this._input.length - this._cursor);
            this.setCursor(this._cursor + num);
        } else if (dir < 0) {
            const num = Math.max(dir, -this._cursor);
            this.setCursor(this._cursor + num);
        }
    }

    /**
     * Handle a single piece of information from the terminal.
     */
    private handleData(data: string): void {
        if (!this._active) {
            return;
        }
        const ord = data.charCodeAt(0);
        let ofs;

        // Handle ANSI escape sequences
        if (ord == 0x1b) {
            switch (data.substr(1)) {
                case "[A": // Up arrow
                    if (this.history) {
                        let value = this.history.getPrevious();
                        if (value) {
                            this.setInput(value);
                            this.setCursor(value.length);
                        }
                    }
                    break;

                case "[B": // Down arrow
                    if (this.history) {
                        let value = this.history.getNext();
                        if (!value) {
                            value = "";
                        }
                        this.setInput(value);
                        this.setCursor(value.length);
                    }
                    break;

                case "[D": // Left Arrow
                    this.handleCursorMove(-1);
                    break;

                case "[C": // Right Arrow
                    this.handleCursorMove(1);
                    break;

                case "[3~": // Delete
                    this.handleCursorErase(false);
                    break;

                case "[F": // End
                    this.setCursor(this._input.length);
                    break;

                case "[H": // Home
                    this.setCursor(0);
                    break;

                case "b": // ALT + LEFT
                    ofs = closestLeftBoundary(this._input, this._cursor);
                    if (ofs != null) {
                        this.setCursor(ofs);
                    }
                    break;

                case "f": // ALT + RIGHT
                    ofs = closestRightBoundary(this._input, this._cursor);
                    if (ofs != null) {
                        this.setCursor(ofs);
                    }
                    break;

                case "\x7F": // CTRL + BACKSPACE
                    ofs = closestLeftBoundary(this._input, this._cursor);
                    if (ofs != null) {
                        this.setInput(
                            this._input.substr(0, ofs) +
                            this._input.substr(this._cursor)
                        );
                        this.setCursor(ofs);
                    }
                    break;
            }

            // Handle special characters
        } else if (ord < 32 || ord === 0x7f) {
            switch (data) {
                case "\r": // ENTER
                    if (isIncompleteInput(this._input)) {
                        this.handleCursorInsert("\n");
                    } else {
                        this.handleReadComplete();
                    }
                    break;

                case "\x7F": // BACKSPACE
                    this.handleCursorErase(true);
                    break;

                case "\t": // TAB
                    if (this._autocompleteHandlers.length > 0) {
                        const inputFragment = this._input.substr(0,
                            this._cursor);
                        const hasTailingSpace = hasTailingWhitespace(
                            inputFragment);
                        const candidates = collectAutocompleteCandidates(
                            this._autocompleteHandlers,
                            inputFragment
                        );

                        // Sort candidates
                        candidates.sort();

                        // Depending on the number of candidates, we are
                        // handing them in a different way.
                        if (candidates.length === 0) {
                            // No candidates? Just add a space if there is none
                            // already
                            if (!hasTailingSpace) {
                                this.handleCursorInsert(" ");
                            }
                        } else if (candidates.length === 1) {
                            // Just a single candidate? Complete
                            const lastToken = getLastToken(inputFragment);
                            this.handleCursorInsert(
                                candidates[0].substr(lastToken.length) + " "
                            );
                        } else if (candidates.length <=
                            this.maxAutocompleteEntries) {
                            // If we are less than maximum auto-complete
                            // candidates, print them to the user and re-start
                            // prompt
                            this.printAndRestartPrompt(() => this.printWide(
                                candidates));
                        } else {
                            // If we have more than maximum auto-complete
                            // candidates, print them only if the user
                            // acknowledges a warning
                            this.printAndRestartPrompt(() =>
                                this.readChar(
                                    `Display all ${candidates.length} possibilities? (y or n)`
                                ).then(yn => {
                                    if (yn == "y" || yn == "Y") {
                                        this.printWide(candidates);
                                    }
                                })
                            );
                        }
                    } else {
                        this.handleCursorInsert("    ");
                    }
                    break;

                case "\x03": // CTRL+C
                    this.setCursor(this._input.length);
                    this.term.write("^C\r\n" + this.activePrompt);
                    this._input = "";
                    this._cursor = 0;
                    if (this.history) {
                        this.history.rewind();
                    }
                    break;
            }

            // Handle visible characters
        } else {
            this.handleCursorInsert(data);
        }
    }

    /**
     * Handle input completion
     */
    private handleReadComplete(): void {
        if (this.history) {
            this.history.push(this._input);
        }
        if (this._activePrompt) {
            this._activePrompt.resolve(this._input);
            this._activePrompt = null;
        }
        this.term.write("\r\n");
        this._active = false;
    }

    /**
     * Handle terminal input
     */
    private handleTermData(data: string): void {
        if (!this._active) {
            return;
        }

        // If we have an active character prompt, satisfy it in priority
        if (this._activeCharPrompt) {
            this._activeCharPrompt.resolve(data);
            this._activeCharPrompt = null;
            this.term.write("\r\n");
            return;
        }

        // If this looks like a pasted input, expand it
        if (data.length > 3 && data.charCodeAt(0) !== 0x1b) {
            const normData = data.replace(/[\r\n]+/g, "\r");
            Array.from(normData).forEach(c => this.handleData(c));
        } else {
            this.handleData(data);
        }
    }

    /**
     * Handle terminal resize
     *
     * This function clears the prompt using the previous configuration,
     * updates the cached terminal size information and then re-renders the
     * input. This leads (most of the times) into a better formatted input.
     */
    private handleTermResize(data: TerminalSize): void {
        const {rows, cols} = data;
        this.clearInput();
        this._termSize = {cols, rows};
        this.setInput(this._input, false);
    }

    /**
     * This function completes the current input, calls the given callback
     * and then re-displays the prompt.
     */
    private printAndRestartPrompt(callback: () => Promise<void> | void): void {
        const cursor = this._cursor;

        // Complete input
        this.setCursor(this._input.length);
        this.term.write("\r\n");

        // Prepare a function that will resume prompt
        const resume = () => {
            this._cursor = cursor;
            this.setInput(this._input);
        };

        // Call the given callback to echo something, and if there is a promise
        // returned, wait for the resolution before resuming prompt.
        const ret = callback();
        if (ret == null) {
            resume();
        } else {
            ret.then(resume);
        }
    }

    /**
     * Set the new cursor position, as an offset on the input string
     *
     * This function:
     * - Calculates the previous and current
     */
    private setCursor(newCursor: number): void {
        if (newCursor < 0) {
            newCursor = 0;
        }
        if (newCursor > this._input.length) {
            newCursor = this._input.length;
        }

        // Apply prompt formatting to get the visual status of the display
        const inputWithPrompt = this.applyPrompts(this._input);

        // Estimate previous cursor position
        const prevPromptOffset = this.applyPromptOffset(this._input,
            this._cursor);
        const {col: prevCol, row: prevRow} = offsetToColRow(
            inputWithPrompt,
            prevPromptOffset,
            this._termSize.cols
        );

        // Estimate next cursor position
        const newPromptOffset = this.applyPromptOffset(this._input, newCursor);
        const {col: newCol, row: newRow} = offsetToColRow(
            inputWithPrompt,
            newPromptOffset,
            this._termSize.cols
        );

        // Adjust vertically
        if (newRow > prevRow) {
            for (let i = prevRow; i < newRow; ++i) {
                this.term.write("\x1B[B");
            }
        } else {
            for (let i = newRow; i < prevRow; ++i) {
                this.term.write("\x1B[A");
            }
        }

        // Adjust horizontally
        if (newCol > prevCol) {
            for (let i = prevCol; i < newCol; ++i) {
                this.term.write("\x1B[C");
            }
        } else {
            for (let i = newCol; i < prevCol; ++i) {
                this.term.write("\x1B[D");
            }
        }

        // Set new offset
        this._cursor = newCursor;
    }

    /**
     * Replace input with the new input given
     *
     * This function clears all the lines that the current input occupies and
     * then replaces them with the new input.
     */
    private setInput(newInput: string, clearInput = true): void {
        let i
        // Clear current input
        if (clearInput) {
            this.clearInput();
        }

        // Write the new input lines, including the current prompt
        const newPrompt = this.applyPrompts(newInput);
        this.print(newPrompt);

        // Trim cursor overflow
        if (this._cursor > newInput.length) {
            this._cursor = newInput.length;
        }

        // Move the cursor to the appropriate row/col
        const newCursor = this.applyPromptOffset(newInput, this._cursor);
        const newLines = countLines(newPrompt, this._termSize.cols);
        const {col, row} = offsetToColRow(
            newPrompt,
            newCursor,
            this._termSize.cols
        );
        const moveUpRows = newLines - row - 1;

        this.term.write("\r");
        for (i = 0; i < moveUpRows; ++i) {
            this.term.write("\x1B[F");
        }
        for (i = 0; i < col; ++i) {
            this.term.write("\x1B[C");
        }

        // Replace input
        this._input = newInput;
    }
}
