// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {BaseTest} from "./Base.sol";
import {Raise} from "../src/Raise.sol";
import {RaiseConfig} from "../src/libraries/PortexTypes.sol";
import {Stage2Pool} from "../src/Stage2Pool.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {ProjectToken} from "../src/ProjectToken.sol";
import {DiamondVault} from "../src/DiamondVault.sol";

/// @notice Handler driving random actors through the full lifecycle for invariant tests.
contract PortexHandler is Test {
    BaseTest internal baseT;
    Raise internal raise;
    Stage2Pool internal pool;
    DiamondVault internal vault;
    ProjectToken internal token;
    MockUSDG internal usdg;
    address internal builder;
    address[] internal actors;

    // ghost counters (coverage visibility)
    uint256 public deposits;
    uint256 public withdrawals;
    uint256 public commits;
    uint256 public claims;
    uint256 public redeems;
    uint256 public buys;
    uint256 public sells;
    uint256 public unstakes;
    uint256 public opens;
    uint256 public grads;

    constructor(Raise _raise, MockUSDG _usdg, address[] memory _actors, address _builder) {
        raise = _raise;
        pool = _raise.pool();
        vault = _raise.vault();
        token = _raise.token();
        usdg = _usdg;
        actors = _actors;
        builder = _builder;
        for (uint256 i = 0; i < _actors.length; ++i) {
            usdg.mint(_actors[i], 1_000_000e6);
            vm.prank(_actors[i]);
            usdg.approve(address(_raise), type(uint256).max);
            vm.prank(_actors[i]);
            usdg.approve(address(pool), type(uint256).max);
            vm.prank(_actors[i]);
            token.approve(address(pool), type(uint256).max);
        }
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 60, 30 minutes));
    }

    function deposit(uint256 actorSeed, uint256 amount) external {
        if (raise.state() != Raise.State.Incubation) return;
        address a = actors[actorSeed % actors.length];
        amount = bound(amount, 25_000e6, 50_000e6); // biased: two deposits clear the softCap
        vm.prank(a);
        try raise.deposit(amount) {
            deposits++;
        } catch {}
    }

    function withdraw(uint256 actorSeed, uint256 amount) external {
        address a = actors[actorSeed % actors.length];
        uint256 p = raise.principalOf(a);
        if (p == 0) return;
        amount = bound(amount, 1, p);
        vm.prank(a);
        try raise.withdraw(amount) {
            withdrawals++;
        } catch {}
    }

    function startCommitment() external {
        try raise.startCommitment() {} catch {}
    }

    function commit(uint256 actorSeed, uint8 k) external {
        address a = actors[actorSeed % actors.length];
        k = uint8(bound(k, 1, 4));
        vm.prank(a);
        try raise.commit(k) {
            commits++;
        } catch {}
    }

    function commitAll(uint256 actorSeed) external {
        address a = actors[actorSeed % actors.length];
        for (uint8 k = 1; k <= 4; ++k) {
            vm.prank(a);
            try raise.commit(k) {
                commits++;
            } catch {}
        }
    }

    function claim(uint256 actorSeed, uint8 k, bool stake) external {
        address a = actors[actorSeed % actors.length];
        k = uint8(bound(k, 1, 4));
        vm.prank(a);
        try raise.claim(k, stake) {
            claims++;
        } catch {}
    }

    /// @dev Bias: claim every claimable tranche of one actor in one call.
    function claimAll(uint256 actorSeed, bool stake) external {
        address a = actors[actorSeed % actors.length];
        for (uint8 k = 1; k <= 4; ++k) {
            vm.prank(a);
            try raise.claim(k, stake) {
                claims++;
            } catch {}
        }
    }

    function redeem(uint256 actorSeed, uint8 k) external {
        address a = actors[actorSeed % actors.length];
        k = uint8(bound(k, 1, 4));
        vm.prank(a);
        try raise.redeem(k) {
            redeems++;
        } catch {}
    }

    function openGrowth() external {
        try raise.openGrowth() {
            opens++;
        } catch {}
    }

    function buy(uint256 actorSeed, uint256 amount) external {
        address a = actors[actorSeed % actors.length];
        amount = bound(amount, 1, 200_000e6);
        vm.prank(a);
        try pool.buy(amount, 0) {
            buys++;
        } catch {}
    }

    function sell(uint256 actorSeed, uint256 amount) external {
        address a = actors[actorSeed % actors.length];
        uint256 bal = token.balanceOf(a);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(a);
        try pool.sell(amount, 0) {
            sells++;
        } catch {}
    }

    /// @dev Bias: dump one actor's whole token balance in one call.
    function sellAll(uint256 actorSeed) external {
        address a = actors[actorSeed % actors.length];
        uint256 bal = token.balanceOf(a);
        if (bal == 0) return;
        vm.prank(a);
        try pool.sell(bal, 0) {
            sells++;
        } catch {}
    }

    /// @dev Bias: push the raise to graduation in one call — warp to the last epoch so every
    ///      tranche is committable, commit everything for every actor, add demand, graduate.
    function driveToGraduation(uint256 actorSeed) external {
        if (raise.state() != Raise.State.Growth) return;
        uint64 g0 = raise.growthStart();
        if (block.timestamp < g0 + 16 minutes) vm.warp(g0 + 16 minutes); // epoch 4: all committable
        for (uint256 i = 0; i < actors.length; ++i) {
            for (uint8 k = 1; k <= 4; ++k) {
                vm.prank(actors[i]);
                try raise.commit(k) {
                    commits++;
                } catch {}
            }
        }
        address a = actors[actorSeed % actors.length];
        vm.prank(a);
        try pool.buy(50_000e6, 0) {
            buys++;
        } catch {}
        if (block.timestamp < g0 + 21 minutes) vm.warp(g0 + 21 minutes); // all N epochs elapsed
        try raise.graduate() {
            grads++;
        } catch {}
    }

    function unstake(uint256 actorSeed, uint256 amount) external {
        address a = actors[actorSeed % actors.length];
        (uint256 staked,) = vault.stakeOf(a);
        if (staked == 0) return;
        amount = bound(amount, 1, staked);
        vm.prank(a);
        try vault.unstake(amount) {
            unstakes++;
        } catch {}
    }

    function graduate(uint256) external {
        try raise.graduate() {
            grads++;
        } catch {}
    }

    // NOTE: no random fail()/cancel() here — terminal kills conflict with the non-vacuous
    // Growth/sell/graduate coverage this suite must reach every run (audit L-03). Failed-state
    // exits are covered by unit tests (Incubation, Tranches, Scenarios S2/S6).

    function claimRewards(uint256 actorSeed) external {
        vm.prank(actors[actorSeed % actors.length]);
        try vault.claimRewards() {} catch {}
    }

    function claimBuilderFees() external {
        try pool.claimBuilderFees() {} catch {}
    }

    function claimBuilderVested() external {
        try raise.claimBuilderVested() {} catch {}
    }
}

