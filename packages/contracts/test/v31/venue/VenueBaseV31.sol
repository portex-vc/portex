// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TypesV31 as V} from "../../../src/v31/TypesV31.sol";
import {RaiseCore} from "../../../src/v31/RaiseCore.sol";
import {ProjectTokenV31} from "../../../src/v31/ProjectTokenV31.sol";
import {VestingVaultV31} from "../../../src/v31/VestingVaultV31.sol";
import {GovernanceV31} from "../../../src/v31/GovernanceV31.sol";
import {ClaimVault} from "../../../src/v31/ClaimVault.sol";
import {TreasuryV31} from "../../../src/v31/TreasuryV31.sol";
import {RolloverRouterV31} from "../../../src/v31/RolloverRouterV31.sol";
import {UniswapV4Adapter} from "../../../src/v31/venue/UniswapV4Adapter.sol";
import {PortexHookMiner} from "../../../src/v31/venue/PortexHookMiner.sol";
import {PoolManagerBytecode} from "./PoolManagerBytecode.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {MockUSDGV31} from "../../../src/v31/MockUSDGV31.sol";
import {PortexRegistryV31} from "../../../src/v31/PortexRegistryV31.sol";
import {RaiseFactoryV31} from "../../../src/v31/RaiseFactoryV31.sol";
import {IDexAdapterV31} from "../../../src/v31/IDexAdapterV31.sol";

