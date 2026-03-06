import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withLock } from "./lock";

describe("withLock race conditions", () => {
	const testDir = path.join(os.tmpdir(), `pi-lock-race-test-${Date.now()}`);
	const lockPath = path.join(testDir, "test");

	beforeEach(() => {
		if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
	});

	it("should handle multiple concurrent attempts to acquire the lock", async () => {
		let counter = 0;
		const iterations = 20;
		const concurrentCount = 5;

		const runTask = async () => {
			for (let i = 0; i < iterations; i++) {
				await withLock(lockPath, async () => {
					const current = counter;
					// Add a small delay to increase the chance of race conditions if locking fails
					await new Promise((resolve) => setTimeout(resolve, Math.random() * 10));
					counter = current + 1;
				});
			}
		};

		const promises = [];
		for (let i = 0; i < concurrentCount; i++) {
			promises.push(runTask());
		}

		await Promise.all(promises);

		expect(counter).toBe(iterations * concurrentCount);
	});
});
