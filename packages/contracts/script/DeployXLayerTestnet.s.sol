// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/console2.sol";
import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PortexHookMiner} from "../src/v31/venue/PortexHookMiner.sol";
import {UniswapV4Adapter} from "../src/v31/venue/UniswapV4Adapter.sol";
import {PortexSwapRouterV31} from "../src/v31/venue/PortexSwapRouterV31.sol";
import {PortexRegistryV31} from "../src/v31/PortexRegistryV31.sol";
import {RaiseFactoryV31} from "../src/v31/RaiseFactoryV31.sol";
import {RaiseCore} from "../src/v31/RaiseCore.sol";
import {ProjectTokenV31} from "../src/v31/ProjectTokenV31.sol";
import {GovernanceV31} from "../src/v31/GovernanceV31.sol";
import {VestingVaultV31} from "../src/v31/VestingVaultV31.sol";
import {ClaimVault} from "../src/v31/ClaimVault.sol";
import {TreasuryV31} from "../src/v31/TreasuryV31.sol";
import {RolloverRouterV31} from "../src/v31/RolloverRouterV31.sol";
import {MockUSDGV31} from "../src/v31/MockUSDGV31.sol";
import {TypesV31 as V} from "../src/v31/TypesV31.sol";
import {LedgerV31} from "../src/v31/LedgerV31.sol";
import {LifecycleV31} from "../src/v31/LifecycleV31.sol";
import {ViewsV31} from "../src/v31/ViewsV31.sol";
import {TimingProfiles} from "./TimingProfiles.sol";
import {PoolManagerBytecode} from "../test/v31/venue/PoolManagerBytecode.sol";