abstract contract VenueBaseV31 is Test {
    uint256 internal constant SUPPLY = 1_000_000e18;
    uint256 internal constant TARGET = 0.1e18;
    address internal builder = address(0xB11D);
    address internal treasury = address(0x7777);
    address internal attester = address(0xAA11);
    address internal council = address(0xCC11);
    address internal buyer = address(0xB012);
    address[10] internal backers;
    uint256[10] internal ids;
    MockUSDGV31 internal quote;
    UniswapV4Adapter internal adapter;
    IPoolManager internal manager;
    PortexRegistryV31 internal registry;
    RaiseFactoryV31 internal factory;
    PortexRegistryV31.Implementations internal implementations;
    RaiseCore internal raise;
    ProjectTokenV31 internal token;
    GovernanceV31 internal governor;
    VestingVaultV31 internal vesting;
    ClaimVault internal claims;

    function setUp() public virtual {
        vm.warp(100 days);
        quote = new MockUSDGV31();
        bytes memory managerCode = abi.encodePacked(PoolManagerBytecode.creationCode(), abi.encode(address(this)));
        address deployedManager;
        assembly ("memory-safe") { deployedManager := create(0, add(managerCode, 32), mload(managerCode)) }
        require(deployedManager != address(0), "PoolManager deployment failed");
        manager = IPoolManager(deployedManager);
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        (, bytes32 salt) = PortexHookMiner.find(predicted, manager);
        adapter = new UniswapV4Adapter(manager, salt);
        assertEq(address(adapter), predicted);
        registry = new PortexRegistryV31(address(this));
        factory = new RaiseFactoryV31(registry);
        address router = address(new RolloverRouterV31(address(factory)));
        implementations = PortexRegistryV31.Implementations(
            address(new RaiseCore(router)),
            address(new ProjectTokenV31()),
            address(new VestingVaultV31()),
            address(new GovernanceV31(V.SPEND_CAP_BPS)),
            address(new ClaimVault(router)),
            address(adapter),
            address(quote),
            attester,
            council,
            address(new TreasuryV31())
        );
        registry.whitelistQuote(address(quote), false, false, false, true);
        registry.publish(V.ESCROW_LAUNCH, 1, implementations);
        registry.publish(V.BUDGET_LAUNCH, 1, implementations);
        for (uint256 i; i < 10; ++i) {
            backers[i] = address(uint160(0x1000 + i));
        }
    }

    function _config(bool budget) internal view returns (V.Config memory c) {
        c = V.Config(address(quote), treasury, SUPPLY, TARGET, budget ? 0.3e18 : 0, 15 days, 35 days, new address[](0));
    }

    function _create(bool budget) internal {
        _createWith(_config(budget), budget);
    }

    function _createWith(V.Config memory c, bool budget) internal {
        _createVersion(c, budget, 1);
    }

    function _createVersion(V.Config memory c, bool budget, uint64 version) internal {
        vm.prank(builder);
        raise = RaiseCore(
            factory.createRaise(
                budget ? V.BUDGET_LAUNCH : V.ESCROW_LAUNCH, version, c, RaiseFactoryV31.TokenMeta("Portex v3.1", "PX31")
            )
        );
        V.Modules memory m = raise.modules();
        token = ProjectTokenV31(m.token);
        governor = GovernanceV31(m.governor);
        vesting = VestingVaultV31(m.vesting);
        claims = ClaimVault(m.claims);
        treasury = raise.getConfig().treasury;
    }

    function _deposit(address actor, uint256 amount) internal returns (uint256 id, uint256 tokens) {
        quote.mint(actor, amount);
        vm.prank(actor);
        quote.approve(address(raise), type(uint256).max);
        uint256 nonce = raise.stateNonce();
        vm.prank(actor);
        return raise.deposit(amount, 1, nonce, vm.getBlockTimestamp());
    }

    function _fund() internal {
        for (uint256 i; i < 9; ++i) {
            (ids[i],) = _deposit(backers[i], 1500e6);
        }
        (ids[9],) = _deposit(backers[9], 100000e6);
        (uint256 sold,,,,,) = raise.accounting();
        assertEq(sold, raise.getConfig().supply / 5);
    }

    function _open() internal {
        vm.warp(raise.stageDeadlines().stage1End);
        raise.advanceStage1();
        assertEq(uint256(raise.phase()), uint256(V.Phase.Stage2));
    }

    function _list() internal {
        vm.warp(raise.stageDeadlines().stage2End);
        V.ListingPreview memory preview = raise.listingPreview();
        raise.list();
        _assertReceipt(preview);
        assertEq(uint256(raise.phase()), uint256(V.Phase.Stage3));
    }

    function _buy(address actor, uint256 amount) internal returns (uint256 out) {
        quote.mint(actor, amount);
        vm.prank(actor);
        quote.approve(address(raise), type(uint256).max);
        uint256 nonce = raise.stateNonce();
        vm.prank(actor);
        out = raise.buy(amount, 0, nonce, vm.getBlockTimestamp());
    }

    function _exit(uint256 id, uint256 q, bool protected) internal returns (uint256 payout) {
        address owner = raise.positionState(id).owner;
        uint256 nonce = raise.stateNonce();
        vm.prank(owner);
        if (protected) payout = raise.protectedExit(id, q, 0, nonce, vm.getBlockTimestamp());
        else payout = raise.exitAtCost(id, q, 0, nonce, vm.getBlockTimestamp());
    }

    function _draw(uint256 amount) internal returns (uint256 id) {
        vm.prank(builder);
        id = governor.propose(amount, "ipfs://milestone");
        for (uint256 i; i < 10; ++i) {
            if (raise.guaranteedClaim(ids[i]).amount == 0) continue;
            vm.prank(backers[i]);
            governor.vote(id, ids[i], true);
        }
        GovernanceV31.Proposal memory p = governor.getProposal(id);
        vm.warp(p.votingEnds);
        governor.finalize(id);
        vm.warp(p.disputeEnds);
        governor.execute(id);
    }

    function _assertBook() internal view {
        V.ReserveState memory b = raise.reserveState();
        (,, uint256 reward, uint256 team) = _feesAndDust();
        (,,,, uint256 dust, uint256 count) = raise.accounting();
        assertEq(quote.balanceOf(address(raise)), b.E + b.R + reward + team + dust);
        assertEq(token.totalSupply() + token.burned(), raise.getConfig().supply);
        uint256 basis;
        uint256 shares;
        uint256 eligibleShares;
        uint256 buyers;
        for (uint256 i = 1; i <= count; ++i) {
            V.PositionView memory p = raise.positionState(i);
            basis += p.basis;
            shares += p.shares;
            if (p.class == V.Class.Backer) eligibleShares += p.shares;
            if (p.class == V.Class.Buyer && raise.phase() != V.Phase.Stage3) buyers += p.tokens;
        }
        assertEq(raise.eligibleCapital(), Math.mulDiv(eligibleShares, b.J, V.SCALE));
        if (raise.phase() != V.Phase.Stage3 && raise.phase() != V.Phase.Dissolved) {
            assertEq(shares, b.H);
            assertLe(basis, b.E);
            if (raise.getConfig().budgetCeiling == 0 || b.claimCount <= 1) assertEq(basis, b.E);
        }
        if (raise.phase() == V.Phase.Stage2 || raise.phase() == V.Phase.ListingPending) {
            assertGe(b.R * b.T, b.V * b.O);
            assertEq(b.O, buyers);
            assertEq(b.V - b.E, Math.mulDiv(b.X0, V.SCALE - b.lastT, V.SCALE));
        }
    }

    function _feesAndDust() internal view returns (uint256 unused, uint256 reserve, uint256 reward, uint256 team) {
        (reserve, reward, team) = raise.feeAccruals();
        return (0, reserve, reward, team);
    }

    function _assertReceipt(V.ListingPreview memory preview) internal view {
        IDexAdapterV31.Receipt memory receipt = raise.listingRecord();
        (uint160 storedPrice,,,) = StateLibrary.getSlot0(manager, PoolId.wrap(receipt.poolId));
        assertEq(storedPrice, preview.sqrtPriceX96);
        assertEq(StateLibrary.getLiquidity(manager, PoolId.wrap(receipt.poolId)), receipt.liquidity);
        assertEq(receipt.owner, address(raise));
        assertEq(receipt.sqrtPriceX96, preview.sqrtPriceX96);
        assertEq(receipt.liquidity, preview.liquidity);
        assertEq(receipt.usedQuote, preview.usedQuote);
        assertEq(receipt.usedToken, preview.usedToken);
        assertEq(keccak256(abi.encode(adapter.position(receipt.positionId))), keccak256(abi.encode(receipt)));
    }
}
