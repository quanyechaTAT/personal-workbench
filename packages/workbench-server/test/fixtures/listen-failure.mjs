import { Server } from "node:http";

const originalListen = Server.prototype.listen;
let failed = false;
Server.prototype.listen = function (...args) {
	if (!failed && args[0] === 4242) {
		failed = true;
		const code = process.env.WORKBENCH_TEST_LISTEN_ERROR ?? "EACCES";
		queueMicrotask(() => this.emit("error", Object.assign(new Error(`listen ${code}: 127.0.0.1:4242`), { code })));
		return this;
	}
	return originalListen.apply(this, args);
};
