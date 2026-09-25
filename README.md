# Portex

**Back cutting-edge AI innovation, as an early VC with protective terms.**

*In an era where AI is reshaping everything, every startup needs the room to experiment. Portex is the first
escrow-backed on-chain incubation protocol: funds remain fully protected until genuine external demand is proven.
If a project does not graduate from incubation, backers can reclaim 100% of their principal with zero loss; only when
a project truly breaks out does it enter the open market.*

Portex is a launch protocol for AI startups on [X Layer](https://www.okx.com/xlayer), built for OKX Dev Day 2026.

- **Testnet app:** https://testnet.portex.vc
- **Testnet API:** https://testnet-api.portex.vc/v2/health

> Everything on testnet uses **TEST USDG**, a freely mintable faucet token with no monetary value. The projects you
> see there are fictional and are driven by simulation wallets (see [Testnet activity](#testnet-activity)); anyone
> can launch or back a real test project alongside them.

## How it works

Every launch moves through the same three stages.

| Stage | What happens | Your money |
|---|---|---|
| **Stage 1 · Incubation** | Backers deposit on a published price curve: earlier backers pay less, the last pays at most 1.5× the first. An AI analyst reviews every project and can only delay it, never approve it or touch funds. | In escrow. Exit at exact cost at any time, with zero fees. |
| **Stage 2 · Series A buffer** | Outside buyers trade against the protocol's reserve book. The price starts at the Stage 1 price and converges on the listing price. | Still exit at cost, or take a protected exit: cost plus the elapsed share of your gain, paid only from real outside demand. |
| **Stage 3 · Open market** | The project lists in its own Uniswap v4 pool. The liquidity is locked forever and its fees go to the project treasury. | Tokens are ordinary ERC-20s. Protection ends exactly here. |

A project that does not graduate is **dissolved**: every backer takes back their full principal, or moves it into
another project in one transaction (rollover).

**Two launch types.** In an *Escrow Launch* the team never touches the raise. In a *Budget Launch* the team may draw
capped budgets from it, but only through proposals that backers vote on.

**Base layer, kept by every version.** Stage 1 carries no downside, and every project has a governed treasury. The
treasury receives all fees plus 10% of supply, which unlocks linearly (five years in production), and it pays out
only through executed proposals. Stage 2 votes are weighted by contributed capital; Stage 3 votes by tokens, with a
spend capped at 5% of the market value of the YES tokens.

**Governed timings.** Stage lengths, vote and veto windows and the treasury schedule are curator parameters. Each
published version pins them, and every launch keeps its version's values. Production defaults are Stage 1 15–60 days
and Stage 2 35–70 days. The testnet deployment uses short values (Stage 1 from 10 minutes, Stage 2 from 30 minutes)
so whole lifecycles are visible in hours.

The normative specifications are [`docs/PORTEX_PROTOCOL.md`](docs/PORTEX_PROTOCOL.md),
[`docs/PROTECTED_SPLIT.md`](docs/PROTECTED_SPLIT.md) and [`docs/BASE_LAYER.md`](docs/BASE_LAYER.md).

## Repository

One repository, four workspace packages:

| Path | Package | Contents |
|---|---|---|
| `apps/web` | `@portex/web` | Next.js 15 app (English, 中文, Español); reads through the API, writes from the user's wallet. |
| `apps/api` | `@portex/api` | Bun + Hono: chain indexer, REST API (`/v2`), market candles, image uploads, AI analyst. |
| `packages/contracts` | `@portex/contracts` | Foundry contracts (solc 0.8.28), deploy scripts, exported ABIs and deployment manifests. |
| `tools` | `@portex/tools` | Local dev stack, deployment wrappers, demo seed and the testnet activity runner (`tools/mock`). |

`deploy/` holds the server's Docker setup; `.github/workflows/` holds CI and the two deploy pipelines.

## Prerequisites

- [Bun](https://bun.sh) 1.4.2
- [Node.js](https://nodejs.org) 24 (Next.js tooling and Playwright)
- [Foundry](https://getfoundry.sh) 1.x (`forge`, `anvil`, `cast`)
- `git`, `jq`, `curl`, `python3`
- Docker, only to build or run the server image

Clone with submodules (the contract libraries are pinned submodules) and install:

```bash
git clone --recurse-submodules https://github.com/portex-vc/portex.git
cd portex
bun install
```

No step reads a `.env` file. Configuration comes from the process environment; [`.env.example`](.env.example) lists
every variable.

## Run it locally

```bash
bun run dev
```

This starts anvil, deploys the contracts, starts the API, the web app and a monogram asset server, and seeds seven
fictional projects across every stage. Open http://localhost:3100. The **Dev** page lists the local test accounts
with one-click connect, a faucet and time controls. Ctrl-C stops everything the command started.

- Custom ports: `ANVIL_PORT=… BACKEND_PORT=… FRONTEND_PORT=… ASSETS_PORT=… bun run dev`
- Opening the app from another machine (e.g. a VM's host): `PUBLIC_HOST=<lan-ip> bun run dev`
- Short testnet-style timings locally: `PORTEX_TIMINGS=testnet bun run dev`
- Flags: `--no-seed`, `--no-frontend`, `--no-backend`

## Tests

```bash
bun run test:contracts   # Foundry suite, including real Uniswap v4 PoolManager venue tests
bun run test:api         # API unit and integration tests (spins up its own anvil)
bun run test:web         # web unit tests
bun run lint             # web lint
bun run e2e              # Playwright browser flows on an isolated stack
```

Before the first e2e run, install a browser: `cd apps/web && npx playwright install --with-deps chromium`. Set
`PORTEX_E2E_PORT_OFFSET=<n>` to run several e2e suites side by side.

## Testnet

### Deployment

The live deployment is recorded in
[`packages/contracts/deployments/1952-v31.json`](packages/contracts/deployments/1952-v31.json):

| Contract | Address |
|---|---|
| Registry | `0xA4Bf6891695208Bf7509028eF7FB1290B3c87171` |
| Raise factory | `0x8A8E443c04579eec0427C05aE1f4779A60887bF6` |
| Rollover router | `0x83812Fc1C1A341e21C0B48be8Af67Bd2aaa02f72` |
| Swap router | `0xd8A83B1A9D4270437ca66a2F7a7F38Fc93A206e1` |
| Uniswap v4 adapter | `0xA2B2Cc3687846AAecf01366D05224b22cA132b53` |
| Uniswap v4 PoolManager | `0xEa2Be594B450a8Fc8D0CA89E78011369C9F5e61F` |
| TEST USDG | `0xE35e546a090B8844bd05335F0A5D7f21ED4FEaa3` |

There is no official Uniswap v4 deployment on X Layer testnet, so the deploy script deploys its own PoolManager
from the pinned, unmodified v4-core v4.0.0 bytecode. A test proves it is byte-identical to the upstream build.

To deploy a fresh copy (simulation first, then broadcast):

```bash
DEPLOYER_PRIVATE_KEY=0x… bash tools/deploy-testnet.sh
DEPLOYER_PRIVATE_KEY=0x… bash tools/deploy-testnet.sh --broadcast
```

The deployer becomes the registry curator. `PORTEX_TIMINGS=production` keeps production timings instead of the
testnet profile. The script refuses any chain other than 1952.

### Run the app against testnet

```bash
PUBLIC_HOST=localhost PORTEX_WEB_MODE=prod bash tools/run-testnet.sh
```

This starts the API (indexing from the deployment block) and the web app on ports 8790 and 3100.
`PORTEX_WEB_MODE=prod` serves a production build, which uses far less memory than the dev server.

### Testnet activity

`tools/mock` keeps the testnet alive with real on-chain activity from about forty simulation wallets:
- **Launches:** an opening batch, then one launch about every two hours. It keeps at least two projects in Stage 1
  and two in Stage 2, and about half the projects graduate.
- **Wallet activity:** deposits and exits at cost, rollovers, Stage 2 and Stage 3 trading, Budget draws and treasury
  votes, listings and dissolutions.
- **AI personas:** with an OpenAI-compatible model configured, the simulation wallets read each project (including
  real users' test projects), post signed feedback, and decide whether to back it and how to vote. Their backing of
  a user's project is capped at 25% of its raise.

```bash
export MOCK_FUNDER_PRIVATE_KEY=0x…   # funds the simulation wallets' gas (testnet account only)
export MIMO_API_KEY=…                # optional: AI personas; without it they use templates
bun --no-env-file tools/mock/run.ts --rpc https://testrpc.xlayer.tech/terigon \
  --api http://localhost:8790 --deployments packages/contracts/deployments/1952-v31.json --dry-run
```

Drop `--dry-run` to run it; the runner resumes from `tools/mock/state/1952/` after a restart. That directory holds
the wallets' mnemonic: it is gitignored, so back it up privately. `--help` lists every flag. `--set path=value`
overrides any value in `tools/mock/config/tempos.json`.

## Hosting

| Part | Where | How it updates |
|---|---|---|
| Web app | Netlify (`netlify.toml`) | `Deploy web` workflow: after CI passes on `main`, builds `apps/web` and publishes it. |
| API, database and activity runner | DigitalOcean droplet, Docker Compose (`deploy/`) | `Deploy server` workflow: after CI passes on `main`, the commit is shipped to the server, which unpacks it as a new release and rebuilds (`deploy/update.sh`). The SQLite database, uploads and runner state live on the droplet's data volume. |
| Domains | Cloudflare (`portex.vc`) | `testnet.portex.vc` → Netlify, `testnet-api.portex.vc` → the droplet, both proxied. The origins accept traffic only from Cloudflare's IP ranges. |

The workflows need these repository secrets: `DEPLOY_SSH_KEY`, `DEPLOY_HOST`, `DEPLOY_KNOWN_HOSTS`,
`NETLIFY_AUTH_TOKEN` and `NETLIFY_SITE_ID`. Server secrets (funder key, model keys, Pinata) live only in the server's
`/opt/portex/.env`.

## Security

- The contracts went through several rounds of adversarial review, each followed by fixes with regression tests.
  They have not been audited by a third-party firm. Treat this as testnet software.
- Trust roles are explicit and bounded on-chain:
  - **Curator:** publishes versions and parameters for *future* launches only.
  - **Attester (AI analyst):** can only delay a Stage 1 launch, within a pinned veto budget.
  - **Council:** can only lift a veto early.
  - None of them has a path to user funds.
- The quote asset is admitted by an explicit curator attestation. Real USDG on X Layer is issuer-upgradeable, and a
  paused quote asset would suspend exits until it resumes.
- Never commit keys. `.env` files, deployment keys and the simulation wallets' state are gitignored.
