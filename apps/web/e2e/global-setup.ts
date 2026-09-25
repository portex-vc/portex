import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, openSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  API_PORT,
  API_URL,
  ANVIL_PORT,
  BUILD_SUFFIX,
  PID_FILE,
  RPC_URL,
  TMP_DIR,
  WEB_PORT,
  WEB_URL,
  TESTNET_WEB_PORT,
} from "./env";
const ROOT = resolve(__dirname, "../../..");
const FRONTEND = join(ROOT, "apps/web");
const API = join(ROOT, "apps/api");
const CONTRACTS = join(ROOT, "packages/contracts");
/** Workspace binaries are hoisted to the root; a package-local copy wins if one exists. */
const bin = (name: string) =>
  [join(FRONTEND, "node_modules/.bin", name), join(ROOT, "node_modules/.bin", name)].find((p) => existsSync(p)) ?? name;
function assertFree(port: number) {
  let listener = "";
  try {
    listener = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).trim();
  } catch {
    /* No listener. */
  }
  if (listener) throw new Error(`Port ${port} is occupied; refusing to stop its owner`);
}
async function waitFor(fn: () => Promise<boolean>, name: string) {
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch {
      /* Starting. */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out: ${name}`);
}
export default async function setup() {
  for (const port of [ANVIL_PORT, API_PORT, WEB_PORT, TESTNET_WEB_PORT]) assertFree(port);
  mkdirSync(TMP_DIR, { recursive: true });
  mkdirSync(join(__dirname, "screenshots"), { recursive: true });
  const run = mkdtempSync(join(TMP_DIR, "v31-"));
  const contracts = join(run, "contracts"),
    backend = join(run, "backend");
  const children: ChildProcess[] = [];
  const env = {
    ...process.env,
    NODE_OPTIONS: `--import ${join(FRONTEND, "scripts/no-dotenv.mts")}`,
    PATH: `${process.env.HOME}/.foundry/bin:${process.env.PATH}`,
    PORTEX_CHAIN_ID: "31337",
    NEXT_PUBLIC_CHAIN_ID: "31337",
    NEXT_PUBLIC_API_URL: API_URL,
    NEXT_PUBLIC_RPC_LOCAL: RPC_URL,
    RPC_URL,
    API_URL,
    DEPLOY_WORKSPACE: contracts,
    PORTEX_DEPLOYMENTS_DIR: join(contracts, "deployments"),
    PORTEX_ABI_DIR: join(contracts, "abi"),
    PORTEX_RESULTS_DIR: run,
  };
  const start = (cmd: string, args: string[], cwd: string, name: string, extra: Partial<NodeJS.ProcessEnv> = {}) => {
    const log = openSync(join(run, `${name}.log`), "a");
    const child = spawn(cmd, args, { cwd, env: { ...env, ...extra }, stdio: ["ignore", log, log] });
    children.push(child);
    writeFileSync(PID_FILE, JSON.stringify(children.map((c) => c.pid)));
    return child;
  };
  try {
    const buildLog = openSync(join(run, "build.log"), "a");
    execFileSync(bin("next"), ["build"], {
      cwd: FRONTEND,
      env: { ...env, PORTEX_BUILD_DIR: `.next-e2e${BUILD_SUFFIX}` },
      stdio: ["ignore", buildLog, buildLog],
      timeout: 300000,
    });
    execFileSync(bin("next"), ["build"], {
      cwd: FRONTEND,
      env: { ...env, NEXT_PUBLIC_CHAIN_ID: "1952", PORTEX_BUILD_DIR: `.next-testnet-e2e${BUILD_SUFFIX}` },
      stdio: ["ignore", buildLog, buildLog],
      timeout: 300000,
    });
    start(
      `${process.env.HOME}/.foundry/bin/anvil`,
      ["--port", String(ANVIL_PORT), "--chain-id", "31337", "--silent"],
      FRONTEND,
      "anvil",
    );
    await waitFor(async () => {
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      return (await res.json()).result === "0x7a69";
    }, "anvil");
    mkdirSync(contracts, { recursive: true });
    cpSync(join(CONTRACTS, "remappings.txt"), join(contracts, "remappings.txt"));
    const deployLog = openSync(join(run, "deploy.log"), "a");
    execFileSync("bash", [join(CONTRACTS, "scripts/deploy-local.sh")], {
      cwd: run,
      env,
      stdio: ["ignore", deployLog, deployLog],
      timeout: 300000,
    });
    mkdirSync(backend, { recursive: true });
    for (const entry of ["src", "scripts", "package.json", "tsconfig.json"]) {
      const source = join(API, entry);
      if (existsSync(source)) cpSync(source, join(backend, entry), { recursive: true });
    }
    // The copy resolves hoisted dependencies from the workspace root; link a package-local folder only if present.
    if (existsSync(join(API, "node_modules")))
      symlinkSync(join(API, "node_modules"), join(backend, "node_modules"), "dir");
    execFileSync("bun", ["--no-env-file", "run", "scripts/sync-abi.ts"], { cwd: backend, env, stdio: "inherit" });
    start("bun", ["--no-env-file", "run", "src/server-v2.ts"], backend, "backend", {
      PORTEX_CHAIN_ID: "31337",
      PORT: String(API_PORT),
      POLL_MS: "100",
      CORS_ORIGINS: `${WEB_URL},http://localhost:${TESTNET_WEB_PORT}`,
      PUBLIC_API_URL: API_URL,
      DATABASE_PATH: join(run, "backend.db"),
      ANTHROPIC_API_KEY: "",
      ADMIN_ADDRESSES: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    });
    await waitFor(async () => {
      const res = await fetch(`${API_URL}/v2/health`);
      return (await res.json()).ok === true;
    }, "API v2");
    const seedLog = openSync(join(run, "seed.log"), "a");
    execFileSync("bun", ["--no-env-file", "run", "e2e/seed.ts"], {
      cwd: FRONTEND,
      env,
      stdio: ["ignore", seedLog, seedLog],
      timeout: 240000,
    });
    writeFileSync(join(TMP_DIR, "runtime.json"), JSON.stringify({ run, contracts, backend }));
    start(bin("next"), ["start", "-p", String(WEB_PORT)], FRONTEND, "frontend", {
      PORTEX_BUILD_DIR: `.next-e2e${BUILD_SUFFIX}`,
    });
    await waitFor(async () => (await fetch(WEB_URL)).status === 200, "frontend");
    start(bin("next"), ["start", "-p", String(TESTNET_WEB_PORT)], FRONTEND, "testnet-frontend", {
      NEXT_PUBLIC_CHAIN_ID: "1952",
      PORTEX_BUILD_DIR: `.next-testnet-e2e${BUILD_SUFFIX}`,
    });
    await waitFor(async () => (await fetch(`http://localhost:${TESTNET_WEB_PORT}`)).status === 200, "testnet frontend");
    console.log(
      `V3.1 E2E STACK: anvil :${ANVIL_PORT} → deploy → API v2 :${API_PORT} → six v3.1 seeds → frontend :${WEB_PORT}`,
    );
    console.log(`E2E evidence: ${run}`);
  } catch (error) {
    if (process.env.PORTEX_E2E_KEEP_STACK !== "1") for (const child of children) child.kill("SIGTERM");
    throw new Error(`Isolated setup failed; inspect ${run}`, { cause: error });
  }
}
