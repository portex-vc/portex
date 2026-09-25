# Real v4 venue regression fixtures

For contract reviewers and maintainers reproducing the integration tests. No RPC, private key, dotenv file or running anvil is needed.

`VenueBaseV31` reproduces the existing Stage 1/Stage 2 test setup with the real adapter and deploys the actual Uniswap PoolManager. `RealV4ScenariosV31.t.sol` retains the Escrow/Budget issuance, exit, draw, refund and listing flows. `UniswapV4Adapter.t.sol` covers both currency orders, preview reconciliation, hook permissions, populated pools, swaps, fee custody, principal lock, reentrancy, failed settlement and retry. `DeployXLayerTestnet.t.sol` exercises the deployment logic and manifest in the in-process EVM, including the wrong-chain refusal and the script's own PoolManager, which must be byte-identical to the pinned fixture apart from NoDelegateCall's self address (the third-party testnet PoolManager is not canonical v4-core and is never used). It generates no live deployment manifest. `PortexSwapRouterV31.t.sol` drives the secondary-market router against the real PoolManager and a real listed raise: buys and sells in both currency orders, quote/execution equality (fuzzed), slippage, deadline, uninitialized pools, partial fills, re-entrancy, and sales of quota-carrying, lazily delivered tokens through the token's own transfer rules.

`VenueTestRouter` and `ReentrantQuote` are adversarial test helpers, not deployable production integrations.

## PoolManager provenance

- Repository: https://github.com/Uniswap/v4-core
- Release: `v4.0.0`
- Commit: `e50237c43811bd9b526eff40f26772152a42daba`
- Source: `src/PoolManager.sol`, unmodified, BUSL-1.1.
- Compiler: `0.8.26+commit.8a97fa7a` (the source has an exact compiler pragma).
- Upstream default settings: Cancun, via IR, optimizer enabled with 44,444,444 runs, `bytecodeHash = none`.
- Creation bytecode length: 24,194 bytes.
- Creation bytecode SHA-256: `416d955e1da0680180668fc29b98eea6d0b3ec216aab3bfefb9f1f8d07820b8e`.

`PoolManagerBytecode.sol` embeds that exact creation code so the main project and all new contracts/tests can remain on solc 0.8.28. The tests execute its constructor with an initial owner; this deploys the real manager and initializes its storage and immutable `NoDelegateCall` address. Deployment-script tests execute the same constructor at the pinned testnet address inside the local EVM, preserving that immutable address. Neither path substitutes a mock PoolManager.

From the repository root, reproduce the fixture with:

```sh
bash contracts/script/build-v4-fixture.sh
```

The helper checks the dependency commit, compiler settings, lack of unresolved library links and expected bytecode hash before rewriting the generated source. It starts Foundry from `/tmp` to avoid automatic dotenv discovery. It requires solc 0.8.26 for fixture regeneration; ordinary `forge build` and `forge test` use only the committed fixture and solc 0.8.28. Periphery is pinned independently to `9969eec44cfdf07e24b41de47f40276a58401976` because upstream has no release/tag; only its arithmetic library is imported in these tests.

## Verification without dotenv discovery

Use an absolute contracts path and start Foundry outside the repository:

```sh
PORTEX_CONTRACTS_DIR=/absolute/path/to/portex/contracts
cd /tmp
forge build --root "$PORTEX_CONTRACTS_DIR"
forge test --root "$PORTEX_CONTRACTS_DIR"
forge test --root "$PORTEX_CONTRACTS_DIR" --match-path 'test/v31/venue/**' -vv
forge fmt --root "$PORTEX_CONTRACTS_DIR" --check \
  "$PORTEX_CONTRACTS_DIR/src/v31/venue" \
  "$PORTEX_CONTRACTS_DIR/test/v31/venue" \
  "$PORTEX_CONTRACTS_DIR/script/DeployXLayerTestnet.s.sol"
```

See `reports/acceptance.txt` for exact command outcomes and the mined local-test hook address. The address is a deterministic test fixture, not an X Layer deployment. Full output is retained in the adjacent build/test logs; original v3.1 source and tests are hash-checked against the pre-change baseline.