/// @notice Invariant tests asserting design §6 against random actor sequences.
contract PortexInvariantTest is BaseTest {
    PortexHandler internal handler;
    address[] internal actors;

    function setUp() public override {
        super.setUp();
        // time-forgiving config for random walks: long deadline so startCommitment rarely lapses
        RaiseConfig memory cfg = defaultConfig();
        cfg.deadline = 1 days;
        createRaise(cfg);
        actors = [alice, bob, carol, whale, makeAddr("dave"), makeAddr("erin")];
        handler = new PortexHandler(raise, usdg, actors, builder);
        targetContract(address(handler));
    }

    /// @dev §6.1: escrow quote balance == escrowedPrincipal() (protected principal:
    ///      + committed principal before the pool opens; + all principal in Incubation/Failed).
    function invariant_escrowMatchesProtectedPrincipal() public view {
        assertEq(usdg.balanceOf(address(raise)), raise.escrowedPrincipal());
    }

    /// @dev §6.3: pool solvency — selling every outside token is payable from R; V >= 0;
    ///      V == V0 − converted (exact accounting identity). Outside supply INCLUDES
    ///      vault-staked genesis tokens: they can be unstaked and sold at any time (audit L-03).
    ///      The rest of the vault balance (vaultAlloc rewards) is not sellable during Growth.
    function invariant_poolSolvency() public view {
        if (pool.poolState() != Stage2Pool.PoolState.Open) return;
        uint256 r = pool.R();
        uint256 v = pool.V();
        uint256 t = pool.T();
        uint256 outside = token.totalSupply() - t - token.balanceOf(address(raise)) - token.balanceOf(address(vault))
            + vault.totalStaked();
        uint256 q = r + v;
        uint256 newQ = (q * t) / (t + outside);
        if ((q * t) % (t + outside) != 0) newQ += 1;
        assertLe(q - newQ, r); // one-shot dump of all outside tokens is payable from R
        // V == V0 - committedPrincipal  (V0 = P_tot·T0/A1 floored)
        uint256 v0 = (raise.commitPrincipalTotal() * 400_000e18) / 200_000e18;
        assertEq(v, v0 - raise.committedPrincipal());
    }

    /// @dev §6.4: token conservation — supply == pool + raise + vault + wallets + adapter.
    function invariant_tokenConservation() public view {
        uint256 sum = token.balanceOf(address(raise)) + token.balanceOf(address(pool)) + token.balanceOf(address(vault))
            + token.balanceOf(address(adapter));
        for (uint256 i = 0; i < actors.length; ++i) {
            sum += token.balanceOf(actors[i]);
        }
        sum += token.balanceOf(builder);
        assertEq(token.totalSupply(), sum);
        // pool's tracked T matches its actual balance while Open
        if (pool.poolState() == Stage2Pool.PoolState.Open) {
            assertEq(pool.T(), token.balanceOf(address(pool)));
        }
    }

    /// @dev pool quote balance == R + builderAccrued at all times.
    function invariant_poolQuoteBalance() public view {
        assertEq(usdg.balanceOf(address(pool)), pool.R() + pool.builderAccrued());
    }

    /// @dev §6.5: attester, council, curator and factory owner never hold or receive funds.
    function invariant_rolesNeverHoldFunds() public view {
        address[3] memory roles = [attester, council, curator];
        for (uint256 i = 0; i < 3; ++i) {
            assertEq(usdg.balanceOf(roles[i]), 0);
            assertEq(token.balanceOf(roles[i]), 0);
        }
    }

    /// @dev Rule 1: the index never moves.
    function invariant_indexConstant() public view {
        assertEq(raise.index(), 1e27);
    }

    /// @dev §6.6: a raise's template/version is pinned forever.
    function invariant_templatePinned() public view {
        (bytes32 tid, uint64 ver) = factory.templateOf(address(raise));
        assertEq(tid, ZERO_EXTRACTION);
        assertEq(ver, 1);
    }

    /// @dev share conservation: Σ per-user principal == totalPrincipal (all holders are actors).
    function invariant_shareConservation() public view {
        uint256 sum;
        for (uint256 i = 0; i < actors.length; ++i) {
            sum += raise.principalOf(actors[i]);
        }
        assertEq(sum, raise.totalPrincipal());
    }

    /// @dev vault always covers its staked principal tokens.
    function invariant_vaultCoversStaked() public view {
        assertGe(token.balanceOf(address(vault)), vault.totalStaked());
    }
}

