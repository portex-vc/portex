// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {BaseTest} from "./Base.sol";
import {Raise} from "../src/Raise.sol";
import {SpendGovernor} from "../src/SpendGovernor.sol";
import {RaiseConfig} from "../src/libraries/PortexTypes.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";

/// @notice Handler driving random actors through Rule 2 governor lifecycles for invariant tests.
///         Per-call assertions cover the two core promises directly: any successful withdraw
///         pays exactly the requested amount, and a dissenter leaving inside a dispute window
///         always succeeds and leaves with exactly their full principal.
contract GovernorHandler is Test {
    Raise internal raise;
    SpendGovernor internal gov;
    MockUSDG internal usdg;
    address internal builder;
    address[] internal actors;

    // ghosts
    uint256 public roundingOps; // deposits + partial withdraws (each can leave <= 1 wei of dust)
    uint256 public spentTotal; // sum of executed amounts
    uint256 public builderReceived; // quote actually received by the builder from executions
    uint256 public deposits;
    uint256 public withdrawals;
    uint256 public votesCast;
    uint256 public proposalsCreated;
    uint256 public proposalsPassed;
    uint256 public proposalsDefeated;
    uint256 public proposalsExecuted;
    uint256 public proposalsExpired;
    uint256 public dissentExits;
    uint256 public locksReleased;

    mapping(uint256 => mapping(address => bool)) internal yesVoted;

    constructor(Raise _raise, SpendGovernor _gov, MockUSDG _usdg, address[] memory _actors, address _builder) {
        raise = _raise;
        gov = _gov;
        usdg = _usdg;
        actors = _actors;
        builder = _builder;
        for (uint256 i = 0; i < _actors.length; ++i) {
            usdg.mint(_actors[i], 1_000_000e6);
            vm.prank(_actors[i]);
            usdg.approve(address(_raise), type(uint256).max);
        }
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 2 minutes));
    }

    function deposit(uint256 actorSeed, uint256 amount) external {
        if (raise.state() != Raise.State.Incubation) return;
        address a = actors[actorSeed % actors.length];
        amount = bound(amount, 1, 50_000e6);
        vm.prank(a);
        try raise.deposit(amount) {
            deposits++;
            roundingOps++;
        } catch {}
    }

    function withdrawSome(uint256 actorSeed, uint256 amount) external {
        address a = actors[actorSeed % actors.length];
        uint256 p = raise.principalOf(a);
        if (p == 0) return;
        amount = bound(amount, 1, p > 1 ? p / 2 + 1 : 1); // partial-biased: keeps principal votable
        uint256 balBefore = usdg.balanceOf(a);
        vm.prank(a);
        try raise.withdraw(amount) {
            assertEq(usdg.balanceOf(a) - balBefore, amount, "withdraw must pay exactly the requested amount");
            withdrawals++;
            if (amount < p) roundingOps++; // partial burns round up and can leave 1 wei of dust
        } catch {}
    }

    /// @dev The dispute-window promise: a backer who did not vote YES (and is not locked) can
    ///      always leave with exactly 100% of their principal while a passed proposal is in its
    ///      dispute window. Any failure here fails the invariant run.
    function exitDissenter(uint256 actorSeed) external {
        uint256 id = gov.activeProposalId();
        if (id == 0) return;
        SpendGovernor.Proposal memory p = gov.getProposal(id);
        if (p.status != SpendGovernor.Status.Passed || block.timestamp >= p.disputeEnds) return;
        address a = actors[actorSeed % actors.length];
        if (yesVoted[id][a]) return; // YES voters are locked by design
        if (raise.withdrawLockUntil(a) > block.timestamp) return; // stale lock from an older proposal
        uint256 principal = raise.principalOf(a);
        if (principal == 0) return;
        uint256 balBefore = usdg.balanceOf(a);
        vm.prank(a);
        try raise.withdraw(principal) {
            assertEq(usdg.balanceOf(a) - balBefore, principal, "dissenter must leave whole");
            dissentExits++;
        } catch {
            revert("dissenter exit during dispute window must succeed");
        }
    }

    function propose(uint256 amount) external {
        if (raise.totalPrincipal() < 10_000e6) return; // wait for meaningful deposits
        amount = bound(amount, 1, 8_000e6); // small enough that the 10%-of-YES cap can pass
        vm.prank(builder);
        try gov.propose(amount, "ipfs://invariant") returns (uint256) {
            proposalsCreated++;
        } catch {}
    }

    function voteYes(uint256 actorSeed) external {
        _vote(actorSeed, true);
    }

    function voteYes2(uint256 actorSeed) external {
        _vote(actorSeed, true); // YES-biased: passes (and executions) must be reachable
    }

    function voteNo(uint256 actorSeed) external {
        _vote(actorSeed, false);
    }

    function _vote(uint256 actorSeed, bool support) internal {
        uint256 id = gov.activeProposalId();
        if (id == 0) return;
        address a = actors[actorSeed % actors.length];
        vm.prank(a);
        try gov.vote(id, support) {
            if (support) yesVoted[id][a] = true;
            votesCast++;
        } catch {}
    }

    function finalizeActive() external {
        uint256 id = gov.activeProposalId();
        if (id == 0) return;
        SpendGovernor.Proposal memory p = gov.getProposal(id);
        if (p.status != SpendGovernor.Status.Active) return;
        if (block.timestamp < p.votingEnds) vm.warp(p.votingEnds); // keeper style
        try gov.finalize(id) {
            if (gov.getProposal(id).status == SpendGovernor.Status.Passed) proposalsPassed++;
            else proposalsDefeated++;
        } catch {}
    }

    function executeActive() external {
        uint256 id = gov.activeProposalId();
        if (id == 0) return;
        SpendGovernor.Proposal memory p = gov.getProposal(id);
        if (p.status != SpendGovernor.Status.Passed) return;
        if (block.timestamp < p.disputeEnds) vm.warp(p.disputeEnds); // keeper style
        uint256 tpBefore = raise.totalPrincipal();
        uint256 indexBefore = raise.index();
        uint256 builderBefore = usdg.balanceOf(builder);
        try gov.execute(id) {
            proposalsExecuted++;
            spentTotal += p.amount;
            builderReceived += usdg.balanceOf(builder) - builderBefore;
            // stayers pay exactly pro rata: index' = floor(index x (P - amount) / P)
            uint256 expected = (indexBefore * (tpBefore - p.amount)) / tpBefore;
            assertEq(raise.index(), expected, "index must drop exactly pro rata");
            assertEq(usdg.balanceOf(builder) - builderBefore, p.amount, "builder receives exactly amount");
        } catch {}
    }

    function expireActive() external {
        if (gov.activeProposalId() == 0) return;
        try gov.expire(gov.activeProposalId()) {
            proposalsExpired++;
        } catch {}
    }

    function releaseLockFor(uint256 actorSeed) external {
        uint256 n = gov.proposalsCount();
        if (n == 0) return;
        address a = actors[actorSeed % actors.length];
        try gov.releaseLock(n, a) {
            locksReleased++;
        } catch {}
        if (n > 1) {
            try gov.releaseLock(n - 1, a) {
                locksReleased++;
            } catch {}
        }
    }

    function startCommitment(uint256 seed) external {
        if (seed % 8 != 0) return; // thin out: terminal for governor activity
        try raise.startCommitment() {} catch {}
    }

    function cancelRaise(uint256 seed) external {
        if (seed % 64 != 0) return; // rare: terminal action
        vm.prank(builder);
        try raise.cancel() {} catch {}
    }

    function failRaise(uint256 seed) external {
        if (seed % 64 != 0) return; // rare: terminal action
        try raise.fail() {} catch {}
    }
}

