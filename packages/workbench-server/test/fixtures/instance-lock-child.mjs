import { WorkbenchInstanceLock } from "../../dist/instance-lock.js";

await WorkbenchInstanceLock.acquire(process.argv[2]);
process.stdout.write("locked\n");
process.stdin.resume();