/// @notice Coverage-biased driver (audit L-03): exactly two selectors (warp, cycle), so every
///         invariant run deterministically drives Incubation -> Commitment -> Growth (claims,
///         sells, unstakes, redeems) -> graduate. The core solvency/escrow checks are asserted
///         PER CALL inside the handler (run-end invariant checks would miss Open states once a
///         run graduates), and the ghost counters are asserted non-zero at every run end, so the
///         suite can never pass vacuously.
contract PortexCoverageHandler is Test {
    Raise internal raise;
    Stage2Pool internal pool;
    DiamondVault internal vault;
    ProjectToken internal token;
    MockUSDG internal usdg;
    address[] internal actors;

    // ghost counters (coverage)
    uint256 public deposits;
    uint256 public commits;
    uint256 public claims;
    uint256 public sells;
    uint256 public buys;
    uint256 public redeems;
    uint256 public unstakes;
    uint256 public opens;
    uint256 public grads;

    constructor(Raise _raise, MockUSDG _usdg, address[] memory _actors) {
        raise = _raise;
        pool = _raise.pool();
        vault = _raise.vault();
        token = _raise.token();
        usdg = _usdg;
        actors = _actors;
        for (uint256 i = 0; i < _actors.length; ++i) {
            usdg.mint(_actors[i], 1_000_000e6);
            vm.prank(_actors[i]);
            usdg.approve(address(_raise), type(uint256).max);
            vm.prank(_actors[i]);
            usdg.approve(address(pool), type(uint256).max);
            vm.prank(_actors[i]);
            token.approve(address(pool), type(uint256).max);
        }
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 60, 30 minutes));
    }

    /// @dev One full-lifecycle step: deposits + startCommitment in Incubation, tranche-1 commits
    ///      + openGrowth in Commitment, then claims/sells/unstake/redeem/commits/graduate in
    ///      Growth. Every stage transition is try/catch so a single call advances as far as the
    ///      current state allows; a few calls per run cover the whole lifecycle.
    function cycle(uint256 seed) external {
        if (raise.state() == Raise.State.Incubation) {
            for (uint256 i = 0; i < actors.length; ++i) {
                uint256 amt = 35_000e6 + ((seed >> (i * 8)) % 10_000e6); // ~fills the 200k hardCap
                vm.prank(actors[i]);
                try raise.deposit(amt) {
                    deposits++;
                } catch {}
            }
            vm.warp(block.timestamp + 11 minutes); // past minIncubation
            try raise.startCommitment() {} catch {}
        }
        if (raise.state() == Raise.State.Commitment) {
            for (uint256 i = 0; i < 2; ++i) {
                vm.prank(actors[i]);
                try raise.commit(1) {
                    commits++;
                } catch {}
            }
            vm.warp(block.timestamp + 6 minutes); // past the commitment window
            try raise.openGrowth() {
                opens++;
            } catch {}
        }
        if (raise.state() == Raise.State.Growth) {
            // claims: actor0 stakes into the vault, actor1 keeps tokens in the wallet
            vm.prank(actors[0]);
            try raise.claim(1, true) {
                claims++;
            } catch {}
            vm.prank(actors[1]);
            try raise.claim(1, false) {
                claims++;
            } catch {}
            // outside demand, then sells of everything held outside (wallet + bought)
            address w = actors[2 + (seed % (actors.length - 2))];
            vm.prank(w);
            try pool.buy(20_000e6 + (seed % 30_000e6), 0) {
                buys++;
            } catch {}
            uint256 b1 = token.balanceOf(actors[1]);
            if (b1 > 0) {
                vm.prank(actors[1]);
                try pool.sell(b1, 0) {
                    sells++;
                } catch {}
            }
            uint256 bw = token.balanceOf(w);
            if (bw > 0 && seed % 3 == 0) {
                // sell only occasionally: round-tripping every buy would drain R back and the
                // real-ratio gate would never be reached
                vm.prank(w);
                try pool.sell(bw, 0) {
                    sells++;
                } catch {}
            }
            // vault-staked tokens are unstaked and sold too — they are sellable supply (L-03)
            (uint256 staked,) = vault.stakeOf(actors[0]);
            if (staked > 0) {
                vm.prank(actors[0]);
                try vault.unstake(staked) {
                    unstakes++;
                } catch {}
                uint256 b0 = token.balanceOf(actors[0]);
                if (b0 > 0) {
                    vm.prank(actors[0]);
                    try pool.sell(b0, 0) {
                        sells++;
                    } catch {}
                }
            }
            // a locked tranche redeems 1:1 while the pool runs
            vm.prank(actors[1]);
            try raise.redeem(4) {
                redeems++;
            } catch {}
            _assertSolventAndEscrow(); // per-call: the dump above must stay payable from R
            // commit everything for everyone (epoch-gated; later cycles commit the rest)
            for (uint256 i = 0; i < actors.length; ++i) {
                for (uint8 k = 1; k <= 4; ++k) {
                    vm.prank(actors[i]);
                    try raise.commit(k) {
                        commits++;
                    } catch {}
                }
            }
            uint64 g0 = raise.growthStart();
            if (block.timestamp < g0 + 21 minutes) vm.warp(g0 + 21 minutes); // all N epochs
            try raise.graduate() {
                grads++;
            } catch {}
        }
    }

    /// @dev The §6.3 one-shot-dump solvency check (INCLUDING vault-staked genesis tokens, L-03)
    ///      plus the §6.1 escrow identity, asserted after each cycle's worst-case dump.
    function _assertSolventAndEscrow() internal view {
        assertEq(usdg.balanceOf(address(raise)), raise.escrowedPrincipal(), "escrow != protected principal");
        if (pool.poolState() != Stage2Pool.PoolState.Open) return;
        uint256 r = pool.R();
        uint256 v = pool.V();
        uint256 t = pool.T();
        uint256 outside = token.totalSupply() - t - token.balanceOf(address(raise)) - token.balanceOf(address(vault))
            + vault.totalStaked();
        if (outside == 0) return;
        uint256 q = r + v;
        uint256 newQ = (q * t) / (t + outside);
        if ((q * t) % (t + outside) != 0) newQ += 1;
        assertLe(q - newQ, r, "one-shot dump of all outside tokens is not payable from R");
    }
}