/// @notice Rule 2 invariant suite: the escrow identity holds through spends (up to bounded
///         rounding dust), spend accounting is exact, and lifecycle transitions can never
///         happen with a proposal in flight.
contract GovernorInvariantTest is BaseTest {
    GovernorHandler internal handler;
    SpendGovernor internal governorImpl;
    SpendGovernor internal gov;
    address[] internal actors;

    function setUp() public override {
        super.setUp();
        governorImpl = new SpendGovernor();
        publishMilestoneFunding(address(governorImpl));
        RaiseConfig memory cfg = defaultConfig();
        cfg.deadline = 1 days; // time-forgiving, like the Rule 1 suite
        // wider phases than the demo config so random warps don't skip whole windows
        cfg.governor.votingPeriod = 15 minutes;
        cfg.governor.disputeWindow = 15 minutes;
        cfg.governor.minProposalInterval = 15 minutes;
        createGovRaise(cfg);
        gov = SpendGovernor(raise.governor());
        actors = [alice, bob, carol, whale, makeAddr("dave"), makeAddr("erin")];
        handler = new GovernorHandler(raise, gov, usdg, actors, builder);
        targetContract(address(handler));
    }

    /// @dev §6.1 under Rule 2: escrow balance == escrowedPrincipal() + bounded rounding dust.
    ///      Dust sources: share-floor deposits and share-ceil partial withdrawals (<= 1 wei
    ///      each; governorSpend itself is exact). Exact equality through spends (zero dust)
    ///      is covered by unit tests; here random deposits at lowered indexes create dust.
    function invariant_escrowCoversProtectedPrincipal() public view {
        uint256 bal = usdg.balanceOf(address(raise));
        uint256 esc = raise.escrowedPrincipal();
        assertGe(bal, esc); // solvency: the escrow always covers the promise
        assertLe(bal - esc, 2 * handler.roundingOps() + 32); // and the excess is dust only
    }

    /// @dev Spend accounting: cumulativeSpend == executed amounts == what the builder received,
    ///      and never above the hard ceiling of peak principal.
    function invariant_spendAccounting() public view {
        assertEq(raise.cumulativeSpend(), handler.spentTotal());
        assertEq(handler.builderReceived(), handler.spentTotal());
        uint16 capBps = raise.getConfig().maxCumulativeSpendBps;
        assertLe(raise.cumulativeSpend(), (uint256(capBps) * raise.peakPrincipal()) / BPS);
    }

    /// @dev The index only ever moves down (spends), never up.
    function invariant_indexNeverAboveScale() public view {
        assertLe(raise.index(), 1e27);
    }

    /// @dev Lifecycle rule: the raise can only leave Incubation forward (Commitment and beyond)
    ///      when no proposal is in flight. (Failed is reachable with a proposal in flight via
    ///      cancel — backers are always exitable there, and expire() unblocks the governor.)
    function invariant_noProposalInFlightPastIncubation() public view {
        Raise.State st = raise.state();
        if (st == Raise.State.Commitment || st == Raise.State.Growth || st == Raise.State.Migrated) {
            assertEq(gov.activeProposalId(), 0);
        }
    }
}
