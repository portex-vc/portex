/**
 * End-to-end: anvil on :8548 -> deploy contracts -> boot the backend -> create a raise ->
 * clustered deposits (one whale funds 5 wallets) -> feedback + metadata signatures ->
 * POST /analyze -> heuristic veto stored AND posted on-chain via AttestationBoard.
 *
 * Stops its own anvil/backend and retains the isolated fixture database for diagnosis.
 */
import { test, expect } from 'bun:test';
import { spawn, spawnSync, type Subprocess } from 'bun';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import {
  createPublicClient, createWalletClient, http, decodeEventLog, getAddress,
  type Address, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ANVIL_ACCOUNTS } from '../src/config.ts';
import { makeChain } from '../src/chain.ts';
import {
  RaiseFactoryAbi, RaiseAbi, MockUSDGAbi, AttestationBoardAbi,
} from '../src/generated/abis.ts';
import { feedbackMessage, metadataMessage } from '../src/signatures.ts';
import { signedRequestMessage } from '../src/lib/signed-request.ts';

const RPC = 'http://127.0.0.1:8548';
const API = 'http://127.0.0.1:8791';
const BACKEND_DIR = `${import.meta.dir}/..`;
mkdirSync(`${BACKEND_DIR}/data`, { recursive: true });
const FIXTURE_DIR = mkdtempSync(`${BACKEND_DIR}/data/test-v1-`);
const DB_PATH = `${FIXTURE_DIR}/integration.db`;
const FOUNDRY = `${process.env.HOME}/.foundry/bin`;

const chain = makeChain({ chainId: 31337, rpcUrl: RPC } as never);
const publicClient = createPublicClient({ chain, transport: http(RPC) });

