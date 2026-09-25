/**
 * Local-only helper: create a "real user" raise from a wallet that is NOT a mock persona (anvil account #5 by
 * default), give it a profile and an update through the API, and ask the analyst for a report. Used to check that
 * the personas' AI due diligence reaches projects the mock builders did not create.
 *
 *   bun --no-env-file tools/mock/dev/user-raise.ts --rpc http://127.0.0.1:8845 --api http://localhost:9090 \
 *     --deployments <manifest> [--budget] [--stage1-minutes 20]
 */
import { readFileSync } from 'node:fs';
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  http,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { signRequest } from '@portex/api/lib/signed-request';
import { A } from '../lib/protocol';
import { sizing } from '../catalog/types';

const ANVIL_5 = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba' as Hex; // public anvil key
const args = process.argv.slice(2);
const arg = (name: string, dflt?: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const rpc = arg('--rpc', 'http://127.0.0.1:8545')!;
const api = arg('--api', 'http://localhost:8790')!.replace(/\/$/, '');
const manifest = JSON.parse(readFileSync(arg('--deployments')!, 'utf8'));
const budget = args.includes('--budget');
const account = privateKeyToAccount((process.env.USER_RAISE_KEY as Hex) || ANVIL_5);

const chain = defineChain({
  id: 31337,
  name: 'local',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [rpc] } },
});
const pub = createPublicClient({ chain, transport: http(rpc) });
if ((await pub.getChainId()) !== 31337) throw new Error('local chain (31337) only');
const wallet = createWalletClient({ account, chain, transport: http(rpc) });
const read = <T>(address: string, abi: Abi, functionName: string, a: unknown[] = []) =>
  pub.readContract({ address: address as Address, abi, functionName, args: a } as never) as Promise<T>;

const templateId = (budget ? manifest.budgetTemplate : manifest.escrowTemplate) as Hex;
const registry = A.PortexRegistryV31Abi as Abi;
const count = await read<bigint>(manifest.registry, registry, 'versionCount', [templateId]);
const version = await read<bigint>(manifest.registry, registry, 'versionAt', [templateId, count - 1n]);
const params = (await read<any>(manifest.registry, registry, 'getVersion', [templateId, version])).parameters;
const project = {
  name: budget ? 'Harborline Labs' : 'Tallowreed',
  symbol: budget ? 'HBRL' : 'TLWR',
  tagline: budget
    ? 'Berth-planning copilots for small ferry operators'
    : 'On-device visit notes for small veterinary clinics',
  description: budget
    ? 'Harborline drafts berth and crew plans for regional ferry operators from timetables, weather and crew rules. A planner approves every change.\n\nWe run two pilots with operators of five and eight vessels. Budget draws would fund one integration per operator booking system.'
    : "Tallowreed records a vet visit on a tablet, transcribes it on the device and drafts the clinical note in the clinic's own template. Nothing leaves the clinic unless the vet exports it.\n\nThree clinics use it daily. The average note now takes four minutes instead of twelve, measured by the clinics themselves. We are raising to add species-specific templates and a lab-results import.",
  raise: 30_000,
  supply: 10_000_000,
};
const { supply, targetPrice } = sizing(project);
const stage1 = BigInt(Math.max(Number(params.stage1Min), Number(arg('--stage1-minutes', '20')) * 60));
const stage2 = BigInt(
  Math.max(
    Number(params.stage2Min),
    budget ? Math.ceil((Number(params.voting) + Number(params.dispute) + Number(params.execution)) * 1.3) + 120 : 0,
  ),
);
const hash = await wallet.writeContract({
  address: manifest.factory,
  abi: A.RaiseFactoryV31Abi as Abi,
  functionName: 'createRaise',
  args: [
    templateId,
    version,
    {
      quote: manifest.mockUSDG ?? manifest.quote,
      treasury: zeroAddress,
      supply,
      targetPrice,
      budgetCeiling: budget ? 2n * 10n ** 17n : 0n,
      stage1Length: stage1,
      stage2Length: stage2,
      builders: [],
    },
    { name: project.name, symbol: project.symbol },
  ],
} as never);
const receipt = await pub.waitForTransactionReceipt({ hash });
let raise = '';
for (const l of receipt.logs) {
  try {
    const e = decodeEventLog({ abi: A.RaiseFactoryV31Abi as Abi, topics: l.topics, data: l.data }) as {
      eventName: string;
      args: any;
    };
    if (e.eventName === 'RaiseCreated') raise = e.args.raise;
  } catch {
    /* other logs */
  }
}
console.log(
  `created ${project.name} (${project.symbol}) raise=${raise} builder=${account.address} stage1=${stage1}s stage2=${stage2}s`,
);

async function signed(method: string, path: string, value: unknown) {
  const body = JSON.stringify(value);
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(await signRequest(account, method, path, body)) },
    body,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${JSON.stringify(json)}`);
  return json;
}
for (let i = 0; i < 100 && !(await fetch(`${api}/v2/raises/${raise}`)).ok; i++)
  await new Promise((r) => setTimeout(r, 200));
await signed('PUT', `/v2/raises/${raise}/profile`, {
  name: project.name,
  tagline: project.tagline,
  description: project.description,
  website: `https://${project.name.toLowerCase().replace(/\s+/g, '')}.example`,
  twitter: '',
  github: '',
  docs: '',
});
await signed('POST', `/v2/raises/${raise}/updates`, {
  kind: 'update',
  title: budget ? 'Second operator pilot started' : 'Lab-results import in testing',
  body: budget
    ? 'Our second operator now plans two routes with Harborline. Planners changed 18% of suggested berth windows in week one.'
    : 'Two clinics are testing the import of blood-panel results into the note. Mapping errors dropped to one in forty panels after a template fix.',
});
const report = await signed('POST', `/v2/raises/${raise}/analyze`, {});
console.log(
  `analyst: riskScoreBps=${report.riskScoreBps} veto=${report.veto} scorers=${(report.panel ?? []).map((s: any) => `${s.name}:${s.riskScoreBps ?? s.error ?? '?'}`).join(',')} postedTx=${report.postedTx ?? 'none'}`,
);
console.log(
  `findings: ${(report.findings ?? [])
    .map((f: any) => `[${f.severity}] ${f.title}`)
    .join(' | ')
    .slice(0, 400)}`,
);
