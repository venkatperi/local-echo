export interface LocalEchoControllerOptions {
    // The maximum number of entries to keep in history
    historySize?: number

    // The maximum number of auto-complete entries, after which the user
    // will have to confirm before the entries are displayed.
    maxAutocompleteEntries?: number
}
