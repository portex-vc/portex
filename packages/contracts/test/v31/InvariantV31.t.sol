// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {BaseV31} from "./BaseV31.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TypesV31 as V} from "../../src/v31/TypesV31.sol";
import {RaiseCore} from "../../src/v31/RaiseCore.sol";
import {ProjectTokenV31} from "../../src/v31/ProjectTokenV31.sol";
import {MockUSDGV31} from "../../src/v31/MockUSDGV31.sol";
import {GovernanceV31} from "../../src/v31/GovernanceV31.sol";
import {ClaimVault} from "../../src/v31/ClaimVault.sol";
import {ReserveMarket} from "../../src/v31/ReserveMarket.sol";
import {ProtectedSplitLib as PS} from "../../src/libraries/ProtectedSplitLib.sol";

contract V31Handler is Test {
    RaiseCore public raise;
    ProjectTokenV31 public token;
    MockUSDGV31 public quote;
    GovernanceV31 public governor;
    address public builder;
    address[] private actors;
    uint256[] private positionIds;
    uint256 public lastNonce;
    uint256 public deposits;
    uint256 public buys;
    uint256 public sells;
    uint256 public costExits;
    uint256 public profitExits;
    uint256 public draws;
    uint256 public listings;
    uint256 public transfers;
    uint256 public checks;

    constructor(RaiseCore raise_, MockUSDGV31 quote_, address builder_, address[] memory actors_) {
        raise = raise_;
        token = ProjectTokenV31(raise_.modules().token);
        governor = GovernanceV31(raise_.modules().governor);
        quote = quote_;
        builder = builder_;
        actors = actors_;
        for (uint256 i; i < actors.length; ++i) {
            quote.mint(actors[i], 1e18);
            vm.prank(actors[i]);
            quote.approve(address(raise), type(uint256).max);
        }
        quote.mint(builder, 1e18);
        vm.prank(builder);
        quote.approve(address(raise), type(uint256).max);
    }

    function buy(uint256 actorSeed, uint256 amount) external {
        _prepare();
        if (raise.phase() != V.Phase.Stage2) return;
        uint256 n = raise.stateNonce();
        PS.Book memory beforeBook = _decayed();
        vm.prank(actors[actorSeed % actors.length]);
        try raise.buy(bound(amount, 1, 100000e6), 0, n, vm.getBlockTimestamp()) {
            ++buys;
            assertEq(raise.stateNonce(), n + 1);
            _assertProduct(beforeBook);
        } catch {
            assertEq(raise.stateNonce(), n);
        }
        _check();
    }

    function sell(uint256 actorSeed, uint256 amount) external {
        _prepare();
        address actor = actors[actorSeed % actors.length];
        uint256 balance = raise.buyerTokens(actor);
        if (balance == 0 || (raise.phase() != V.Phase.Stage2 && raise.phase() != V.Phase.ListingPending)) return;
        uint256 n = raise.stateNonce();
        PS.Book memory beforeBook = _decayed();
        vm.prank(actor);
        try raise.sell(bound(amount, 1, balance), 0, n, vm.getBlockTimestamp()) {
            ++sells;
            assertEq(raise.stateNonce(), n + 1);
            _assertProduct(beforeBook);
        } catch {
            assertEq(raise.stateNonce(), n);
        }
        _check();
    }

    function exit(uint256 positionSeed, uint256 quantitySeed, bool protected) external {
        _prepare();
        if (raise.phase() == V.Phase.Stage3) return;
        uint256 id = positionIds[positionSeed % positionIds.length];
        V.PositionView memory p = raise.positionState(id);
        if (p.tokens == 0) return;
        uint256 q = bound(quantitySeed, 1, p.tokens);
        if (protected && (p.class != V.Class.Backer || raise.phase() != V.Phase.Stage2)) protected = false;
        V.ExitQuote memory r =
            protected ? raise.protectedExitQuote(id, q) : raise.redeemQuote(id, q, raise.stateNonce());
        PS.Book memory pre = _decayed();
        uint256 beforeQuote = quote.balanceOf(p.owner);
        uint256 nonce = raise.stateNonce();
        vm.prank(p.owner);
        uint256 paid = protected
            ? raise.protectedExit(id, q, 0, nonce, vm.getBlockTimestamp())
            : raise.exitAtCost(id, q, 0, nonce, vm.getBlockTimestamp());
        if (protected) {
            ++profitExits;
        } else {
            ++costExits;
            assertEq(paid, r.result.cost, "zero loss: exact live basis");
        }
        assertEq(paid, r.result.payout);
        assertEq(quote.balanceOf(p.owner) - beforeQuote, paid);
        assertEq(raise.stateNonce(), nonce + 1);
        _assertExitMath(pre, r, q);
        _check();
    }

    function warp(uint256 secondsSeed) external {
        _prepare();
        vm.warp(vm.getBlockTimestamp() + bound(secondsSeed, 1, 2 days));
        _check();
    }

    function decay() external {
        _prepare();
        if (raise.phase() == V.Phase.Stage3) return;
        V.ReserveState memory before = raise.reserveState();
        raise.advanceDepth();
        V.ReserveState memory afterState = raise.reserveState();
        assertLe((afterState.R + afterState.V) * before.T, (before.R + before.V) * afterState.T, "decay raised price");
        assertEq(afterState.stateNonce, before.stateNonce + (before.V == afterState.V ? 0 : 1));
        _check();
    }

    function budgetDraw() external {
        _prepare();
        if (raise.phase() != V.Phase.Stage2 || raise.getConfig().budgetCeiling == 0) return;
        (uint64 end, uint256 escrow, uint256 remaining) = raise.governanceState();
        if (vm.getBlockTimestamp() + 12 days > end || escrow < 1000 || remaining < 1000) return;
        vm.prank(builder);
        uint256 proposal;
        try governor.propose(Math.min(remaining, 1000), "ipfs://invariant") returns (uint256 id) {
            proposal = id;
        } catch {
            return;
        }
        _check();
        for (uint256 i; i < positionIds.length; ++i) {
            V.PositionView memory voter = raise.positionState(positionIds[i]);
            if (voter.class != V.Class.Backer || voter.basis == 0) continue;
            vm.prank(voter.owner);
            governor.vote(proposal, positionIds[i], true);
            _check();
        }
        GovernanceV31.Proposal memory p = governor.getProposal(proposal);
        vm.warp(p.votingEnds);
        governor.finalize(proposal);
        _check();
        if (governor.getProposal(proposal).status != GovernanceV31.Status.Passed) return;
        vm.warp(p.disputeEnds);
        PS.Book memory pre = _decayed();
        uint256 n = raise.stateNonce();
        governor.execute(proposal);
        V.ReserveState memory afterState = raise.reserveState();
        assertEq(afterState.stateNonce, n + 1);
        assertEq(afterState.E, pre.E - p.amount);
        assertLe((afterState.R + afterState.V) * pre.T, (pre.R + pre.V) * afterState.T, "draw raised price");
        ++draws;
        _check();
    }

    function list() external {
        _prepare();
        if (raise.phase() != V.Phase.ListingPending) return;
        uint256 n = raise.stateNonce();
        try raise.list() {
            ++listings;
            assertEq(raise.stateNonce(), n + 1);
        } catch {
            assertEq(raise.stateNonce(), n);
        }
        _check();
    }

    function transfer(uint256 fromSeed, uint256 toSeed, uint256 amountSeed) external {
        _prepare();
        if (raise.phase() != V.Phase.Stage3) return;
        address from = actors[fromSeed % actors.length];
        address to = actors[toSeed % actors.length];
        uint256 balance = token.balanceOf(from);
        if (balance == 0) return;
        uint256 amount = bound(amountSeed, 0, balance);
        uint256 quotaBefore = token.quotaOf(from);
        uint256 recipientQuota = token.quotaOf(to);
        uint256 n = raise.stateNonce();
        vm.prank(from);
        token.transfer(to, amount);
        assertEq(token.quotaOf(from), quotaBefore - Math.min(amount, quotaBefore));
        if (from != to) assertEq(token.quotaOf(to), recipientQuota);
        assertEq(raise.stateNonce(), n);
        ++transfers;
        _check();
    }

    function claimRewards(uint256 actorSeed) external {
        _prepare();
        if (raise.phase() != V.Phase.Stage3) return;
        address actor = actors[actorSeed % actors.length];
        uint256 quotaBefore = token.quotaOf(actor);
        uint256 n = raise.stateNonce();
        vm.prank(actor);
        try token.claimRewards() {
            assertEq(raise.stateNonce(), n);
        } catch {
            assertEq(raise.stateNonce(), n);
        }
        assertEq(token.quotaOf(actor), quotaBefore);
        _check();
    }

    function feeWithdrawal() external {
        _prepare();
        uint256 n = raise.stateNonce();
        try raise.claimTreasuryFees() {
            assertEq(raise.stateNonce(), n + (raise.phase() == V.Phase.Stage3 ? 0 : 1));
        } catch {
            assertEq(raise.stateNonce(), n);
        }
        _check();
    }

    function checkInvariants() external view {
        _assertState();
    }

    function _prepare() internal {
        if (raise.phase() != V.Phase.Stage1) return;
        uint256 initialNonce = raise.stateNonce();
        vm.prank(builder);
        (uint256 builderId,) = raise.deposit(500e6, 1, initialNonce, vm.getBlockTimestamp());
        positionIds.push(builderId);
        ++deposits;
        _check();
        for (uint256 i; i < 10; ++i) {
            uint256 n = raise.stateNonce();
            vm.prank(actors[i]);
            (uint256 id,) = raise.deposit(i == 9 ? 100000e6 : 1500e6, 1, n, vm.getBlockTimestamp());
            positionIds.push(id);
            ++deposits;
            _check();
        }
        vm.warp(raise.stageDeadlines().stage1End);
        raise.advanceStage1();
        _check();
    }

    function _check() internal {
        assertGe(raise.stateNonce(), lastNonce, "nonce decreased");
        lastNonce = raise.stateNonce();
        ++checks;
        _assertState();
    }

    function _assertState() internal view {
        V.ReserveState memory b = raise.reserveState();
        assertEq(
            token.totalSupply() + token.burned(), raise.getConfig().supply, "representation-independent token equation"
        );
        _assertQuotes(b);
        V.Phase phase = raise.phase();
        if (phase != V.Phase.Stage3) _assertBeforeListing(b, phase);
        if (phase == V.Phase.Stage2 || phase == V.Phase.ListingPending) {
            assertGe(b.R * b.T, b.V * b.O, "Reserve solvency");
            assertEq(b.V - b.E, Math.mulDiv(b.X0, V.SCALE - b.lastT, V.SCALE), "depth schedule");
        }
        if (phase == V.Phase.Stage3) _assertListed(b);
    }

    function _assertQuotes(V.ReserveState memory b) internal view {
        V.Modules memory m = raise.modules();
        (,,,, uint256 dust,) = raise.accounting();
        (, uint256 rewards, uint256 treasuryFees) = raise.feeAccruals();
        assertEq(quote.balanceOf(address(raise)), b.E + b.R + rewards + treasuryFees + dust, "quote buckets");
        assertEq(quote.balanceOf(m.claims), ClaimVault(m.claims).liability(), "isolated claims");
        uint256 balances = quote.balanceOf(address(raise)) + quote.balanceOf(m.claims) + quote.balanceOf(m.token)
            + quote.balanceOf(m.adapter) + quote.balanceOf(raise.getConfig().treasury) + quote.balanceOf(builder);
        for (uint256 i; i < actors.length; ++i) {
            balances += quote.balanceOf(actors[i]);
        }
        assertEq(balances, quote.totalSupply(), "per-asset quote inflows and outflows");
    }

    function _assertBeforeListing(V.ReserveState memory b, V.Phase phase) internal view {
        V.Config memory c = raise.getConfig();
        (uint256 basis, uint256 shares, uint256 buyers) = _positionSums();
        assertEq(b.H, shares, "shares");
        assertEq(b.O, buyers, "buyer ledger");
        if (c.budgetCeiling == 0 || b.claimCount <= 1) assertEq(b.E, basis, "exact basis cohort");
        else assertGe(b.E, basis, "Budget dust belongs to claimants");
        _assertTokenBuckets(b, phase, c.supply);
        for (uint256 i; i < actors.length; ++i) {
            assertEq(token.balanceOf(actors[i]), 0, "pre-list transfer");
        }
    }

    function _assertTokenBuckets(V.ReserveState memory b, V.Phase phase, uint256 supply) internal view {
        (uint256 sold, uint256 lr, uint256 backer, uint256 builderTokens,,) = raise.accounting();
        uint256 pool = phase == V.Phase.Stage1 ? Math.mulDiv(supply, 40, 100) : b.T + lr;
        uint256 unsold = phase == V.Phase.Stage1 ? supply / 5 - sold : 0;
        assertEq(
            pool + unsold + Math.mulDiv(supply, 40, 100) + backer + builderTokens + b.O + token.burned(),
            supply,
            "disjoint token buckets"
        );
    }

    function _assertListed(V.ReserveState memory b) internal view {
        V.Modules memory m = raise.modules();
        assertEq(b.E + b.R + b.V + b.T + b.O, 0, "claims extinguished");
        uint256 balances = token.balanceOf(address(raise)) + token.balanceOf(address(token))
            + token.balanceOf(m.vesting) + token.balanceOf(m.adapter) + token.balanceOf(raise.getConfig().treasury)
            + token.balanceOf(builder);
        uint256 quota;
        for (uint256 i; i < actors.length; ++i) {
            balances += token.balanceOf(actors[i]);
            quota += token.quotaOf(actors[i]);
        }
        assertEq(balances, token.totalSupply(), "ERC20 representation including lazy credits");
        assertEq(quota, token.totalQuota(), "quota conservation");
        (ProjectTokenV31.Stream memory ts, ProjectTokenV31.Stream memory qs) = token.rewardState();
        assertEq(token.balanceOf(address(token)), ts.remaining, "reward-token liability");
        assertEq(
            quote.balanceOf(address(token)),
            qs.remaining + token.disposedQuote(),
            "reward-quote and treasury liabilities"
        );
        assertLe(ts.credited, ts.remaining);
        assertLe(qs.credited, qs.remaining);
    }

    function _positionSums() internal view returns (uint256 basis, uint256 shares, uint256 buyers) {
        (,,,,, uint256 count) = raise.accounting();
        uint256 eligibleShares;
        for (uint256 i = 1; i <= count; ++i) {
            V.PositionView memory p = raise.positionState(i);
            basis += p.basis;
            shares += p.shares;
            if (p.class == V.Class.Backer) eligibleShares += p.shares;
            if (p.class == V.Class.Buyer) buyers += p.tokens;
        }
        assertEq(
            raise.eligibleCapital(), Math.mulDiv(eligibleShares, raise.reserveState().J, V.SCALE), "eligible shares"
        );
    }

    function _decayed() internal view returns (PS.Book memory book) {
        V.ReserveState memory b = raise.reserveState();
        V.Deadlines memory d = raise.stageDeadlines();
        uint256 t = Math.min(
            V.SCALE, Math.mulDiv(vm.getBlockTimestamp() - d.stage2Start, V.SCALE, d.stage2End - d.stage2Start)
        );
        (book,,) = ReserveMarket.decay(PS.Book(b.R, b.V, b.T, b.O, b.E), b.X0, b.lastT, t);
    }

    function _assertProduct(PS.Book memory beforeBook) internal view {
        V.ReserveState memory afterBook = raise.reserveState();
        assertGe(
            (afterBook.R + afterBook.V) * afterBook.T,
            (beforeBook.R + beforeBook.V) * beforeBook.T,
            "trade decreased product"
        );
    }

    function _assertExitMath(PS.Book memory pre, V.ExitQuote memory r, uint256 quantity) internal pure {
        uint256 q = pre.R + pre.V;
        uint256 postQ = q - r.result.cost;
        uint256 postT = pre.T - r.bookBurn;
        assertLe(postQ * pre.T, q * postT, "shrink raised price");
        if (q != 0) {
            assertLe(r.bookBurn * q, r.result.cost * pre.T);
            assertLt(r.result.cost * pre.T, (r.bookBurn + 1) * q);
        }
        assertLe(r.result.qSold, quantity);
        uint256 product = (postQ - r.result.profit) * (postT + r.result.qSold);
        assertGe(product, postQ * postT);
        if (r.result.profit != 0) assertLt(product - postQ * postT, postQ - r.result.profit);
        else assertEq(product, postQ * postT);
    }
}

