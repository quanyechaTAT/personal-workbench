export class AsyncEventQueue<T> implements AsyncIterable<T> {
	private readonly values: T[] = [];
	private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
	private closed = false;

	push(value: T): void {
		if (this.closed) return;
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter({ done: false, value });
			return;
		}
		this.values.push(value);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const waiter of this.waiters.splice(0)) {
			waiter({ done: true, value: undefined });
		}
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return {
			next: () => {
				const value = this.values.shift();
				if (value !== undefined) return Promise.resolve({ done: false, value });
				if (this.closed) return Promise.resolve({ done: true, value: undefined });
				return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
			},
		};
	}
}
