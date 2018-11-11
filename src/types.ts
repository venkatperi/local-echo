export type CompletionFn = (index: number, tokens: string[],
    ...args: any[]) => string

export type CompletionHandler = {
    fn: CompletionFn
    args: any[]
}

export type TerminalSize = {
    rows: number
    cols: number
}

export type ActivePrompt = {
    prompt: string
    continuationPrompt?: string
    resolve: (value?: (PromiseLike<any> | any)) => void
    reject: (reason?: any) => void
}
