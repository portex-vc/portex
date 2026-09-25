// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {PortexRegistry} from "../src/PortexRegistry.sol";
import {AttestationBoard} from "../src/AttestationBoard.sol";
import {MockDexAdapter} from "../src/mocks/MockDexAdapter.sol";
import {Raise} from "../src/Raise.sol";
import {Stage2Pool} from "../src/Stage2Pool.sol";
import {DiamondVault} from "../src/DiamondVault.sol";
import {ProjectToken} from "../src/ProjectToken.sol";
import {SpendGovernor} from "../src/SpendGovernor.sol";
import {RaiseFactory} from "../src/RaiseFactory.sol";

/// @notice Local deployment for anvil (chain 31337). Deployer/curator = anvil account #0,
///         attester = account #1, council = account #2. Implementations are deployed with
///         CREATE2 (deterministic: same bytecode + salt → same address on every chain).
///         Publishes ZERO_EXTRACTION v1 and MILESTONE_FUNDING v1, both pinning the mock DEX
///         adapter. Writes deployments/31337.json.
contract DeployLocal is Script {
    bytes32 internal constant ZERO_EXTRACTION = keccak256("ZERO_EXTRACTION");
    bytes32 internal constant MILESTONE_FUNDING = keccak256("MILESTONE_FUNDING");

    // anvil well-known accounts
    address internal constant ATTESTER = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8; // #1
    address internal constant COUNCIL = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC; // #2

    function run() external {
        uint256 deployerKey =
            vm.envOr("PRIVATE_KEY", uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80));
        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        MockUSDG usdg = new MockUSDG();
        PortexRegistry registry = new PortexRegistry(deployer); // curator = deployer
        AttestationBoard board = new AttestationBoard(ATTESTER, COUNCIL);
        MockDexAdapter adapter = new MockDexAdapter();

        Raise raiseImpl = new Raise{salt: keccak256("portex.v1.raise")}();
        Stage2Pool poolImpl = new Stage2Pool{salt: keccak256("portex.v1.pool")}();
        DiamondVault vaultImpl = new DiamondVault{salt: keccak256("portex.v1.vault")}();
        ProjectToken tokenImpl = new ProjectToken{salt: keccak256("portex.v1.token")}();
        SpendGovernor governorImpl = new SpendGovernor{salt: keccak256("portex.v1.governor")}();

        RaiseFactory factory = new RaiseFactory(registry, board, address(tokenImpl), deployer, deployer);
        board.setFactory(address(factory));
        factory.setQuoteAsset(address(usdg), true);
        registry.publish(
            ZERO_EXTRACTION, 1, address(raiseImpl), address(poolImpl), address(vaultImpl), address(0), address(adapter)
        );
        registry.publish(
            MILESTONE_FUNDING,
            1,
            address(raiseImpl),
            address(poolImpl),
            address(vaultImpl),
            address(governorImpl),
            address(adapter)
        );

        vm.stopBroadcast();

        string memory json = "portex";
        vm.serializeUint(json, "chainId", 31337);
        vm.serializeAddress(json, "deployer", deployer);
        vm.serializeAddress(json, "attester", ATTESTER);
        vm.serializeAddress(json, "council", COUNCIL);
        vm.serializeAddress(json, "mockUSDG", address(usdg));
        vm.serializeAddress(json, "registry", address(registry));
        vm.serializeAddress(json, "attestationBoard", address(board));
        vm.serializeAddress(json, "dexAdapter", address(adapter));
        vm.serializeAddress(json, "factory", address(factory));
        vm.serializeAddress(json, "raiseImpl", address(raiseImpl));
        vm.serializeAddress(json, "poolImpl", address(poolImpl));
        vm.serializeAddress(json, "vaultImpl", address(vaultImpl));
        vm.serializeAddress(json, "tokenImpl", address(tokenImpl));
        vm.serializeAddress(json, "governorImpl", address(governorImpl));
        vm.serializeBytes32(json, "templateZeroExtraction", ZERO_EXTRACTION);
        vm.serializeUint(json, "templateZeroExtractionVersion", 1);
        vm.serializeBytes32(json, "templateMilestoneFunding", MILESTONE_FUNDING);
        string memory out = vm.serializeUint(json, "templateMilestoneFundingVersion", 1);
        vm.writeJson(out, "deployments/31337.json");
    }
}
