// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IRaiseV31} from "./IRaiseV31.sol";
import {TypesV31 as V} from "./TypesV31.sol";

/// @notice O(1) dissolution funding; isolated exact beneficiary pulls (P §§1,2.1, PS §6). A dissolved launch returns
/// every position's cost; owners claim here or roll the claim into another launch through the pinned router.
contract ClaimVault is Initializable {
    using SafeERC20 for IERC20;
    /// @notice Rollover router allowed to claim on behalf of its caller; zero disables rollover.
    address public immutable router;
    address public raise;
    IERC20 public asset;
    uint256 public liability;
    bool public funded;
    mapping(uint256 => bool) public claimed;
    event DissolutionFunded(address indexed raise, V.Phase phase, uint256 stateNonce, address asset, uint256 amount);
    event ClaimVaultFunded(
        address indexed raise,
        V.Phase phase,
        uint256 stateNonce,
        address indexed beneficiary,
        uint256 id,
        bytes32 claimClass,
        address asset,
        uint256 amount,
        bytes32 reason
    );
    event DissolutionClaimed(
        address indexed raise,
        V.Phase phase,
        uint256 stateNonce,
        address indexed beneficiary,
        uint256 id,
        uint256 amount,
        address indexed recipient
    );

    constructor(address router_) {
        router = router_;
        _disableInitializers();
    }

    /// @notice Pin the dissolution source and asset once (P §§1,2.1).
    function initialize(address raise_, address quote_) external initializer {
        if (raise_ == address(0) || quote_ == address(0)) revert V.InvalidConfig();
        raise = raise_;
        asset = IERC20(quote_);
    }

    /// @notice Back the entire frozen cohort before any claim; no holder-count loop (P §2.4, PS §6).
    function fund(uint256 amount) external {
        if (msg.sender != raise || funded) revert V.Unauthorized();
        if (asset.balanceOf(address(this)) < amount) revert V.WrongAssetDelta();
        funded = true;
        liability = amount;
        emit DissolutionFunded(raise, V.Phase.Dissolved, IRaiseV31(raise).stateNonce(), address(asset), amount);
        emit ClaimVaultFunded(
            raise,
            V.Phase.Dissolved,
            IRaiseV31(raise).stateNonce(),
            address(this),
            0,
            "DissolutionCohort",
            address(asset),
            amount,
            "Dissolution"
        );
    }

    /// @notice Separately funded exact entitlement; one failed recipient cannot block another (P §§1,2.3).
    function claimable(uint256 id) public view returns (uint256 amount) {
        if (!funded || claimed[id]) return 0;
        // Only the named amount/quota is needed here; ownership and class are checked by the corresponding action.
        // forge-lint: disable-next-line(unused-return)
        (,, amount) = IRaiseV31(raise).dissolutionRecord(id);
    }

    /// @notice Unsolicited quote cannot enlarge funded claims or be swept (PS §8; implementation default).
    function custodySurplus() external view returns (uint256) {
        return asset.balanceOf(address(this)) - liability;
    }

    /// @notice Beneficiary-only pull; a failing transfer reverts only this claim (PS §§5–6).
    function claim(uint256 id) external returns (uint256) {
        return _claim(msg.sender, id);
    }

    /// @notice The rollover router claims for its own caller and receives the payment itself (single-transaction
    /// rollover into another launch).
    function claimFor(address owner, uint256 id) external returns (uint256) {
        if (msg.sender != router || router == address(0)) revert V.Unauthorized();
        return _claim(owner, id);
    }

    function _claim(address beneficiary, uint256 id) internal returns (uint256 amount) {
        uint256 nonce = IRaiseV31(raise).beginModuleAction();
        (address owner, V.Class class, uint256 exact) = IRaiseV31(raise).dissolutionRecord(id);
        if (beneficiary != owner || !funded || claimed[id] || exact == 0) revert V.InvalidPosition();
        amount = exact;
        claimed[id] = true;
        liability -= amount;
        // This named bucket/class is a fixed ASCII literal shorter than 32 bytes.
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes32 claimClass = class == V.Class.Backer ? bytes32("Backer") : bytes32("BuilderPurchase");
        // The shared raise action lock covers these interactions and their resulting-nonce events (PS §§2,5).
        // forge-lint: disable-start(reentrancy-events)
        emit ClaimVaultFunded(
            raise, V.Phase.Dissolved, nonce, owner, id, claimClass, address(asset), amount, "Dissolution"
        );
        // forge-lint: disable-end(reentrancy-events)
        address recipient = msg.sender;
        uint256 beforeBalance = asset.balanceOf(recipient);
        uint256 ownBefore = asset.balanceOf(address(this));
        asset.safeTransfer(recipient, amount);
        if (
            // Exact per-call asset deltas are mandatory; unsolicited preexisting balances cancel out (PS §3).
            // forge-lint: disable-next-line(incorrect-strict-equality)
            asset.balanceOf(recipient) - beforeBalance != amount
                // Exact per-call asset deltas are mandatory; unsolicited preexisting balances cancel out (PS §3).
                // forge-lint: disable-next-line(incorrect-strict-equality)
                || ownBefore - asset.balanceOf(address(this)) != amount
        ) {
            revert V.WrongAssetDelta();
        }
        // The shared raise action lock covers these interactions and their resulting-nonce events (PS §§2,5).
        // forge-lint: disable-next-line(reentrancy-events)
        emit DissolutionClaimed(raise, V.Phase.Dissolved, nonce, owner, id, amount, recipient);
        IRaiseV31(raise).endModuleAction();
    }
}