abstract contract InvariantV31Base is BaseV31 {
    V31Handler internal handler;
    function _isBudget() internal pure virtual returns (bool);

    function setUp() public virtual override {
        super.setUp();
        _create(_isBudget());
        address[] memory actors = new address[](11);
        for (uint256 i; i < 10; ++i) {
            actors[i] = backers[i];
        }
        actors[10] = buyer;
        handler = new V31Handler(raise, quote, builder, actors);
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](10);
        selectors[0] = handler.buy.selector;
        selectors[1] = handler.sell.selector;
        selectors[2] = handler.exit.selector;
        selectors[3] = handler.warp.selector;
        selectors[4] = handler.decay.selector;
        selectors[5] = handler.budgetDraw.selector;
        selectors[6] = handler.list.selector;
        selectors[7] = handler.transfer.selector;
        selectors[8] = handler.claimRewards.selector;
        selectors[9] = handler.feeWithdrawal.selector;
        targetSelector(FuzzSelector(address(handler), selectors));
    }

    function invariant_I1_I2_solvency_basis_representationAndNonce() public view {
        handler.checkInvariants();
        assertGe(raise.stateNonce(), handler.lastNonce());
    }

    function test_coverageDriver_allRequiredActionsActuallyExecute() public {
        handler.buy(10, 50000e6);
        handler.sell(10, 1e18);
        handler.warp(10 days);
        handler.exit(1, 1e18, true);
        handler.exit(2, 1e18, false);
        if (_isBudget()) handler.budgetDraw();
        vm.warp(raise.stageDeadlines().stage2End);
        handler.decay();
        handler.list();
        handler.transfer(0, 10, 1e18);
        vm.warp(token.listedAt() + 100 days);
        handler.claimRewards(0);
        handler.checkInvariants();
        assertEq(handler.deposits(), 11);
        assertGt(handler.buys(), 0);
        assertGt(handler.sells(), 0);
        assertGt(handler.costExits(), 0);
        assertGt(handler.profitExits(), 0);
        assertGt(handler.listings(), 0);
        assertGt(handler.transfers(), 0);
        if (_isBudget()) assertGt(handler.draws(), 0);
    }
}

/// forge-config: default.invariant.fail-on-revert = true
contract EscrowInvariantV31Test is InvariantV31Base {
    function _isBudget() internal pure override returns (bool) {
        return false;
    }
}

/// forge-config: default.invariant.fail-on-revert = true
contract BudgetInvariantV31Test is InvariantV31Base {
    function _isBudget() internal pure override returns (bool) {
        return true;
    }
}
