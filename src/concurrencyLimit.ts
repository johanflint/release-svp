// A minimal concurrency limiter: at most `max` operations submitted via run() execute at once; any beyond that
// queue up and run as slots free. Deliberately tiny and dependency-free (no p-limit/p-queue) — this codebase has
// exactly one narrow use case (bounding GitHub GraphQL follow-up pagination bursts, see github.ts) that doesn't
// warrant an external library.
export class ConcurrencyLimit {
    private active = 0;
    private readonly waiters: (() => void)[] = [];

    constructor(private readonly max: number) {}

    async run<T>(operation: () => Promise<T>): Promise<T> {
        if (this.active >= this.max) {
            await new Promise<void>(resolve => this.waiters.push(resolve));
        } else {
            this.active++;
        }

        try {
            return await operation();
        } finally {
            const next = this.waiters.shift();
            if (next) {
                next(); // Hand the freed slot directly to the next waiter; `active` count is unchanged.
            } else {
                this.active--;
            }
        }
    }
}
