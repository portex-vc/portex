// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IRaiseV31} from "./IRaiseV31.sol";
import {TypesV31 as V} from "./TypesV31.sol";

/// @notice Protocol-custodied ERC-20, automatic lazy delivery and Diamond Hand streams (P §§2.2,12).
contract ProjectTokenV31 is ERC20Upgradeable {
    using SafeERC20 for IERC20;

    struct Stream {
        uint256 allocation;
        uint256 released;
        uint256 accumulator;
        uint256 carry;
        uint256 remaining;
        uint256 credited;
    }

    struct Account {
        // Quota/token credits are bounded by the <= 1e30 supply; fractions are below 1e18.
        uint128 quota;
        bool initialized;
        bool delivered;
        uint256 paidToken;
        uint256 paidQuote;
        uint64 fractionToken;
        uint64 fractionQuote;
        uint128 creditToken;
        uint256 creditQuote;
        uint256 finalEpoch;
    }

    address public raise;
    address public quote;
    address public treasury;
    address public vesting;
    address public adapter;
    uint64 public listedAt;
    uint256 public burned;
    uint256 public pendingDelivery;
    uint256 public totalQuota;
    uint256 public activeQuotaHolders;
    uint256 public finalAccountedHolders;
    uint256 public finalEpoch;
    bool private transient entered;
    uint256 public disposedQuote;
    uint256 public rewardNonce;
    bool public disposed;
    Stream private tokenStream;
    Stream private quoteStream;
    mapping(address => Account) private accounts;
    /// @notice Governor allowed to open a balance snapshot for a Stage 3 treasury vote.
    address public governor;
    /// @notice Latest snapshot id; balances are recorded lazily, only when they change while it is current.
    uint256 public snapshotId;
    /// @notice Block in which the current snapshot opened; it measures balances at the end of that block.
    uint256 public snapshotBlock;
    mapping(address => uint256) private snapshotted;
    mapping(address => uint256) private snapshotBalance;

    event QuotaDestroyed(
        address indexed raise,
        V.Phase phase,
        uint256 stateNonce,
        uint256 rewardNonce,
        address indexed owner,
        uint256 amount,
        uint256 remainingQuota
    );
    event RewardsClaimed(
        address indexed raise,
        V.Phase phase,
        uint256 stateNonce,
        uint256 rewardNonce,
        address indexed owner,
        uint256 tokenAmount,
        uint256 quoteAmount
    );
    event TokensBurned(
        address indexed raise,
        V.Phase phase,
        uint256 stateNonce,
        uint256 rewardNonce,
        bytes32 indexed bucket,
        uint256 amount
    );
    event RewardsDisposed(
        address indexed raise,
        V.Phase phase,
        uint256 stateNonce,
        uint256 rewardNonce,
        uint256 quoteAmount,
        uint256 tokenBurn
    );
    event DisposedClaimed(
        address indexed raise,
        V.Phase phase,
        uint256 stateNonce,
        uint256 rewardNonce,
        address indexed treasury,
        uint256 quoteAmount
    );
    event RewardsCheckpointed(
        address indexed raise, V.Phase phase, uint256 stateNonce, uint256 rewardNonce, address indexed owner
    );
    event TokenActivated(
        address indexed raise,
        V.Phase phase,
        uint256 stateNonce,
        uint64 listedAt,
        uint256 liquidDelivery,
        uint256 quota,
        uint256 rewardTokens,
        uint256 rewardQuote
    );

    constructor() {
        _disableInitializers();
    }

    modifier onlyRaise() {
        if (msg.sender != raise) revert V.Unauthorized();
        _;
    }
    modifier tokenAction() {
        if (entered) revert V.Reentrancy();
        entered = true;
        _;
        entered = false;
    }

    modifier rewardAction() {
        ++rewardNonce;
        _;
    }

    /// @notice Mint the sole initial supply to protocol custody, once (P §3, PS §1).
    function initialize(
        string calldata name_,
        string calldata symbol_,
        uint256 supply,
        address raise_,
        V.Modules calldata modules,
        address quote_,
        address treasury_
    ) external initializer {
        __ERC20_init(name_, symbol_);
        if (raise_ == address(0) || quote_ == address(0) || treasury_ == address(0)) revert V.InvalidConfig();
        raise = raise_;
        quote = quote_;
        treasury = treasury_;
        vesting = modules.vesting;
        adapter = modules.adapter;
        governor = modules.governor;
        _mint(raise_, supply);
    }

    /// @notice Only authenticated custody may move pre-list tokens (P §§5.16,12.1).
    function custodyMove(address to, uint256 amount) external onlyRaise {
        if (entered) revert V.Reentrancy();
        if (to == address(0)) revert V.InvalidConfig();
        _update(raise, to, amount);
    }

    /// @notice A pinned adapter may settle authenticated listing custody into its venue before public transfers open (P §12.1.5).
    function adapterCustodyTransfer(address venue, uint256 amount) external {
        if (msg.sender != adapter || entered || listedAt != 0 || IRaiseV31(raise).phase() != V.Phase.Stage3) {
            revert V.Unauthorized();
        }
        if (venue == address(0)) revert V.InvalidConfig();
        _update(adapter, venue, amount);
    }

    /// @notice Burn unused/retired custody with a named source bucket (PS §§3,5,7).
    function custodyBurn(uint256 amount, bytes32 bucket) external onlyRaise {
        if (entered) revert V.Reentrancy();
        _burnCustody(raise, amount, bucket);
    }

    /// @notice Expose all frozen ordinary credits immediately and initialize surviving quota (P §12.1 steps 4,10).
    function activate(
        uint256 liquidDelivery,
        uint256 quota,
        uint256 holderCount,
        uint256 rewardTokens,
        uint256 rewardQuote
    ) external onlyRaise {
        if (listedAt != 0 || entered) revert V.InvalidPhase();
        if (super.balanceOf(address(this)) < rewardTokens || IERC20(quote).balanceOf(address(this)) < rewardQuote) {
            revert V.WrongAssetDelta();
        }
        listedAt = SafeCast.toUint64(block.timestamp);
        pendingDelivery = liquidDelivery;
        totalQuota = quota;
        activeQuotaHolders = holderCount;
        finalEpoch = 1;
        tokenStream.allocation = rewardTokens;
        tokenStream.remaining = rewardTokens;
        quoteStream.allocation = rewardQuote;
        quoteStream.remaining = rewardQuote;
        // Token-local actions and authenticated custody protect these interactions; events carry the frozen raise nonce and token-local reward nonce (PS §5).
        // forge-lint: disable-start(reentrancy-events)
        emit TokenActivated(
            raise,
            V.Phase.Stage3,
            IRaiseV31(raise).stateNonce(),
            listedAt,
            liquidDelivery,
            quota,
            rewardTokens,
            rewardQuote
        );
        // forge-lint: disable-end(reentrancy-events)
        if (quota == 0) ++rewardNonce;
        _disposeIfComplete();
    }

    /// @notice Lazy delivery is visible without an opt-in claim or holder loop (P §12.1 implementation default).
    function balanceOf(address owner) public view override returns (uint256 amount) {
        amount = super.balanceOf(owner);
        if (listedAt == 0) return amount;
        if (owner == raise) return amount - pendingDelivery;
        if (!accounts[owner].delivered) {
            // Only the named amount/quota is needed here; ownership and class are checked by the corresponding action.
            // forge-lint: disable-next-line(unused-return)
            (uint256 credit,) = IRaiseV31(raise).deliveryOf(owner);
            amount += credit;
        }
    }

    /// @notice Public transfers checkpoint, then destroy sender quota even on self-transfer (P §12.2).
    function transfer(address to, uint256 amount) public override tokenAction returns (bool) {
        _beforePublicTransfer(msg.sender, amount);
        return super.transfer(to, amount);
    }

    /// @notice Delegated transfers use the identical quota-first rule (P §12.2).
    function transferFrom(address from, address to, uint256 amount) public override tokenAction returns (bool) {
        _beforePublicTransfer(from, amount);
        return super.transferFrom(from, to, amount);
    }

    /// @notice Allowances are token-local and never invalidate executable raise quotes (PS §5).
    function approve(address spender, uint256 amount) public override tokenAction returns (bool) {
        return super.approve(spender, amount);
    }

    /// @notice Authenticated vesting payment is part of the vault's existing action (P §2.2, PS §5).
    function vestingTransfer(address to, uint256 amount) external {
        if (msg.sender != vesting || listedAt == 0 || entered) revert V.Unauthorized();
        _update(vesting, to, amount);
    }

    /// @notice Authenticated LP fee transfer; no principal removal surface exists (P §12.1).
    function adapterFeeTransfer(address to, uint256 amount) external {
        if (msg.sender != adapter || to != treasury || listedAt == 0 || entered) revert V.Unauthorized();
        _update(adapter, to, amount);
    }

    /// @notice Permissionless checkpoint of one holder, including final dust accounting (P §12.2).
    function checkpoint(address owner) external tokenAction rewardAction {
        if (listedAt == 0) revert V.InvalidPhase();
        _accrue();
        _checkpoint(owner);
        _disposeIfComplete();
        // The token-local guard covers the checkpoint and its resulting-nonce event.
        // forge-lint: disable-next-line(reentrancy-events)
        emit RewardsCheckpointed(raise, V.Phase.Stage3, IRaiseV31(raise).stateNonce(), rewardNonce, owner);
    }

    /// @notice Pull both accrued reward assets without changing quota (P §12.2, PS §5).
    function claimRewards() external tokenAction rewardAction returns (uint256 tokens, uint256 quoteAmount) {
        if (listedAt == 0) revert V.InvalidPhase();
        _accrue();
        _checkpoint(msg.sender);
        Account storage a = accounts[msg.sender];
        tokens = a.creditToken;
        quoteAmount = a.creditQuote;
        if (tokens == 0 && quoteAmount == 0) revert V.InvalidAmount();
        a.creditToken = 0;
        a.creditQuote = 0;
        tokenStream.credited -= tokens;
        quoteStream.credited -= quoteAmount;
        tokenStream.remaining -= tokens;
        quoteStream.remaining -= quoteAmount;
        _disposeIfComplete();
        if (tokens != 0) _update(address(this), msg.sender, tokens);
        if (quoteAmount != 0) _payQuote(msg.sender, quoteAmount);
        // Token-local actions and authenticated custody protect these interactions; events carry the frozen raise nonce and token-local reward nonce (PS §5).
        // forge-lint: disable-start(reentrancy-events)
        emit RewardsClaimed(
            raise, V.Phase.Stage3, IRaiseV31(raise).stateNonce(), rewardNonce, msg.sender, tokens, quoteAmount
        );
        // forge-lint: disable-end(reentrancy-events)
    }

    /// @notice Permissionless pull pays only the pinned treasury; failed payments preserve the bucket (P §12.2).
    function claimDisposed() external tokenAction rewardAction returns (uint256 amount) {
        amount = disposedQuote;
        if (amount == 0) revert V.InvalidAmount();
        disposedQuote = 0;
        _payQuote(treasury, amount);
        // The token-local guard covers payment and the event; the raise nonce is only observed.
        // forge-lint: disable-next-line(reentrancy-events)
        emit DisposedClaimed(raise, V.Phase.Stage3, IRaiseV31(raise).stateNonce(), rewardNonce, treasury, amount);
    }

    /// @notice Open a new balance snapshot for a Stage 3 treasury vote (governor only, after listing). It measures
    /// balances at the END of the opening block: changes inside that block are not recorded, and the first change
    /// in any later block records the balance just before it. A flash loan is repaid inside its own transaction,
    /// so borrowed tokens can never be part of the snapshot.
    function snapshot() external returns (uint256 id) {
        if (msg.sender != governor || listedAt == 0) revert V.Unauthorized();
        id = ++snapshotId;
        snapshotBlock = block.number;
    }

    /// @notice Effective balance (materialized plus undelivered listing credit) at the current snapshot; zero while
    /// the opening block is still in progress.
    function balanceAtSnapshot(address owner, uint256 id) external view returns (uint256) {
        if (id == 0 || id != snapshotId) revert V.InvalidAmount();
        if (block.number <= snapshotBlock) return 0;
        return snapshotted[owner] == id ? snapshotBalance[owner] : balanceOf(owner);
    }

    /// @notice Whether the owner's frozen delivery has been moved into ERC-20 storage (P §12.1).
    function materialized(address owner) external view returns (bool) {
        return accounts[owner].delivered;
    }

    /// @notice Original surviving quota, independent of materialization and fungible receipts (P §12.2).
    function quotaOf(address owner) public view returns (uint256) {
        if (listedAt == 0) return 0;
        if (accounts[owner].initialized) return accounts[owner].quota;
        // Only the named amount/quota is needed here; ownership and class are checked by the corresponding action.
        // forge-lint: disable-next-line(unused-return)
        (, uint256 quota) = IRaiseV31(raise).deliveryOf(owner);
        return quota;
    }

    /// @notice Projected credits including daily release, stream carry and holder fraction (P §12.2).
    function pendingRewards(address owner) external view returns (uint256 tokens, uint256 quoteAmount) {
        if (listedAt == 0) return (0, 0);
        Account memory a = accounts[owner];
        uint256 w = quotaOf(owner);
        Stream memory ts = _advance(tokenStream, totalQuota);
        Stream memory qs = _advance(quoteStream, totalQuota);
        (uint256 t,) = _earned(w, ts.accumulator - a.paidToken, a.fractionToken);
        (uint256 q,) = _earned(w, qs.accumulator - a.paidQuote, a.fractionQuote);
        return (a.creditToken + t, a.creditQuote + q);
    }

    /// @notice Accounted remaining rewards and unclaimed credits, per asset (P §§1,12.2).
    function rewardState() external view returns (Stream memory tokens, Stream memory quoteRewards) {
        return (tokenStream, quoteStream);
    }

    /// @notice Unsolicited assets are excluded from both reward streams and remain locked (PS §8; implementation default).
    function rewardSurplus() external view returns (uint256 tokens, uint256 quoteAmount) {
        return (
            super.balanceOf(address(this)) - tokenStream.remaining,
            IERC20(quote).balanceOf(address(this)) - quoteStream.remaining - disposedQuote
        );
    }

    /// @dev While a snapshot is current, the first change to an account records its balance just before it.
    function _update(address from, address to, uint256 value) internal override {
        uint256 id = snapshotId;
        if (id != 0) {
            _snapshot(from, id);
            _snapshot(to, id);
        }
        super._update(from, to, value);
    }

    function _snapshot(address account, uint256 id) internal {
        // Changes inside the opening block belong to that block; only later changes preserve its end state.
        if (account == address(0) || snapshotted[account] == id || block.number <= snapshotBlock) return;
        snapshotBalance[account] = balanceOf(account);
        snapshotted[account] = id;
    }

    function _materialize(address owner) internal {
        Account storage a = accounts[owner];
        if (a.delivered || owner == raise) return;
        // Record the effective balance (credit included) before the delivered flag hides the credit.
        uint256 id = snapshotId;
        if (id != 0) _snapshot(owner, id);
        (uint256 credit, uint256 quota) = IRaiseV31(raise).deliveryOf(owner);
        a.delivered = true;
        if (!a.initialized) {
            a.quota = SafeCast.toUint128(quota);
            a.initialized = true;
        }
        if (credit == 0) return;
        pendingDelivery -= credit;
        _update(raise, owner, credit);
    }

    function _beforePublicTransfer(address owner, uint256 amount) internal {
        if (listedAt == 0) revert V.InvalidPhase();
        _materialize(owner);
        Account storage a = accounts[owner];
        // A zero-quota sender has no changing reward entitlement and cannot trigger disposal.
        if (a.quota == 0) return;
        uint256 day = (block.timestamp - listedAt) / 1 days;
        // Nothing to accrue and no quota to destroy: reward state is unchanged, so the nonce is too (C-L2).
        if (day == 0 && amount == 0) return;
        ++rewardNonce;
        // Daily release and final disposal follow the pinned block-time schedule (P §12.2).
        // forge-lint: disable-next-line(block-timestamp)
        if (day != 0) {
            _accrue();
            _checkpoint(owner);
        }
        uint256 destroy = Math.min(a.quota, amount);
        if (destroy != 0) {
            a.quota -= SafeCast.toUint128(destroy);
            totalQuota -= destroy;
            if (a.quota == 0) {
                --activeQuotaHolders;
                if (a.finalEpoch == finalEpoch) --finalAccountedHolders;
            }
            // Token-local actions and authenticated custody protect these interactions; events carry the frozen raise nonce and token-local reward nonce (PS §5).
            // forge-lint: disable-start(reentrancy-events)
            emit QuotaDestroyed(
                raise, V.Phase.Stage3, IRaiseV31(raise).stateNonce(), rewardNonce, owner, destroy, a.quota
            );
            // forge-lint: disable-end(reentrancy-events)
        }
        // Rebase carry to the reduced denominator, even without a new daily release.
        // Daily release and final disposal follow the pinned block-time schedule (P §12.2).
        // forge-lint: disable-next-line(block-timestamp)
        if (destroy != 0 && day != 0) _accrue();
        // Daily release and final disposal follow the pinned block-time schedule (P §12.2).
        // forge-lint: disable-next-line(block-timestamp)
        if (totalQuota == 0 || day >= 1095) _disposeIfComplete();
    }

    function _accrue() internal {
        uint256 weight = totalQuota;
        if (disposed || weight == 0) return;
        uint256 day = Math.min((block.timestamp - listedAt) / 1 days, 1095);
        // No daily release or carry exists on listing day.
        if (day == 0) return;
        bool tokenChanged = _accrueStream(tokenStream, day, weight);
        bool quoteChanged = _accrueStream(quoteStream, day, weight);
        if (day == 1095 && (tokenChanged || quoteChanged)) {
            ++finalEpoch;
            finalAccountedHolders = 0;
        }
    }

    function _accrueStream(Stream storage stream, uint256 day, uint256 weight) internal returns (bool changed) {
        uint256 released = Math.mulDiv(stream.allocation, day, 1095);
        uint256 delta = released - stream.released;
        uint256 carry = stream.carry;
        if (delta == 0 && carry < weight) return false;
        uint256 remainder = mulmod(delta, V.SCALE, weight) + carry;
        uint256 increment = Math.mulDiv(delta, V.SCALE, weight) + remainder / weight;
        if (increment != 0) {
            stream.accumulator += increment;
            changed = true;
        }
        uint256 nextCarry = remainder % weight;
        if (nextCarry != carry) stream.carry = nextCarry;
        if (delta != 0) stream.released = released;
    }

    function _advance(Stream memory stream, uint256 weight) internal view returns (Stream memory) {
        if (weight == 0 || disposed) return stream;
        uint256 day = Math.min((block.timestamp - listedAt) / 1 days, 1095);
        uint256 released = Math.mulDiv(stream.allocation, day, 1095);
        uint256 delta = released - stream.released;
        uint256 remainder = mulmod(delta, V.SCALE, weight) + stream.carry;
        stream.accumulator += Math.mulDiv(delta, V.SCALE, weight) + remainder / weight;
        stream.carry = remainder % weight;
        stream.released = released;
        return stream;
    }

    function _checkpoint(address owner) internal {
        Account storage a = accounts[owner];
        if (!a.initialized) {
            a.quota = SafeCast.toUint128(quotaOf(owner));
            a.initialized = true;
        }
        // Zero-quota accounts never gain entitlement; skip irrelevant stream and account writes.
        if (a.quota == 0) return;
        uint256 tokenAcc = tokenStream.accumulator;
        uint256 quoteAcc = quoteStream.accumulator;
        if (a.paidToken != tokenAcc || a.paidQuote != quoteAcc) {
            (uint256 t, uint256 tf) = _earned(a.quota, tokenAcc - a.paidToken, a.fractionToken);
            (uint256 q, uint256 qf) = _earned(a.quota, quoteAcc - a.paidQuote, a.fractionQuote);
            a.creditToken += SafeCast.toUint128(t);
            a.creditQuote += q;
            tokenStream.credited += t;
            quoteStream.credited += q;
            a.fractionToken = SafeCast.toUint64(tf);
            a.fractionQuote = SafeCast.toUint64(qf);
            a.paidToken = tokenAcc;
            a.paidQuote = quoteAcc;
        }
        // Protocol deadlines and daily release explicitly use block time (P §§2.4,12.2).
        // forge-lint: disable-next-line(block-timestamp)
        if (a.quota != 0 && a.finalEpoch != finalEpoch && block.timestamp >= uint256(listedAt) + 1095 days) {
            a.finalEpoch = finalEpoch;
            ++finalAccountedHolders;
        }
    }

    function _earned(uint256 quota, uint256 delta, uint256 fraction)
        internal
        pure
        returns (uint256 whole, uint256 remainder)
    {
        uint256 sum = mulmod(quota, delta, V.SCALE) + fraction;
        return (Math.mulDiv(quota, delta, V.SCALE) + sum / V.SCALE, sum % V.SCALE);
    }

    function _disposeIfComplete() internal {
        if (disposed) return;
        // Protocol deadlines and daily release explicitly use block time (P §§2.4,12.2).
        // forge-lint: disable-next-line(block-timestamp)
        bool ended = block.timestamp >= uint256(listedAt) + 1095 days;
        if (totalQuota != 0 && !(ended && finalAccountedHolders == activeQuotaHolders)) return;
        disposed = true;
        uint256 tokens = tokenStream.remaining - tokenStream.credited;
        uint256 quoteAmount = quoteStream.remaining - quoteStream.credited;
        tokenStream.remaining -= tokens;
        quoteStream.remaining -= quoteAmount;
        tokenStream.carry = 0;
        quoteStream.carry = 0;
        if (tokens != 0) _burnCustody(address(this), tokens, "RewardsVault");
        disposedQuote += quoteAmount;
        // Only token-local burns and read-only raise calls precede this event under the custody/token guard.
        // forge-lint: disable-next-line(reentrancy-events)
        emit RewardsDisposed(raise, V.Phase.Stage3, IRaiseV31(raise).stateNonce(), rewardNonce, quoteAmount, tokens);
    }

    function _burnCustody(address from, uint256 amount, bytes32 bucket) internal {
        if (amount == 0) return;
        burned += amount;
        _burn(from, amount);
        // Token-local actions and authenticated custody protect these interactions; events carry the frozen raise nonce and token-local reward nonce (PS §5).
        // forge-lint: disable-next-line(reentrancy-events)
        emit TokensBurned(raise, IRaiseV31(raise).phase(), IRaiseV31(raise).stateNonce(), rewardNonce, bucket, amount);
    }

    function _payQuote(address to, uint256 amount) internal {
        uint256 beforeBalance = IERC20(quote).balanceOf(to);
        uint256 ownBefore = IERC20(quote).balanceOf(address(this));
        IERC20(quote).safeTransfer(to, amount);
        if (
            // Exact per-call asset deltas are mandatory; unsolicited preexisting balances cancel out (PS §3).
            // forge-lint: disable-next-line(incorrect-strict-equality)
            IERC20(quote).balanceOf(to) - beforeBalance != amount
                // Exact per-call asset deltas are mandatory; unsolicited preexisting balances cancel out (PS §3).
                // forge-lint: disable-next-line(incorrect-strict-equality)
                || ownBefore - IERC20(quote).balanceOf(address(this)) != amount
        ) {
            revert V.WrongAssetDelta();
        }
    }
}