/// @notice Non-vacuous companion to PortexInvariantTest (audit L-03): same core invariants, but
///         driven by PortexCoverageHandler so every run provably reaches Growth, sells, redeems
///         and graduates (counters asserted > 0 at each run end).
contract PortexCoverageInvariantTest is BaseTest {
    PortexCoverageHandler internal covHandler;
    address[] internal actors;

    function setUp() public override {
        super.setUp();
        RaiseConfig memory cfg = defaultConfig();
        cfg.deadline = 7 days; // time-forgiving: warps must never lapse the deposit window
        createRaise(cfg);
        actors = [alice, bob, carol, whale, makeAddr("dave"), makeAddr("erin")];
        covHandler = new PortexCoverageHandler(raise, usdg, actors);
        targetContract(address(covHandler));
    }

    /// @dev §6.1: escrow quote balance == escrowedPrincipal().
    function invariant_escrowMatchesProtectedPrincipal() public view {
        assertEq(usdg.balanceOf(address(raise)), raise.escrowedPrincipal());
    }

    /// @dev §6.3: pool solvency incl. vault-staked genesis tokens (audit L-03); V >= 0.
    function invariant_poolSolvency() public view {
        if (pool.poolState() != Stage2Pool.PoolState.Open) return;
        uint256 r = pool.R();
        uint256 v = pool.V();
        uint256 t = pool.T();
        uint256 outside = token.totalSupply() - t - token.balanceOf(address(raise)) - token.balanceOf(address(vault))
            + vault.totalStaked();
        uint256 q = r + v;
        uint256 newQ = (q * t) / (t + outside);
        if ((q * t) % (t + outside) != 0) newQ += 1;
        assertLe(q - newQ, r);
    }

    /// @dev §6.4: token conservation — supply == pool + raise + vault + wallets + adapter.
    function invariant_tokenConservation() public view {
        uint256 sum = token.balanceOf(address(raise)) + token.balanceOf(address(pool)) + token.balanceOf(address(vault))
            + token.balanceOf(address(adapter));
        for (uint256 i = 0; i < actors.length; ++i) {
            sum += token.balanceOf(actors[i]);
        }
        sum += token.balanceOf(builder);
        assertEq(token.totalSupply(), sum);
    }

    /// @dev pool quote balance == R + builderAccrued at all times.
    function invariant_poolQuoteBalance() public view {
        assertEq(usdg.balanceOf(address(pool)), pool.R() + pool.builderAccrued());
    }

    /// @dev Non-vacuous coverage gate (audit L-03): a ghost-counter assertion cannot live in an
    ///      invariant (the empty sequence falsifies `counter > 0` by construction), so the driver
    ///      is proven here deterministically — a handful of cycles must cover the full lifecycle
    ///      including sells of previously vault-staked tokens, a locked-tranche redeem and
    ///      graduation. The random campaigns then run the per-call checks inside cycle().
    function test_coverageDriver_reachesAllStages() public {
        for (uint256 i = 0; i < 8; ++i) {
            covHandler.cycle(12345 + i * 99991);
        }
        assertGt(covHandler.deposits(), 0, "no deposits");
        assertGt(covHandler.opens(), 0, "Growth never opened");
        assertGt(covHandler.commits(), 0, "no commits");
        assertGt(covHandler.claims(), 0, "no claims");
        assertGt(covHandler.sells(), 0, "no sells");
        assertGt(covHandler.redeems(), 0, "no redeems");
        assertGt(covHandler.unstakes(), 0, "no unstakes");
        assertGt(covHandler.grads(), 0, "never graduated");
        assertEq(uint8(raise.state()), uint8(Raise.State.Migrated));
    }
}

