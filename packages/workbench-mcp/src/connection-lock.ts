const queues = new Map<string, Promise<unknown>>();

/** Serialize authentication-capable operations per connection, including token refresh. */
export async function withConnectionLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
	const previous = queues.get(id) ?? Promise.resolve();
	const result = previous.catch(() => undefined).then(operation);
	queues.set(id, result);
	try {
		return await result;
	} finally {
		if (queues.get(id) === result) queues.delete(id);
	}
}
