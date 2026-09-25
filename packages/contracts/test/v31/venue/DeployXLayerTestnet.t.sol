// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {DeployXLayerTestnet} from "../../../script/DeployXLayerTestnet.s.sol";
import {PoolManagerBytecode} from "./PoolManagerBytecode.sol";
import {PortexRegistryV31} from "../../../src/v31/PortexRegistryV31.sol";
import {RaiseFactoryV31} from "../../../src/v31/RaiseFactoryV31.sol";
import {MockUSDGV31} from "../../../src/v31/MockUSDGV31.sol";
import {UniswapV4Adapter} from "../../../src/v31/venue/UniswapV4Adapter.sol";
import {PortexSwapRouterV31} from "../../../src/v31/venue/PortexSwapRouterV31.sol";
import {PortexInitHook} from "../../../src/v31/venue/PortexInitHook.sol";
import {TypesV31 as V} from "../../../src/v31/TypesV31.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";

interface IOwned {
    function owner() external view returns (address);
}

contract DeploymentHarness is DeployXLayerTestnet {
    function validate() external view {
        _validateChain();
    }

    function simulate(address deployer, address attester, address council) external returns (string memory) {
        return simulate(deployer, attester, council, true);
    }

    function simulate(address deployer, address attester, address council, bool testnetTimings)
        public
        returns (string memory)
    {
        _validateChain();
        vm.startBroadcast(deployer);
        Deployment memory d = _deploy(deployer, attester, council, testnetTimings);
        vm.stopBroadcast();
        return _manifest(d);
    }
}