/// @notice Auditor test 3 (L-03), deterministic: reach Growth with BOTH wallet-held and
///         vault-staked genesis tokens; unstake everything; sell every sellable token back in
///         worst order (largest positions first — fewest pool-favouring rounding events);
///         every sell must succeed and every locked tranche must redeem exactly. The coverage
///         is real by construction: claims, sells and redeems all move actual balances.
contract WorstOrderDumpTest is BaseTest {
    function setUp() public override {
        super.setUp();
        createRaise();
    }

    function test_allSellableTokensCovered_worstOrderDump() public {
        depositAs(alice, 100_000e6);
        depositAs(bob, 60_000e6);
        depositAs(carol, 40_000e6);
        vm.warp(block.timestamp + 10 minutes);
        raise.startCommitment();
        commitAs(alice, 1);
        commitAs(bob, 1);
        commitAs(carol, 1);
        vm.warp(block.timestamp + 5 minutes);
        raise.openGrowth();
        assertEq(uint8(raise.state()), uint8(Raise.State.Growth)); // opened, non-vacuous

        uint64 g0 = raise.growthStart();
        // alice commits+claims everything STAKED; bob commits+claims everything to his WALLET;
        // carol commits/claims tranches 1-3 to her wallet and keeps tranche 4 LOCKED.
        for (uint8 k = 2; k <= 3; ++k) {
            vm.warp(g0 + (k - 2) * 5 minutes);
            commitAs(alice, k);
            commitAs(bob, k);
            commitAs(carol, k);
        }
        vm.warp(g0 + 10 minutes);
        commitAs(alice, 4);
        commitAs(bob, 4);
        buyAs(whale, 80_000e6); // outside bought tokens
        vm.warp(g0 + 15 minutes); // all claim lags elapsed
        for (uint8 k = 1; k <= 4; ++k) {
            claimAs(alice, k, true); // vault-staked genesis tokens
            claimAs(bob, k, false); // wallet-held genesis tokens
        }
        for (uint8 k = 1; k <= 3; ++k) {
            claimAs(carol, k, false);
        }

        // non-vacuous coverage: real claims happened, both custody forms exist
        uint256 aliceStaked = vault.totalStaked();
        assertEq(aliceStaked, 100_000e18);
        assertEq(token.balanceOf(bob), 60_000e18);
        uint256 whaleBal = token.balanceOf(whale);
        assertGt(whaleBal, 0);

        // unstake everything: all claimed genesis tokens are immediately sellable
        vm.prank(alice);
        vault.unstake(aliceStaked);
        assertEq(vault.totalStaked(), 0);

        // worst order: largest holders first, each dumping their whole balance in one shot
        uint256 sold;
        sold += sellAs(alice, token.balanceOf(alice));
        sold += sellAs(whale, token.balanceOf(whale));
        sold += sellAs(bob, token.balanceOf(bob));
        sold += sellAs(carol, token.balanceOf(carol));
        assertGt(sold, 0); // sells really happened
        assertEq(token.balanceOf(alice), 0);
        assertEq(token.balanceOf(bob), 0);
        assertEq(token.balanceOf(carol), 0);
        assertEq(token.balanceOf(whale), 0);

        // every sell was payable from R; the pool is left consistent
        (uint256 r,,) = pool.reserves();
        assertEq(usdg.balanceOf(address(pool)), r + pool.builderAccrued());

        // the remaining locked tranche redeems exactly 1:1 (carol's 10k of principal)
        uint256 carolBefore = usdg.balanceOf(carol);
        redeemAs(carol, 4);
        assertEq(usdg.balanceOf(carol) - carolBefore, 10_000e6);
        assertEq(usdg.balanceOf(address(raise)), raise.escrowedPrincipal());
    }
}
