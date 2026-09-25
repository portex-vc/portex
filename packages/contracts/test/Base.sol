// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {RaiseConfig, TokenMeta, GovernorConfig} from "../src/libraries/PortexTypes.sol";
import {PortexRegistry} from "../src/PortexRegistry.sol";
import {AttestationBoard} from "../src/AttestationBoard.sol";
import {Raise} from "../src/Raise.sol";
import {Stage2Pool} from "../src/Stage2Pool.sol";
import {DiamondVault} from "../src/DiamondVault.sol";
import {ProjectToken} from "../src/ProjectToken.sol";
import {RaiseFactory} from "../src/RaiseFactory.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {MockDexAdapter} from "../src/mocks/MockDexAdapter.sol";

/// @notice Shared deployment + config + state-machine helpers for all tests.
contract BaseTest is Test {
    uint256 internal constant BPS = 10_000;
    bytes32 internal constant ZERO_EXTRACTION = keccak256("ZERO_EXTRACTION");
    bytes32 internal constant MILESTONE_FUNDING = keccak256("MILESTONE_FUNDING");

    MockUSDG internal usdg;
    PortexRegistry internal registry;
    AttestationBoard internal board;
    MockDexAdapter internal adapter;
    Raise internal raiseImpl;
    Stage2Pool internal poolImpl;
    DiamondVault internal vaultImpl;
    ProjectToken internal tokenImpl;
    RaiseFactory internal factory;

    address internal curator = makeAddr("curator");
    address internal attester = makeAddr("attester");
    address internal council = makeAddr("council");
    address internal feeRecipient = makeAddr("feeRecipient");

    address internal builder = makeAddr("builder");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal whale = makeAddr("whale");

    Raise internal raise;
    Stage2Pool internal pool;
    DiamondVault internal vault;
    ProjectToken internal token;

    function setUp() public virtual {
        usdg = new MockUSDG();
        registry = new PortexRegistry(curator);
        board = new AttestationBoard(attester, council);
        adapter = new MockDexAdapter();
        raiseImpl = new Raise();
        poolImpl = new Stage2Pool();
        vaultImpl = new DiamondVault();
        tokenImpl = new ProjectToken();
        factory = new RaiseFactory(registry, board, address(tokenImpl), feeRecipient, curator);
        board.setFactory(address(factory)); // test contract is the board deployer
        vm.prank(curator);
        factory.setQuoteAsset(address(usdg), true);
        vm.prank(curator);
        registry.publish(
            ZERO_EXTRACTION, 1, address(raiseImpl), address(poolImpl), address(vaultImpl), address(0), address(adapter)
        );

        address[5] memory actors = [builder, alice, bob, carol, whale];
        for (uint256 i = 0; i < actors.length; ++i) {
            usdg.mint(actors[i], 10_000_000e6);
        }
    }

    /// @dev Localhost demo timings from design §4.
    function defaultConfig() internal view returns (RaiseConfig memory) {
        return RaiseConfig({
            quoteAsset: address(usdg),
            softCap: 50_000e6,
            hardCap: 200_000e6,
            minIncubation: 10 minutes,
            deadline: 30 minutes,
            totalSupply: 1_000_000e18,
            stage1Alloc: 200_000e18, // A1 = 20%
            stage2Inventory: 400_000e18, // T0 = 40%
            vaultAlloc: 100_000e18, // 10%
            builderAlloc: 300_000e18, // 30%
            commitmentWindow: 5 minutes,
            epochLength: 5 minutes,
            numTranches: 4,
            minOptInBps: 3000,
            swapFeeBps: 100,
            feeReserveBps: 4000,
            feeVaultBps: 3000,
            feeBuilderBps: 3000,
            minGraduationLiquidity: 20_000e6,
            minRealRatioBps: 5000,
            builderVesting: 20 minutes,
            vaultDuration: 20 minutes,
            vetoMaxDelay: 5 minutes,
            vetoCooldown: 10 minutes,
            maxCumulativeSpendBps: 0,
            governor: GovernorConfig({
                votingPeriod: 5 minutes,
                disputeWindow: 5 minutes,
                minProposalInterval: 10 minutes,
                quorumBps: 4000,
                approvalBps: 6000
            })
        });
    }

    function createRaise() internal returns (Raise) {
        return createRaise(defaultConfig());
    }

    function createRaise(RaiseConfig memory cfg) internal returns (Raise) {
        vm.prank(builder);
        address addr = factory.createRaise(ZERO_EXTRACTION, 1, cfg, TokenMeta({name: "Test Project", symbol: "TPJ"}));
        raise = Raise(payable(addr));
        pool = raise.pool();
        vault = raise.vault();
        token = raise.token();
        return raise;
    }

    /// @dev Publish MILESTONE_FUNDING v1 with a given governor implementation.
    function publishMilestoneFunding(address governorImpl_) internal {
        vm.prank(curator);
        registry.publish(
            MILESTONE_FUNDING,
            1,
            address(raiseImpl),
            address(poolImpl),
            address(vaultImpl),
            governorImpl_,
            address(adapter)
        );
    }

    /// @dev Create a governed raise (Rule 2): 30% cumulative ceiling, demo governor timings.
    function createGovRaise() internal returns (Raise) {
        return createGovRaise(defaultConfig());
    }

    function createGovRaise(RaiseConfig memory cfg) internal returns (Raise) {
        cfg.maxCumulativeSpendBps = 3000;
        vm.prank(builder);
        address addr = factory.createRaise(MILESTONE_FUNDING, 1, cfg, TokenMeta({name: "Gov Project", symbol: "GPJ"}));
        raise = Raise(payable(addr));
        pool = raise.pool();
        vault = raise.vault();
        token = raise.token();
        return raise;
    }

    function depositAs(address user, uint256 amount) internal {
        vm.startPrank(user);
        usdg.approve(address(raise), amount);
        raise.deposit(amount);
        vm.stopPrank();
    }

    function withdrawAs(address user, uint256 amount) internal {
        vm.prank(user);
        raise.withdraw(amount);
    }

    function commitAs(address user, uint8 k) internal {
        vm.prank(user);
        raise.commit(k);
    }

    function claimAs(address user, uint8 k, bool stake) internal {
        vm.prank(user);
        raise.claim(k, stake);
    }

    function redeemAs(address user, uint8 k) internal {
        vm.prank(user);
        raise.redeem(k);
    }

    function buyAs(address user, uint256 quoteIn) internal returns (uint256 out_) {
        vm.startPrank(user);
        usdg.approve(address(pool), quoteIn);
        out_ = pool.buy(quoteIn, 0);
        vm.stopPrank();
    }

    function sellAs(address user, uint256 tokensIn) internal returns (uint256 out_) {
        vm.startPrank(user);
        token.approve(address(pool), tokensIn);
        out_ = pool.sell(tokensIn, 0);
        vm.stopPrank();
    }

    /// @dev Deposit three backers (100k/60k/40k = 200k at the hard cap) and open the window.
    function toCommitment() internal {
        depositAs(alice, 100_000e6);
        depositAs(bob, 60_000e6);
        depositAs(carol, 40_000e6);
        vm.warp(block.timestamp + 10 minutes);
        raise.startCommitment();
    }

    /// @dev Epoch-0: all three backers commit tranche 1 (50% opt-in), then open the pool.
    function toGrowth() internal {
        toCommitment();
        commitAs(alice, 1);
        commitAs(bob, 1);
        commitAs(carol, 1);
        vm.warp(block.timestamp + 5 minutes);
        raise.openGrowth();
    }
}