function wallet(index: number) {
  const account = privateKeyToAccount(ANVIL_ACCOUNTS[index].privateKey as Hex);
  return { account, client: createWalletClient({ account, chain, transport: http(RPC) }) };
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try { if (await fn()) return; } catch (err) { lastErr = err; }
    await Bun.sleep(300);
  }
  throw new Error(`timed out waiting for ${what}${lastErr ? ` (last error: ${lastErr})` : ''}`);
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API}${path}`, init);
}

/** A request signed with the Portex signed-request scheme (X-Portex-* headers). */
async function signedApi(
  path: string, body: unknown, account: { address: Address; signMessage: (a: { message: string }) => Promise<Hex> },
  method = 'POST',
): Promise<Response> {
  const bodyText = JSON.stringify(body ?? {});
  const ts = Math.floor(Date.now() / 1000);
  const signature = await account.signMessage({ message: signedRequestMessage(method, path, ts, bodyText) });
  return api(path, {
    method,
    headers: {
      'content-type': 'application/json',
      'X-Portex-Address': account.address,
      'X-Portex-Signature': signature,
      'X-Portex-Ts': String(ts),
    },
    body: bodyText,
  });
}

const usdg = (n: number) => BigInt(n) * 10n ** 6n;

test('integration: deploy, index, clustered deposits, analyze -> on-chain veto', async () => {
  let anvil: Subprocess | null = null;
  let server: Subprocess | null = null;
  try {
    // ---- 1. anvil on 8548 ----------------------------------------------------
    anvil = spawn([`${FOUNDRY}/anvil`, '--port', '8548', '--chain-id', '31337', '--silent'], {
      stdout: 'ignore', stderr: 'inherit',
    });
    await waitFor(async () => (await publicClient.getChainId()) === 31337, 15_000, 'anvil to start');

    // ---- 2. deploy contracts --------------------------------------------------
    const deploy = spawnSync({
      cmd: ['bash', '../../packages/contracts/scripts/deploy-local.sh'],
      cwd: BACKEND_DIR,
      env: { ...process.env, PATH: `${FOUNDRY}:${process.env.PATH}`, RPC_URL: RPC, DEPLOY_WORKSPACE: FIXTURE_DIR },
      timeout: 240_000,
    });
    expect(deploy.exitCode).toBe(0);

    const dep = JSON.parse(readFileSync(`${FIXTURE_DIR}/deployments/31337.json`, 'utf8')) as Record<string, string | number>;

    // ---- 3. backend -----------------------------------------------------------
    server = spawn(['bun', '--no-env-file', 'run', 'src/server.ts'], {
      cwd: BACKEND_DIR,
      stdout: 'inherit', stderr: 'inherit',
      env: {
        ...process.env,
        RPC_URL: RPC,
        PORTEX_CHAIN_ID: '31337',
        PORT: '8791',
        PUBLIC_API_URL: API,
        DATABASE_PATH: DB_PATH,
        PORTEX_DEPLOYMENTS_DIR: `${FIXTURE_DIR}/deployments`,
        POLL_MS: '250',
        CONFIRMATIONS: '0',
      },
    });
    await waitFor(async () => {
      const res = await api('/v1/health');
      if (!res.ok) return false;
      const body = await res.json() as { ok: boolean };
      return body.ok === true;
    }, 30_000, 'backend health');

    // ---- 4. create a raise (builder = anvil #3) -------------------------------
    const builder = wallet(3);
    const templateId = dep.templateZeroExtraction as Hex;
    const cfg = {
      quoteAsset: dep.mockUSDG as Address,
      softCap: usdg(1_000),
      hardCap: usdg(200_000),
      minIncubation: 600,
      deadline: 1800,
      totalSupply: 100_000_000n * 10n ** 18n,
      stage1Alloc: 20_000_000n * 10n ** 18n,
      stage2Inventory: 40_000_000n * 10n ** 18n,
      vaultAlloc: 10_000_000n * 10n ** 18n,
      builderAlloc: 30_000_000n * 10n ** 18n,
      commitmentWindow: 300,
      epochLength: 300,
      numTranches: 4,
      minOptInBps: 3000,
      swapFeeBps: 100,
      feeReserveBps: 4000,
      feeVaultBps: 3000,
      feeBuilderBps: 3000,
      minGraduationLiquidity: usdg(20_000),
      minRealRatioBps: 5000,
      builderVesting: 1200,
      vaultDuration: 1200,
      vetoMaxDelay: 300,
      vetoCooldown: 600,
      maxCumulativeSpendBps: 0,
      governor: { votingPeriod: 300, disputeWindow: 300, minProposalInterval: 600, quorumBps: 4000, approvalBps: 6000 },
    };
    const createTx = await builder.client.writeContract({
      address: dep.factory as Address, abi: RaiseFactoryAbi, functionName: 'createRaise',
      args: [templateId, 1, cfg, { name: 'ClusterCoin', symbol: 'CLSTR' }] as never,
      account: builder.account, chain,
    });
    const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createTx });
    let raiseAddress: Address | null = null;
    for (const log of createReceipt.logs) {
      try {
        const d = decodeEventLog({ abi: RaiseFactoryAbi, data: log.data, topics: log.topics });
        if (d.eventName === 'RaiseCreated') raiseAddress = getAddress((d.args as { raise: string }).raise);
      } catch { /* not a factory event */ }
    }
    expect(raiseAddress).not.toBeNull();
    const raise = raiseAddress!;

    // ---- 5. clustered deposits: whale (#9) funds 5 wallets --------------------
    const whale = wallet(9);
    const deployer = wallet(0);
    await deployer.client.writeContract({
      address: dep.mockUSDG as Address, abi: MockUSDGAbi, functionName: 'mint',
      args: [whale.account.address, usdg(10_000)], account: deployer.account, chain,
    });
    const backerIdx = [4, 5, 6, 7, 8];
    for (const i of backerIdx) {
      const b = wallet(i);
      const transferTx = await whale.client.writeContract({
        address: dep.mockUSDG as Address, abi: MockUSDGAbi, functionName: 'transfer',
        args: [b.account.address, usdg(1_000)], account: whale.account, chain,
      });
      await publicClient.waitForTransactionReceipt({ hash: transferTx });
      const approveTx = await b.client.writeContract({
        address: dep.mockUSDG as Address, abi: MockUSDGAbi, functionName: 'approve',
        args: [raise, usdg(1_000)], account: b.account, chain,
      });
      await publicClient.waitForTransactionReceipt({ hash: approveTx });
      const depositTx = await b.client.writeContract({
        address: raise, abi: RaiseAbi, functionName: 'deposit',
        args: [usdg(1_000)], account: b.account, chain,
      });
      await publicClient.waitForTransactionReceipt({ hash: depositTx });
    }

    // ---- 6. indexer catches up --------------------------------------------------
    await waitFor(async () => {
      const res = await api(`/v1/raises/${raise}`);
      if (!res.ok) return false;
      const body = await res.json() as { backers: number };
      return body.backers === 5;
    }, 30_000, 'indexer to see 5 backers');

    // ---- 7. read API shape --------------------------------------------------------
    const detail = await (await api(`/v1/raises/${raise}`)).json() as any;
    expect(detail.name).toBe('ClusterCoin');
    expect(detail.symbol).toBe('CLSTR');
    expect(detail.state).toBe('Incubation');
    expect(detail.totalPrincipal).toBe(usdg(5_000).toString());
    expect(detail.escrowedPrincipal).toBe(usdg(5_000).toString());
    expect(detail.backers).toBe(5);
    expect(detail.bookPrice).toBeNull();
    expect(detail.vetoActive).toBe(false);
    expect(detail.builder).toBe(builder.account.address);
    expect(detail.template).toEqual({ id: templateId.toLowerCase(), name: 'ZERO_EXTRACTION', version: 1 });
    expect(detail.gates.commitment.capitalMet).toBe(true);
    expect(detail.gates.commitment.principalNow).toBe(usdg(5_000).toString());
    expect(detail.times.numTranches).toBe(4);
    expect(detail.config.softCap).toBe(usdg(1_000).toString());

    const list = await (await api('/v1/raises')).json() as any[];
    expect(list.some((r) => r.address === raise)).toBe(true);

    const backer4 = wallet(4);
    const position = await (await api(`/v1/raises/${raise}/positions/${backer4.account.address}`)).json() as any;
    expect(position.principal).toBe(usdg(1_000).toString());
    expect(position.tranches).toHaveLength(4);
    expect(position.tranches.every((t: { state: string }) => t.state === 'Locked')).toBe(true);
    expect(position.walletQuoteBalance).toBe('0');

    // ---- 8. feedback with EIP-191 signature ----------------------------------------
    const fbText = 'Deposits and withdrawals both worked in my testing.';
    const fbSig = await backer4.account.signMessage({ message: feedbackMessage(raise, 4, fbText) });
    const fbRes = await api(`/v1/raises/${raise}/feedback`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: backer4.account.address, rating: 4, text: fbText, signature: fbSig }),
    });
    expect(fbRes.status).toBe(201);
    const fb = await fbRes.json() as { isBacker: boolean };
    expect(fb.isBacker).toBe(true);

    const fbList = await (await api(`/v1/raises/${raise}/feedback`)).json() as { author: string; text: string }[];
    expect(fbList).toHaveLength(1);
    expect(fbList[0].author).toBe(backer4.account.address);
    expect(fbList[0].text).toBe(fbText);

    // bad signature rejected
    const badRes = await api(`/v1/raises/${raise}/feedback`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: backer4.account.address, rating: 4, text: 'forged', signature: fbSig }),
    });
    expect(badRes.status).toBe(401);

    // ---- 9. builder-signed metadata -------------------------------------------------
    const metaSig = await builder.account.signMessage({ message: metadataMessage(raise, 'A clustered test raise.', '') });
    const metaRes = await api(`/v1/raises/${raise}/metadata`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'A clustered test raise.', signature: metaSig }),
    });
    expect(metaRes.status).toBe(200);
    const detail2 = await (await api(`/v1/raises/${raise}`)).json() as { description: string };
    expect(detail2.description).toBe('A clustered test raise.');

    // non-builder metadata rejected
    const metaBad = await api(`/v1/raises/${raise}/metadata`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'hijack', signature: await backer4.account.signMessage({ message: metadataMessage(raise, 'hijack', '') }) }),
    });
    expect(metaBad.status).toBe(401);

    // new signed-request scheme (headers) also works for metadata
    const metaNew = await signedApi(`/v1/raises/${raise}/metadata`, { description: 'A clustered test raise.', website: '' }, builder.account);
    expect(metaNew.status).toBe(200);
    const metaNewBad = await signedApi(`/v1/raises/${raise}/metadata`, { description: 'hijack' }, backer4.account);
    expect(metaNewBad.status).toBe(403);

    // ---- 10. analyze: heuristic veto, stored + posted on-chain ------------------------
    // unsigned analyze is rejected (signed-request scheme)
    const unsignedRes = await api(`/v1/raises/${raise}/analyze`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(unsignedRes.status).toBe(400);

    // builder-signed analyze: always allowed, never rate-limited
    const analyzeRes = await signedApi(`/v1/raises/${raise}/analyze`, {}, builder.account);
    expect(analyzeRes.status).toBe(200);
    const report = await analyzeRes.json() as {
      riskScoreBps: number; veto: boolean; postedTx: string | null; reportHash: string;
      uri: string; findings: { severity: string; title: string }[];
      metrics: Record<string, number | string>;
      panel: { scorer: string; veto: boolean }[];
    };
    expect(report.veto).toBe(true);
    expect(report.riskScoreBps).toBeGreaterThanOrEqual(5000);
    expect(report.metrics.clusterShareBps).toBe(10_000);
    expect(report.findings.some((f) => f.title === 'Several wallets funded by one address' && f.severity === 'critical')).toBe(true);
    expect(report.panel.length).toBeGreaterThanOrEqual(1);
    expect(report.reportHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(report.uri).toBe(`${API}/v1/raises/${raise}/reports#${report.reportHash}`);
    expect(report.postedTx).toMatch(/^0x[0-9a-f]{64}$/);

    // on-chain attestation
    const [onChain, vetoActive] = await Promise.all([
      publicClient.readContract({
        address: dep.attestationBoard as Address, abi: AttestationBoardAbi, functionName: 'getReport', args: [raise],
      }),
      publicClient.readContract({
        address: dep.attestationBoard as Address, abi: AttestationBoardAbi, functionName: 'vetoActive', args: [raise],
      }),
    ]);
    expect(onChain.reportHash).toBe(report.reportHash as `0x${string}`);
    expect(onChain.veto).toBe(true);
    expect(onChain.uri).toBe(report.uri);
    expect(vetoActive).toBe(true);

    // report endpoints
    const latest = await (await api(`/v1/raises/${raise}/report`)).json() as { reportHash: string } | null;
    expect(latest?.reportHash).toBe(report.reportHash);
    const reportsBefore = await (await api(`/v1/raises/${raise}/reports`)).json() as { builderResponse: unknown }[];
    expect(reportsBefore).toHaveLength(1);
    expect(reportsBefore[0].builderResponse).toBeNull();

    // public path: any signed address, once per raise per 10 minutes (overwrites the on-chain latest)
    const pub1 = await signedApi(`/v1/raises/${raise}/analyze`, {}, backer4.account);
    expect(pub1.status).toBe(200);
    const pub2 = await signedApi(`/v1/raises/${raise}/analyze`, {}, wallet(5).account);
    expect(pub2.status).toBe(429);
    const all = await (await api(`/v1/raises/${raise}/reports`)).json() as unknown[];
    expect(all).toHaveLength(2); // builder run + one public run

    // summary shows risk + veto once the indexer has seen the ReportPosted event
    await waitFor(async () => {
      const d = await (await api(`/v1/raises/${raise}`)).json() as { vetoActive: boolean };
      return d.vetoActive === true;
    }, 15_000, 'indexer to index ReportPosted');
    const detail3 = await (await api(`/v1/raises/${raise}`)).json() as { riskScoreBps: number; vetoActive: boolean; latestReport: { veto: boolean } };
    expect(detail3.vetoActive).toBe(true);
    expect(detail3.riskScoreBps).toBe(report.riskScoreBps);
    expect(detail3.latestReport.veto).toBe(true);

    // ---- 10b. builder response to a report --------------------------------------------
    const respRes = await signedApi(`/v1/raises/${raise}/reports/${report.reportHash}/response`, {
      text: 'These five wallets were funded from one test wallet for the demo — acknowledged.',
    }, builder.account);
    expect(respRes.status).toBe(200);
    const responded = await respRes.json() as { builderResponse: { text: string; createdAt: number } };
    expect(responded.builderResponse.text).toContain('acknowledged');
    const nonBuilderResp = await signedApi(`/v1/raises/${raise}/reports/${report.reportHash}/response`, { text: 'fake' }, backer4.account);
    expect(nonBuilderResp.status).toBe(403);
    const missingResp = await signedApi(`/v1/raises/${raise}/reports/0x${'00'.repeat(32)}/response`, { text: 'x' }, builder.account);
    expect(missingResp.status).toBe(404);

    // ---- 10c. builder profile + updates -------------------------------------------------
    const profRes = await signedApi(`/v1/raises/${raise}/profile`, {
      name: 'ClusterCoin', tagline: 'a clustered test raise', description: 'A clustered test raise.',
      website: 'https://cluster.example.dev', twitter: '@clustercoin', github: '', docs: '',
    }, builder.account, 'PUT');
    expect(profRes.status).toBe(200);
    const detailP = await (await api(`/v1/raises/${raise}`)).json() as {
      description: string; profile: { tagline: string; twitter: string; description: string };
    };
    expect(detailP.description).toBe('A clustered test raise.'); // kept at top level for compatibility
    expect(detailP.profile.tagline).toBe('a clustered test raise');
    expect(detailP.profile.twitter).toBe('@clustercoin');
    const profBad = await signedApi(`/v1/raises/${raise}/profile`, {
      tagline: 'hijack', description: 'hijack', website: '', twitter: '', github: '', docs: '',
    }, backer4.account, 'PUT');
    expect(profBad.status).toBe(403);
    const profInvalid = await signedApi(`/v1/raises/${raise}/profile`, {
      tagline: 'x', description: 'y', website: 'javascript:alert(1)', twitter: '', github: '', docs: '',
    }, builder.account, 'PUT');
    expect(profInvalid.status).toBe(400);

    const updRes = await signedApi(`/v1/raises/${raise}/updates`, {
      title: 'First milestone reached', body: 'The test milestone is done.', kind: 'milestone',
    }, builder.account);
    expect(updRes.status).toBe(201);
    const updates = await (await api(`/v1/raises/${raise}/updates`)).json() as { title: string; kind: string }[];
    expect(updates).toHaveLength(1);
    expect(updates[0].title).toBe('First milestone reached');
    const updBad = await signedApi(`/v1/raises/${raise}/updates`, { title: 'x', body: 'y', kind: 'milestone' }, backer4.account);
    expect(updBad.status).toBe(403);

    // ---- 10d. protocol read endpoint ------------------------------------------------------
    const protocol = await (await api('/v1/protocol')).json() as {
      chainId: number; registry: string; factory: string; board: string;
      templates: {
        name: string; version: number; bundleHash: string; deprecated: boolean;
        dexAdapter: string | null;
        implementations: Record<string, { address: string; codehash: string | null } | null>;
      }[];
      quoteAssets: { address: string; symbol: string; decimals: number }[];
      roles: { curator: string; attester: string; council: string };
      veto: { vetoMaxDelay: number; vetoCooldown: number; raises: number }[];
      counts: { raises: Record<string, number>; totalEscrowed: string; totalBackers: number };
    };
    expect(protocol.chainId).toBe(31337);
    expect(protocol.factory).toBe(getAddress(dep.factory as string));
    expect(protocol.roles.curator).toBe(ANVIL_ACCOUNTS[0].address);
    expect(protocol.roles.attester).toBe(ANVIL_ACCOUNTS[1].address);
    expect(protocol.roles.council).toBe(ANVIL_ACCOUNTS[2].address);
    const ze = protocol.templates.find((t) => t.name === 'ZERO_EXTRACTION' && t.version === 1);
    expect(ze).toBeDefined();
    expect(ze!.bundleHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(ze!.deprecated).toBe(false);
    expect(ze!.implementations.raise!.codehash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(ze!.implementations.governor).toBeNull();
    const ms = protocol.templates.find((t) => t.name === 'MILESTONE_FUNDING' && t.version === 1);
    expect(ms).toBeDefined();
    expect(ms!.implementations.governor!.codehash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(protocol.quoteAssets.some((qa) => qa.symbol === 'USDG')).toBe(true);
    expect(protocol.counts.raises.Incubation).toBe(1);
    expect(protocol.counts.totalEscrowed).toBe(usdg(5_000).toString());
    expect(protocol.counts.totalBackers).toBe(5);
    expect(protocol.veto).toContainEqual({ vetoMaxDelay: 300, vetoCooldown: 600, raises: 1 });

    // ---- 10e. per-user inbox ----------------------------------------------------------------
    const inbox = await (await api(`/v1/users/${backer4.account.address}/inbox`)).json() as {
      user: string; now: number; items: { type: string; severity: string; raise: string }[];
    };
    expect(inbox.user).toBe(backer4.account.address);
    expect(inbox.now).toBeGreaterThan(0);
    expect(inbox.items).toEqual([]); // Incubation position: nothing actionable yet
    const inboxBad = await api('/v1/users/not-an-address/inbox');
    expect(inboxBad.status).toBe(400);

    // activity feed contains the deposits, the report and the builder update
    const activity = await (await api(`/v1/raises/${raise}/activity`)).json() as { kind: string }[];
    expect(activity.some((a) => a.kind === 'Deposited')).toBe(true);
    expect(activity.some((a) => a.kind === 'ReportPosted')).toBe(true);
    expect(activity.some((a) => a.kind === 'BuilderUpdate')).toBe(true);

    // ---- 11. dev endpoints ------------------------------------------------------------
    const accounts = await (await api('/v1/dev/accounts')).json() as { index: number; address: string; privateKey: string; label: string }[];
    expect(accounts).toHaveLength(10);
    expect(accounts[0].address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    expect(accounts[1].label).toBe('attester');
    expect(accounts[9].label).toBe('whale');

    const tt = await (await api('/v1/dev/time-travel', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seconds: 120 }),
    })).json() as { now: number };
    expect(tt.now).toBeGreaterThan(0);

    const faucet = wallet(8);
    const before = await publicClient.readContract({
      address: dep.mockUSDG as Address, abi: MockUSDGAbi, functionName: 'balanceOf', args: [faucet.account.address],
    });
    const faucetRes = await api('/v1/dev/faucet', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: faucet.account.address, amount: usdg(42).toString() }),
    });
    expect(faucetRes.status).toBe(200);
    const after = await publicClient.readContract({
      address: dep.mockUSDG as Address, abi: MockUSDGAbi, functionName: 'balanceOf', args: [faucet.account.address],
    });
    expect(after - before).toBe(usdg(42));

    // config + proposals endpoints
    const config = await (await api('/v1/config')).json() as {
      chainId: number; isLocal: boolean; addresses: { factory: string };
      quote: { symbol: string; decimals: number }; templates: { id: string; name: string; version: number; deprecated: boolean }[];
    };
    expect(config.chainId).toBe(31337);
    expect(config.isLocal).toBe(true);
    expect(config.addresses.factory).toBe(getAddress(dep.factory as string));
    expect(config.quote.symbol).toBe('USDG');
    expect(config.quote.decimals).toBe(6);
    expect(config.templates).toContainEqual({ id: templateId.toLowerCase(), name: 'ZERO_EXTRACTION', version: 1, deprecated: false });

    const proposals = await (await api(`/v1/raises/${raise}/proposals`)).json() as unknown[];
    expect(proposals).toEqual([]);
  } finally {
    if (server) server.kill();
    if (anvil) anvil.kill();
  }
}, 300_000);
