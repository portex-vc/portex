import { existsSync, readFileSync, rmSync } from "node:fs";
import { API_PORT, ANVIL_PORT, PID_FILE, WEB_PORT } from "./env";

/** Stop only the child processes recorded by this test run. */
export default async function globalTeardown(): Promise<void> {
  if (process.env.PORTEX_E2E_KEEP_STACK === "1") {
    console.log("[e2e teardown] owned isolated stack retained for inspection");
    return;
  }
  if (existsSync(PID_FILE)) {
    try {
      for (const pid of JSON.parse(readFileSync(PID_FILE, "utf8")) as number[]) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    } catch {
      /* A corrupt pid file never authorizes stopping unrelated listeners. */
    }
    rmSync(PID_FILE, { force: true });
  }
  console.log(`[e2e teardown] ports ${ANVIL_PORT}/${API_PORT}/${WEB_PORT} are free`);
}
