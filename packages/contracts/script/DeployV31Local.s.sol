// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {TypesV31 as V} from "../src/v31/TypesV31.sol";
import {TimingProfiles} from "./TimingProfiles.sol";
import {PortexRegistryV31} from "../src/v31/PortexRegistryV31.sol";
import {RaiseFactoryV31} from "../src/v31/RaiseFactoryV31.sol";
import {RaiseCore} from "../src/v31/RaiseCore.sol";
import {ProjectTokenV31} from "../src/v31/ProjectTokenV31.sol";
import {GovernanceV31} from "../src/v31/GovernanceV31.sol";
import {VestingVaultV31} from "../src/v31/VestingVaultV31.sol";
import {ClaimVault} from "../src/v31/ClaimVault.sol";
import {TreasuryV31} from "../src/v31/TreasuryV31.sol";
import {RolloverRouterV31} from "../src/v31/RolloverRouterV31.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {UniswapV4Adapter} from "../src/v31/venue/UniswapV4Adapter.sol";
import {PortexHookMiner} from "../src/v31/venue/PortexHookMiner.sol";
import {PortexSwapRouterV31} from "../src/v31/venue/PortexSwapRouterV31.sol";
import {PoolManagerBytecode} from "../test/v31/venue/PoolManagerBytecode.sol";
import {MockUSDGV31} from "../src/v31/MockUSDGV31.sol";
import {LedgerV31} from "../src/v31/LedgerV31.sol";
import {LifecycleV31} from "../src/v31/LifecycleV31.sol";
import {ViewsV31} from "../src/v31/ViewsV31.sol";

/// @notice Chain-31337-only package deployment; dry runs use the in-process EVM and never contact anvil (P §§1,7).
contract DeployV31Local is Script {
    // Public, disposable local-development identities. No environment variables or files are read.
    address internal constant DEPLOYER = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    address internal constant ATTESTER = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    address internal constant COUNCIL = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;
    address internal swapRouter;

    /// @notice Deploy both immutable launch templates and write a mode-labelled local manifest (P §§5–7).
    function run() external {
        require(block.chainid == 31337, "local chain only");
        vm.startBroadcast(DEPLOYER);
        MockUSDGV31 quote = new MockUSDGV31();
        UniswapV4Adapter adapter = _venue(address(quote));
        PortexRegistryV31 registry = new PortexRegistryV31(DEPLOYER);
        // Production timings by default; PORTEX_TIMINGS=testnet mirrors the testnet profile.
        if (TimingProfiles.isTestnet(vm.envOr("PORTEX_TIMINGS", string("production")))) {
            registry.setProtocolParameters(TimingProfiles.testnet());
        }
        RaiseFactoryV31 factory = new RaiseFactoryV31(registry);
        RolloverRouterV31 rollover = new RolloverRouterV31(address(factory));
        PortexRegistryV31.Implementations memory implementations = PortexRegistryV31.Implementations(
            address(new RaiseCore(address(rollover))),
            address(new ProjectTokenV31()),
            address(new VestingVaultV31()),
            address(new GovernanceV31(V.SPEND_CAP_BPS)),
            address(new ClaimVault(address(rollover))),
            address(adapter),
            address(quote),
            ATTESTER,
            COUNCIL,
            address(new TreasuryV31())
        );
        registry.whitelistQuote(address(quote), false, false, false, true);
        registry.publish(V.ESCROW_LAUNCH, 1, implementations);
        registry.publish(V.BUDGET_LAUNCH, 1, implementations);
        vm.stopBroadcast();
        _writeManifest(registry, factory, address(rollover), implementations);
    }

    /// @notice Local venue parity with testnet: the real PoolManager bytecode (v4.0.0 fixture), the mined
    ///         beforeInitialize-only hook, the adapter and the secondary-market router.
    function _venue(address quote) internal returns (UniswapV4Adapter adapter) {
        bytes memory code = abi.encodePacked(PoolManagerBytecode.creationCode(), abi.encode(DEPLOYER));
        address manager;
        assembly ("memory-safe") {
            manager := create(0, add(code, 32), mload(code))
        }
        require(manager != address(0), "PoolManager deployment failed");
        // CREATE from the broadcaster, followed by CREATE2 from the adapter's constructor, as on testnet.
        address predicted = vm.computeCreateAddress(DEPLOYER, vm.getNonce(DEPLOYER));
        (, bytes32 salt) = PortexHookMiner.find(predicted, IPoolManager(manager));
        adapter = new UniswapV4Adapter(IPoolManager(manager), salt);
        require(address(adapter) == predicted, "adapter address mismatch");
        swapRouter = address(new PortexSwapRouterV31(IPoolManager(manager), adapter, quote));
    }

    function _writeManifest(
        PortexRegistryV31 registry,
        RaiseFactoryV31 factory,
        address rollover,
        PortexRegistryV31.Implementations memory i
    ) internal {
        string memory key = "portex-v31";
        vm.serializeUint(key, "chainId", 31337);
        vm.serializeString(key, "protocol", "3.1");
        vm.serializeBool(key, "simulated", !vm.isContext(VmSafe.ForgeContext.ScriptBroadcast));
        vm.serializeAddress(key, "deployer", DEPLOYER);
        vm.serializeAddress(key, "registry", address(registry));
        vm.serializeAddress(key, "factory", address(factory));
        vm.serializeAddress(key, "mockUSDG", i.quote);
        // Real venue, as on testnet: the pinned v4.0.0 PoolManager, the mined-hook adapter and the swap router.
        vm.serializeAddress(key, "adapter", i.adapter);
        vm.serializeAddress(key, "poolManager", address(UniswapV4Adapter(i.adapter).poolManager()));
        vm.serializeAddress(key, "initializeHook", UniswapV4Adapter(i.adapter).initializeHook());
        vm.serializeAddress(key, "router", swapRouter);
        vm.serializeUint(key, "fee", 10000);
        vm.serializeUint(key, "tickSpacing", 200);
        vm.serializeAddress(key, "raiseImpl", i.raise);
        vm.serializeUint(key, "raiseRuntimeBytes", i.raise.code.length);
        vm.serializeBytes32(key, "raiseCodeHash", i.raise.codehash);
        vm.serializeAddress(key, "tokenImpl", i.token);
        vm.serializeAddress(key, "vestingImpl", i.vesting);
        vm.serializeAddress(key, "governorImpl", i.governor);
        vm.serializeAddress(key, "claimVaultImpl", i.claims);
        vm.serializeAddress(key, "treasuryImpl", i.treasury);
        vm.serializeAddress(key, "rolloverRouter", rollover);
        vm.serializeAddress(key, "ledgerLibrary", address(LedgerV31));
        vm.serializeAddress(key, "lifecycleLibrary", address(LifecycleV31));
        vm.serializeAddress(key, "viewsLibrary", address(ViewsV31));
        vm.serializeAddress(key, "attester", i.attester);
        vm.serializeAddress(key, "council", i.council);
        vm.serializeBytes32(key, "escrowTemplate", V.ESCROW_LAUNCH);
        vm.serializeBytes32(key, "budgetTemplate", V.BUDGET_LAUNCH);
        vm.serializeUint(key, "templateVersion", 1);
        string memory json = vm.serializeBytes32(key, "bundleHash", registry.getVersion(V.ESCROW_LAUNCH, 1).bundleHash);
        vm.writeJson(json, "deployments/31337-v31.json");
    }
}