contract DeployXLayerTestnetTest is Test {
    DeploymentHarness internal script;
    address internal constant DEPLOYER = address(0xD311);
    address internal constant ATTESTER = address(0xA771);
    address internal constant COUNCIL = address(0xC011);
    address internal constant THIRD_PARTY_MANAGER = 0xd44387034102491Af58292fF1c7405AED4e7Eb04;

    function setUp() public {
        script = new DeploymentHarness();
    }

    function test_wrongChainAbortsBeforeEnvironmentOrDeployment() public {
        vm.chainId(31337);
        vm.expectRevert("X Layer testnet chain 1952 required");
        script.run();
    }

    /// The third-party testnet PoolManager is not canonical v4-core; the script deploys the pinned v4.0.0 bytecode.
    function test_scriptDeploysItsOwnCanonicalPoolManager() public {
        vm.chainId(1952);
        vm.deal(DEPLOYER, 100 ether);
        string memory json = script.simulate(DEPLOYER, ATTESTER, COUNCIL);
        address manager = vm.parseJsonAddress(json, ".poolManager");
        assertTrue(manager != THIRD_PARTY_MANAGER);
        assertEq(THIRD_PARTY_MANAGER.code.length, 0);
        assertFalse(vm.parseJsonBool(json, ".thirdPartyPoolManager"));
        assertEq(vm.parseJsonBytes32(json, ".poolManagerCodeHash"), manager.codehash);
        assertEq(IOwned(manager).owner(), DEPLOYER);
        // Byte-identical to the pinned fixture, apart from NoDelegateCall's immutable self address.
        address fixture;
        bytes memory init = abi.encodePacked(PoolManagerBytecode.creationCode(), abi.encode(DEPLOYER));
        assembly ("memory-safe") {
            fixture := create(0, add(init, 32), mload(init))
        }
        bytes memory expected = fixture.code;
        bytes memory actual = manager.code;
        assertEq(expected.length, actual.length);
        uint256 replaced;
        for (uint256 i; i + 20 <= expected.length; ++i) {
            bytes20 word;
            assembly ("memory-safe") {
                word := mload(add(add(expected, 32), i))
            }
            if (word != bytes20(fixture)) continue;
            for (uint256 j; j < 20; ++j) {
                expected[i + j] = bytes20(manager)[j];
            }
            ++replaced;
        }
        assertGt(replaced, 0);
        assertEq(keccak256(expected), keccak256(actual));
        PortexSwapRouterV31 swapRouter = PortexSwapRouterV31(vm.parseJsonAddress(json, ".router"));
        assertEq(address(swapRouter.poolManager()), manager);
        assertEq(address(UniswapV4Adapter(vm.parseJsonAddress(json, ".adapter")).poolManager()), manager);
    }

    function test_scriptDeploysRealVenueBothTemplatesAndManifestWithoutSecrets() public {
        vm.chainId(1952);
        vm.deal(DEPLOYER, 100 ether);
        string memory json = script.simulate(DEPLOYER, ATTESTER, COUNCIL);
        assertTrue(vm.parseJsonBool(json, ".simulated"));
        assertTrue(vm.parseJsonBool(json, ".testQuote"));
        assertEq(vm.parseJsonUint(json, ".chainId"), 1952);
        assertEq(vm.parseJsonUint(json, ".quoteDecimals"), 6);
        address manager = vm.parseJsonAddress(json, ".poolManager");
        PortexSwapRouterV31 swapRouter = PortexSwapRouterV31(vm.parseJsonAddress(json, ".router"));
        assertEq(address(swapRouter.poolManager()), manager);
        assertEq(address(swapRouter.adapter()), vm.parseJsonAddress(json, ".adapter"));
        assertEq(swapRouter.quote(), vm.parseJsonAddress(json, ".quote"));
        assertEq(
            vm.parseJsonString(json, ".quoteLabel"), "TEST USDG - unrestricted MockUSDGV31 faucet; no monetary value"
        );
        PortexRegistryV31 registry = PortexRegistryV31(vm.parseJsonAddress(json, ".registry"));
        RaiseFactoryV31 factory = RaiseFactoryV31(vm.parseJsonAddress(json, ".factory"));
        assertEq(registry.curator(), DEPLOYER);
        assertEq(address(factory.registry()), address(registry));
        PortexRegistryV31.TemplateVersion memory escrow = registry.getVersion(V.ESCROW_LAUNCH, 1);
        PortexRegistryV31.TemplateVersion memory budget = registry.getVersion(V.BUDGET_LAUNCH, 1);
        assertEq(escrow.bundleHash, budget.bundleHash);
        assertEq(escrow.bundleHash, vm.parseJsonBytes32(json, ".bundleHash"));
        assertEq(escrow.implementations.attester, ATTESTER);
        assertEq(escrow.implementations.council, COUNCIL);
        assertEq(registry.versionCount(V.ESCROW_LAUNCH), 1);
        assertEq(registry.versionCount(V.BUDGET_LAUNCH), 1);
        assertLe(escrow.implementations.raise.code.length, 24576);
        assertTrue(registry.quoteFrozen(escrow.implementations.quote));
        MockUSDGV31 quote = MockUSDGV31(escrow.implementations.quote);
        quote.mint(address(this), 42e6);
        assertEq(quote.balanceOf(address(this)), 42e6);
        UniswapV4Adapter adapter = UniswapV4Adapter(escrow.implementations.adapter);
        assertEq(address(adapter.poolManager()), manager);
        address hook = adapter.initializeHook();
        assertEq(hook, vm.parseJsonAddress(json, ".initializeHook"));
        assertEq(uint160(hook) & Hooks.ALL_HOOK_MASK, 0x2000);
        assertEq(PortexInitHook(hook).adapter(), address(adapter));
        assertLe(address(adapter).code.length, 24576);
    }

    /// Testnet timings are set through the curator's governed-parameter setter and pinned into both versions.
    function test_testnetTimingsArePublishedAndInTheManifest() public {
        vm.chainId(1952);
        vm.deal(DEPLOYER, 100 ether);
        string memory json = script.simulate(DEPLOYER, ATTESTER, COUNCIL);
        PortexRegistryV31 registry = PortexRegistryV31(vm.parseJsonAddress(json, ".registry"));
        assertTrue(vm.parseJsonBool(json, ".testnetTimings"));
        for (uint256 i; i < 2; ++i) {
            V.Parameters memory p = registry.getVersion(i == 0 ? V.ESCROW_LAUNCH : V.BUDGET_LAUNCH, 1).parameters;
            assertEq(p.stage1Min, 10 minutes);
            assertEq(p.stage1Max, 60 days);
            assertEq(p.stage2Min, 30 minutes);
            assertEq(p.stage2Max, 70 days);
            assertEq(p.treasuryVesting, 7 days);
            assertLe(uint256(p.voting) + p.dispute + p.execution, p.stage2Min);
        }
        assertEq(vm.parseJsonUint(json, ".stage1Min"), 10 minutes);
        assertEq(vm.parseJsonUint(json, ".stage2Min"), 30 minutes);
        assertEq(vm.parseJsonUint(json, ".treasuryVesting"), 7 days);
        assertEq(vm.parseJsonUint(json, ".deploymentBlock"), block.number);
    }

    function test_productionTimingsOptOut() public {
        vm.chainId(1952);
        vm.deal(DEPLOYER, 100 ether);
        string memory json = script.simulate(DEPLOYER, ATTESTER, COUNCIL, false);
        PortexRegistryV31 registry = PortexRegistryV31(vm.parseJsonAddress(json, ".registry"));
        assertFalse(vm.parseJsonBool(json, ".testnetTimings"));
        V.Parameters memory p = registry.getVersion(V.ESCROW_LAUNCH, 1).parameters;
        assertEq(p.stage1Min, 15 days);
        assertEq(p.stage2Min, 35 days);
        assertEq(p.treasuryVesting, 1825 days);
    }

    function test_mainnetRefused() public {
        vm.chainId(196);
        vm.expectRevert("X Layer testnet chain 1952 required");
        script.run();
    }
}