/// @notice X Layer testnet only. The quote is an unrestricted TEST USDG faucet, never real USDG.
/// @dev Deploys its own PoolManager from the pinned, unmodified Uniswap v4-core v4.0.0 creation code. The third-party
///      testnet PoolManager (0xd443…Eb04) is not canonical v4-core bytecode and must never custody listing principal.
contract DeployXLayerTestnet is Script {
    uint256 public constant CHAIN_ID = 1952;

    struct Deployment {
        address deployer;
        uint256 deploymentBlock;
        PortexRegistryV31 registry;
        RaiseFactoryV31 factory;
        UniswapV4Adapter adapter;
        RolloverRouterV31 rollover;
        PortexRegistryV31.Implementations implementations;
        bytes32 hookSalt;
        PortexSwapRouterV31 router;
        IPoolManager poolManager;
    }

    /// @notice Environment comes only from the invoking process; use deploy-testnet.sh to prevent Foundry dotenv loading.
    function run() external {
        _validateChain();
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(key);
        address attester = vm.envOr("PORTEX_ATTESTER", deployer);
        address council = vm.envOr("PORTEX_COUNCIL", deployer);
        require(attester != address(0) && council != address(0), "testnet roles must be nonzero");
        vm.startBroadcast(key);
        bool testnetTimings = TimingProfiles.isTestnet(vm.envOr("PORTEX_TIMINGS", string("testnet")));
        Deployment memory d = _deploy(deployer, attester, council, testnetTimings);
        vm.stopBroadcast();
        _writeManifest(d);
    }

    function _validateChain() internal view {
        require(block.chainid == CHAIN_ID, "X Layer testnet chain 1952 required");
    }

    /// @notice The pinned v4.0.0 PoolManager, owned by the deployer; its constructor pins NoDelegateCall to itself.
    function _deployPoolManager(address owner) internal returns (IPoolManager manager) {
        bytes memory code = abi.encodePacked(PoolManagerBytecode.creationCode(), abi.encode(owner));
        assembly ("memory-safe") {
            manager := create(0, add(code, 32), mload(code))
        }
        require(address(manager) != address(0) && address(manager).code.length != 0, "PoolManager deployment failed");
        // Exercise both external storage surfaces used by the adapter.
        manager.extsload(bytes32(0));
        manager.exttload(bytes32(0));
    }

    function _deploy(address deployer, address attester, address council, bool testnetTimings)
        internal
        returns (Deployment memory d)
    {
        d.deployer = deployer;
        d.deploymentBlock = block.number;
        MockUSDGV31 quote = new MockUSDGV31();
        d.poolManager = _deployPoolManager(deployer);
        // CREATE from the broadcaster, followed by CREATE2 from the adapter's constructor: no circular setters.
        address predicted = vm.computeCreateAddress(deployer, vm.getNonce(deployer));
        (address predictedHook, bytes32 salt) = PortexHookMiner.find(predicted, d.poolManager);
        d.hookSalt = salt;
        d.adapter = new UniswapV4Adapter(d.poolManager, salt);
        require(
            address(d.adapter) == predicted && d.adapter.initializeHook() == predictedHook, "CREATE address mismatch"
        );
        d.registry = new PortexRegistryV31(deployer);
        if (testnetTimings) {
            console2.log("governed timings: testnet profile (10-minute Stage 1 minimum, 30-minute Stage 2 minimum)");
            d.registry.setProtocolParameters(TimingProfiles.testnet());
        }
        // Factory before implementations: the rollover router checks factory membership, and raises and claim
        // vaults pin the router in their bytecode.
        d.factory = new RaiseFactoryV31(d.registry);
        d.rollover = new RolloverRouterV31(address(d.factory));
        d.implementations = PortexRegistryV31.Implementations(
            address(new RaiseCore(address(d.rollover))),
            address(new ProjectTokenV31()),
            address(new VestingVaultV31()),
            address(new GovernanceV31(V.SPEND_CAP_BPS)),
            address(new ClaimVault(address(d.rollover))),
            address(d.adapter),
            address(quote),
            attester,
            council,
            address(new TreasuryV31())
        );
        d.registry.whitelistQuote(address(quote), false, false, false, true);
        d.registry.publish(V.ESCROW_LAUNCH, 1, d.implementations);
        d.registry.publish(V.BUDGET_LAUNCH, 1, d.implementations);
        // Secondary market for graduated projects: exact-input swaps through the listed Portex pools.
        d.router = new PortexSwapRouterV31(d.poolManager, d.adapter, address(quote));
    }

    function _manifest(Deployment memory d) internal returns (string memory) {
        string memory object = "xlayer-testnet-v31";
        PortexRegistryV31.Implementations memory i = d.implementations;
        vm.serializeUint(object, "chainId", CHAIN_ID);
        vm.serializeUint(object, "deploymentBlock", d.deploymentBlock);
        V.Parameters memory p = d.registry.getVersion(V.ESCROW_LAUNCH, 1).parameters;
        vm.serializeUint(object, "stage1Min", p.stage1Min);
        vm.serializeUint(object, "stage1Max", p.stage1Max);
        vm.serializeUint(object, "stage2Min", p.stage2Min);
        vm.serializeUint(object, "stage2Max", p.stage2Max);
        vm.serializeUint(object, "treasuryVesting", p.treasuryVesting);
        vm.serializeBool(object, "testnetTimings", p.stage1Min < 1 days);
        vm.serializeString(object, "protocol", "3.1");
        vm.serializeBool(object, "simulated", !vm.isContext(VmSafe.ForgeContext.ScriptBroadcast));
        vm.serializeString(object, "network", "X Layer testnet");
        vm.serializeString(object, "quoteLabel", "TEST USDG - unrestricted MockUSDGV31 faucet; no monetary value");
        vm.serializeBool(object, "testQuote", true);
        vm.serializeUint(object, "quoteDecimals", 6);
        vm.serializeAddress(object, "quote", i.quote);
        vm.serializeAddress(object, "mockUSDG", i.quote);
        vm.serializeAddress(object, "poolManager", address(d.poolManager));
        vm.serializeBytes32(object, "poolManagerCodeHash", address(d.poolManager).codehash);
        vm.serializeBool(object, "thirdPartyPoolManager", false);
        vm.serializeString(object, "poolManagerSource", "Uniswap v4-core v4.0.0 PoolManager, pinned creation code");
        vm.serializeAddress(object, "router", address(d.router));
        vm.serializeAddress(object, "deployer", d.deployer);
        vm.serializeAddress(object, "registry", address(d.registry));
        vm.serializeAddress(object, "factory", address(d.factory));
        vm.serializeAddress(object, "adapter", address(d.adapter));
        vm.serializeAddress(object, "initializeHook", d.adapter.initializeHook());
        vm.serializeBytes32(object, "hookSalt", d.hookSalt);
        vm.serializeUint(object, "hookFlags", 0x2000);
        vm.serializeUint(object, "fee", 10000);
        vm.serializeUint(object, "tickSpacing", 200);
        vm.serializeInt(object, "tickLower", -887200);
        vm.serializeInt(object, "tickUpper", 887200);
        vm.serializeAddress(object, "raiseImpl", i.raise);
        vm.serializeAddress(object, "tokenImpl", i.token);
        vm.serializeAddress(object, "vestingImpl", i.vesting);
        vm.serializeAddress(object, "governorImpl", i.governor);
        vm.serializeAddress(object, "claimVaultImpl", i.claims);
        vm.serializeAddress(object, "treasuryImpl", i.treasury);
        vm.serializeAddress(object, "rolloverRouter", address(d.rollover));
        vm.serializeAddress(object, "ledgerLibrary", address(LedgerV31));
        vm.serializeAddress(object, "lifecycleLibrary", address(LifecycleV31));
        vm.serializeAddress(object, "viewsLibrary", address(ViewsV31));
        vm.serializeAddress(object, "attester", i.attester);
        vm.serializeAddress(object, "council", i.council);
        vm.serializeBytes32(object, "escrowTemplate", V.ESCROW_LAUNCH);
        vm.serializeBytes32(object, "budgetTemplate", V.BUDGET_LAUNCH);
        vm.serializeUint(object, "templateVersion", 1);
        vm.serializeString(object, "v4CoreCommit", "e50237c43811bd9b526eff40f26772152a42daba");
        vm.serializeString(object, "v4PeripheryCommit", "9969eec44cfdf07e24b41de47f40276a58401976");
        return vm.serializeBytes32(object, "bundleHash", d.registry.getVersion(V.ESCROW_LAUNCH, 1).bundleHash);
    }

    function _writeManifest(Deployment memory d) internal {
        vm.createDir("deployments", true);
        string memory path = vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)
            ? "deployments/1952-v31.pending.json"
            : "deployments/1952-v31.simulated.json";
        vm.writeJson(_manifest(d), path);
    }
}
