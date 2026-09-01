import { describe, expect, it } from "vitest";
import { ConcurrencyLimit } from "../src/concurrencyLimit";

// A controllable "task": resolves only when its own `release()` is called, and records when it actually started
// running (as opposed to merely being queued) by pushing onto the shared `started` array.
function deferredTask(started: number[], id: number): { promise: () => Promise<void>; release: () => void } {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    return {
        promise: async () => {
            started.push(id);
            await gate;
        },
        release,
    };
}

describe("ConcurrencyLimit", () => {
    it("runs operations up to the limit immediately, queueing the rest", async () => {
        const limit = new ConcurrencyLimit(2);
        const started: number[] = [];
        const tasks = [1, 2, 3, 4].map(id => deferredTask(started, id));

        const results = tasks.map(task => limit.run(task.promise));
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(started).toEqual([1, 2]); // Only the first 2 (the limit) have actually started.

        tasks[0].release();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(started).toEqual([1, 2, 3]); // Freeing a slot starts the next queued task.

        tasks[1].release();
        tasks[2].release();
        tasks[3].release();
        await Promise.all(results);
        expect(started).toEqual([1, 2, 3, 4]);
    });

    it("propagates a rejection from a limited operation to its caller", async () => {
        const limit = new ConcurrencyLimit(1);
        await expect(limit.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    });

    it("frees the slot for the next queued operation even if the running one rejects", async () => {
        const limit = new ConcurrencyLimit(1);
        const first = limit.run(async () => { throw new Error("boom"); });
        const second = limit.run(async () => "done");

        await expect(first).rejects.toThrow("boom");
        await expect(second).resolves.toBe("done");
    });

    it("runs operations directly (no queueing) when under the limit", async () => {
        const limit = new ConcurrencyLimit(5);
        const results = await Promise.all([1, 2, 3].map(id => limit.run(async () => id)));
        expect(results).toEqual([1, 2, 3]);
    });
});
