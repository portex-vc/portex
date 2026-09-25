// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IRaiseV31} from "./IRaiseV31.sol";
import {IDexAdapterV31} from "./IDexAdapterV31.sol";
import {TypesV31 as V} from "./TypesV31.sol";

interface IGovernedRaise {
    function modules() external view returns (V.Modules memory);
    function getConfig() external view returns (V.Config memory);
    function listingRecord() external view returns (IDexAdapterV31.Receipt memory);
    function feeAccruals() external view returns (uint256 reserveRetained, uint256 rewards, uint256 treasury);
    function claimTreasuryFees() external returns (uint256);
}

interface IGovernedTreasury {
    function availableQuote() external view returns (uint256);
    function spendableTokensAt(uint256 time) external view returns (uint256);
    function spend(uint256 proposal, address to, uint256 quoteAmount, uint256 tokenAmount) external;
}

interface IVotingToken {
    function snapshot() external returns (uint256);
    function balanceAtSnapshot(address owner, uint256 id) external view returns (uint256);
}

/// @notice Base-layer governance of one launch: every draw on the raise and every treasury spend is a proposal
/// and a vote (P §§3,5.10–11,7).
/// - Stage 2 votes are weighted by contributed capital (live ledger basis), never by tokens: Budget Launch draws
///   on escrow and treasury spends of Stage 2 fee income. Quorum 40%, approval 60%, amount at most 10% of YES
///   capital. Exits cancel votes; voting never blocks an exit.
/// - Stage 3 votes are weighted by token balances at the end of the proposal's block (flash loans never count).
///   Approval 60% of votes cast and the token part at most `spendCapBps` of the YES tokens decide finalization.
///   The spend's total value, at most `spendCapBps` of the market value of the YES tokens valued at the lower of
///   the listing price and the current pool price, is checked at execution, which may be retried within its window
///   (a momentary price dip cannot defeat a proposal permanently).
///   Only the listed builder addresses are excluded from voting; tokens moved to other addresses vote like any
///   holder's (fungible tokens make identity-based exclusion best-effort).
contract GovernanceV31 is Initializable {
    enum Status {
        None,
        Active,
        Passed,
        Defeated,
        Executed,
        Cancelled,
        Expired
    }

    /// @notice Draw: Budget Launch draw on Stage 2 escrow. Spend: payment from the treasury.
    enum Kind {
        Draw,
        Spend
    }

    /// @notice Capital: Stage 2 ledger capital. Token: Stage 3 token balances.
    enum Mode {
        Capital,
        Token
    }

    struct Proposal {
        uint256 amount;
        uint256 capitalSnapshot;
        uint256 yesWeight;
        uint256 noWeight;
        uint64 votingEnds;
        uint64 disputeEnds;
        uint64 executeEnds;
        Status status;
        string uri;
        Kind kind;
        Mode mode;
        address recipient;
        uint256 tokenAmount;
        uint64 snapshotId;
    }

    struct Vote {
        uint256 weight;
        bool support;
        bool cast;
        bool cancelled;
    }

    struct Draft {
        Kind kind;
        Mode mode;
        address recipient;
        uint256 amount;
        uint256 tokenAmount;
        uint64 end;
    }

    uint256 internal constant Q96 = 2 ** 96;
    /// @notice Stage 3 cap: a spend's value is at most this share (basis points) of the YES tokens' market value.
    uint16 public immutable spendCapBps;
    IRaiseV31 public raise;
    uint256 public proposalsCount;
    uint256 public activeProposalId;
    uint64 public lastProposalAt;
    address public treasury;
    mapping(uint256 => Proposal) private proposals;
    mapping(uint256 => mapping(uint256 => Vote)) private votes;
    mapping(uint256 => mapping(address => Vote)) private tokenVotes;

    event Proposed(
        address indexed raise,
        V.Phase phase,
        uint256 stateNonce,
        uint256 indexed proposal,
        uint256 amount,
        uint256 capitalSnapshot,
        uint64 votingEnds,
        uint64 disputeEnds,
        uint64 executeEnds,
        string uri
    );
    event SpendProposed(
        address indexed raise,
        uint256 indexed proposal,
        Kind kind,
        Mode mode,
        address indexed recipient,
        uint256 quoteAmount,
        uint256 tokenAmount,
        uint64 snapshotId
    );
    event VoteChanged(
        address indexed raise,
        V.Phase phase,
        uint256 stateNonce,
        uint256 indexed proposal,
        uint256 indexed position,
        bool support,
        uint256 weight,
        bool cancelled
    );
    event TokenVoteCast(
        address indexed raise, uint256 indexed proposal, address indexed voter, bool support, uint256 weight
    );
    event ProposalResolved(
        address indexed raise,
        V.Phase phase,
        uint256 stateNonce,
        uint256 indexed proposal,
        Status status,
        uint256 yesWeight,
        uint256 noWeight
    );

    constructor(uint16 spendCapBps_) {
        if (spendCapBps_ == 0 || spendCapBps_ > 2000) revert V.InvalidConfig();
        spendCapBps = spendCapBps_;
        _disableInitializers();
    }

    modifier action() {
        uint256 nonce = raise.beginModuleAction();
        _;
        if (raise.stateNonce() != nonce) revert V.InvariantFailure();
        raise.endModuleAction();
    }

    /// @notice Pin one raise and its treasury at clone creation (P §1/I2).
    function initialize(address raise_, address treasury_) external initializer {
        if (raise_ == address(0) || treasury_ == address(0)) revert V.InvalidConfig();
        raise = IRaiseV31(raise_);
        treasury = treasury_;
    }

    /// @notice Budget Launch: one builder draw on Stage 2 escrow, wholly within the remaining Stage 2 window (P §§3,5.10).
    function propose(uint256 amount, string calldata uri) external action returns (uint256 id) {
        (address builder, V.Parameters memory p, bool enabled) = raise.governanceConfig();
        if (msg.sender != builder || !enabled) revert V.Unauthorized();
        if (raise.phase() != V.Phase.Stage2) revert V.InvalidPhase();
        (uint64 end, uint256 capital, uint256 remaining) = raise.governanceState();
        if (amount == 0 || amount > remaining || amount > capital) revert V.InvalidAmount();
        id = _open(Draft(Kind.Draw, Mode.Capital, builder, amount, 0, end), p, uri);
    }

    /// @notice Treasury spend: Stage 2 (USDG fee income, capital vote) or Stage 3 (USDG and unlocked tokens, token vote).
    function proposeSpend(address recipient, uint256 quoteAmount, uint256 tokenAmount, string calldata uri)
        external
        action
        returns (uint256 id)
    {
        (address builder, V.Parameters memory p,) = raise.governanceConfig();
        if (msg.sender != builder) revert V.Unauthorized();
        if (recipient == address(0) || recipient == treasury || (quoteAmount == 0 && tokenAmount == 0)) {
            revert V.InvalidAmount();
        }
        Draft memory d = Draft(Kind.Spend, Mode.Capital, recipient, quoteAmount, tokenAmount, 0);
        V.Phase phase = raise.phase();
        if (phase == V.Phase.Stage2) {
            // No project tokens reach the treasury before listing.
            if (tokenAmount != 0) revert V.InvalidAmount();
            (d.end,,) = raise.governanceState();
        } else if (phase == V.Phase.Stage3) {
            d.end = type(uint64).max;
            d.mode = Mode.Token;
        } else {
            revert V.InvalidPhase();
        }
        if (quoteAmount > IGovernedTreasury(treasury).availableQuote()) revert V.InvalidAmount();
        id = _open(d, p, uri);
        // Tokens must already be unlocked when the execution window opens.
        if (tokenAmount > IGovernedTreasury(treasury).spendableTokensAt(proposals[id].disputeEnds)) {
            revert V.InvalidAmount();
        }
    }

    /// @notice Stage 2: each position's capital is snapshotted once; builder/buyer records cannot vote (P §§3,5.11).
    function vote(uint256 proposal, uint256 positionId, bool support) external action {
        Proposal storage p = proposals[proposal];
        if (p.status != Status.Active || p.mode != Mode.Capital || raise.phase() != V.Phase.Stage2) {
            revert V.InvalidPhase();
        }
        // Protocol deadlines and daily release explicitly use block time (P §§2.4,12.2).
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= p.votingEnds) revert V.Expired();
        (address owner, uint256 weight, bool eligible) = raise.votingPosition(positionId);
        if (msg.sender != owner || !eligible || weight == 0 || votes[proposal][positionId].cast) {
            revert V.InvalidPosition();
        }
        votes[proposal][positionId] = Vote(weight, support, true, false);
        if (support) p.yesWeight += weight;
        else p.noWeight += weight;
        // The shared raise action lock covers these interactions and their resulting-nonce events (PS §§2,5).
        // forge-lint: disable-start(reentrancy-events)
        emit VoteChanged(
            address(raise), raise.phase(), raise.stateNonce(), proposal, positionId, support, weight, false
        );
        // forge-lint: disable-end(reentrancy-events)
    }

    /// @notice Stage 3: vote with the caller's token balance at the proposal's snapshot. Builders and protocol custody
    /// cannot vote; a vote is final.
    function voteWithTokens(uint256 proposal, bool support) external action {
        Proposal storage p = proposals[proposal];
        if (p.status != Status.Active || p.mode != Mode.Token) revert V.InvalidPhase();
        // Protocol deadlines and daily release explicitly use block time (P §§2.4,12.2).
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= p.votingEnds) revert V.Expired();
        if (!canVoteWithTokens(msg.sender)) revert V.Unauthorized();
        uint256 weight = votingPower(proposal, msg.sender);
        if (weight == 0 || tokenVotes[proposal][msg.sender].cast) revert V.InvalidPosition();
        tokenVotes[proposal][msg.sender] = Vote(weight, support, true, false);
        if (support) p.yesWeight += weight;
        else p.noWeight += weight;
        // The shared raise action lock covers these interactions and their resulting event.
        // forge-lint: disable-next-line(reentrancy-events)
        emit TokenVoteCast(address(raise), proposal, msg.sender, support, weight);
    }

    /// @notice Finalize after voting; thresholds depend on the proposal's voting mode (P §3).
    function finalize(uint256 id) external action {
        Proposal storage p = proposals[id];
        // Protocol deadlines and daily release explicitly use block time (P §§2.4,12.2).
        // forge-lint: disable-next-line(block-timestamp)
        if (p.status != Status.Active || block.timestamp < p.votingEnds) revert V.InvalidPhase();
        if (_expired(p)) _resolve(id, Status.Expired);
        else _resolve(id, _passes(p, false) ? Status.Passed : Status.Defeated);
    }

    /// @notice Recheck every threshold at execution (exit cancellations in Stage 2, the price in Stage 3), then
    /// draw or pay. Pending Stage 2 trading fees are swept into the treasury first.
    function execute(uint256 id) external {
        if (proposals[id].kind == Kind.Spend) {
            (,, uint256 pending) = IGovernedRaise(address(raise)).feeAccruals();
            if (pending != 0) IGovernedRaise(address(raise)).claimTreasuryFees();
        }
        _execute(id);
    }

    /// @notice Permissionless timeout cancellation releases every logical lock in O(1) (P §§1,2.4,5.10).
    function expire(uint256 id) external action {
        Proposal storage p = proposals[id];
        if ((p.status != Status.Active && p.status != Status.Passed) || !_expired(p)) revert V.InvalidPhase();
        _resolve(id, Status.Expired);
    }

    /// @notice Cost/protected exits cancel their entire Stage 2 vote before capital leaves; recasting stays forbidden (P §3).
    function cancelVote(uint256 positionId) external {
        if (msg.sender != address(raise)) revert V.Unauthorized();
        uint256 id = activeProposalId;
        if (id == 0 || proposals[id].mode != Mode.Capital) return;
        Vote storage v = votes[id][positionId];
        if (!v.cast || v.cancelled) return;
        v.cancelled = true;
        if (v.support) proposals[id].yesWeight -= v.weight;
        else proposals[id].noWeight -= v.weight;
        emit VoteChanged(address(raise), raise.phase(), raise.stateNonce(), id, positionId, v.support, v.weight, true);
    }

    /// @notice Listing or dissolution cancels in-flight Stage 2 governance without scanning voters (P §2.4).
    function cancelAll() external {
        if (msg.sender != address(raise)) revert V.Unauthorized();
        uint256 id = activeProposalId;
        if (id != 0 && proposals[id].mode == Mode.Capital) _resolve(id, Status.Cancelled);
    }

    /// @notice Deadline-aware proposal status and immutable execution schedule (P §§2.4,5.10).
    function getProposal(uint256 id) external view returns (Proposal memory p) {
        p = proposals[id];
        if ((p.status == Status.Active || p.status == Status.Passed) && _expired(proposals[id])) {
            p.status = Status.Expired;
        }
    }

    /// @notice Stage 2 fixed weight and permanent spent/cancelled marker (P §5.11).
    function voteOf(uint256 proposal, uint256 positionId) external view returns (Vote memory) {
        return votes[proposal][positionId];
    }

    /// @notice Stage 3 token vote of one address.
    function tokenVoteOf(uint256 proposal, address voter) external view returns (Vote memory) {
        return tokenVotes[proposal][voter];
    }

    /// @notice Token balance an address can vote with on a Stage 3 proposal (zero for builders and custody).
    function votingPower(uint256 proposal, address voter) public view returns (uint256) {
        Proposal storage p = proposals[proposal];
        if (p.mode != Mode.Token || p.status == Status.None || !canVoteWithTokens(voter)) return 0;
        return IVotingToken(IGovernedRaise(address(raise)).modules().token).balanceAtSnapshot(voter, p.snapshotId);
    }

    /// @notice Builders and protocol custody never vote on treasury spends.
    function canVoteWithTokens(address voter) public view returns (bool) {
        V.Modules memory m = IGovernedRaise(address(raise)).modules();
        V.Config memory c = IGovernedRaise(address(raise)).getConfig();
        (address builder,,) = raise.governanceConfig();
        if (
            voter == address(0) || voter == builder || voter == address(raise) || voter == treasury || voter == m.token
                || voter == m.vesting || voter == m.claims || voter == m.adapter
        ) return false;
        for (uint256 i; i < c.builders.length; ++i) {
            if (voter == c.builders[i]) return false;
        }
        return true;
    }

    /// @notice Stage 3 valuation price as v4 sqrtPriceX96: the lower of the listing price and the current pool
    /// price, so a pumped pool can never enlarge what YES voters may approve. Zero when no pool price exists.
    function referencePrice() public view returns (uint160 sqrtPriceX96, bool tokenFirst) {
        V.Modules memory m = IGovernedRaise(address(raise)).modules();
        IDexAdapterV31.Receipt memory r = IGovernedRaise(address(raise)).listingRecord();
        tokenFirst = m.token < IGovernedRaise(address(raise)).getConfig().quote;
        uint160 spot = IDexAdapterV31(m.adapter).spotSqrtPriceX96(r.poolId);
        if (spot == 0 || r.sqrtPriceX96 == 0) return (0, tokenFirst);
        // Token first: price rises with sqrtPrice. Quote first: price falls as sqrtPrice rises.
        sqrtPriceX96 = tokenFirst
            ? (spot < r.sqrtPriceX96 ? spot : r.sqrtPriceX96)
            : (spot > r.sqrtPriceX96 ? spot : r.sqrtPriceX96);
    }

    /// @notice USDG value of `tokens` at the reference price.
    function quoteValue(uint256 tokens) public view returns (uint256) {
        (uint160 sqrtPriceX96, bool tokenFirst) = referencePrice();
        return _quoteValue(tokens, sqrtPriceX96, tokenFirst);
    }

    /// @notice Largest Stage 3 spend value (USDG) the current YES votes allow.
    function spendCapacity(uint256 id) external view returns (uint256) {
        Proposal storage p = proposals[id];
        if (p.mode != Mode.Token) return 0;
        return Math.mulDiv(quoteValue(p.yesWeight), spendCapBps, 10_000);
    }

    /// @notice YES locks apply only while a Stage 2 execution remains possible; they never gate exits (P §3).
    function lockedWeight(uint256 positionId) external view returns (uint256) {
        uint256 id = activeProposalId;
        if (id == 0 || proposals[id].mode != Mode.Capital || _expired(proposals[id])) return 0;
        Vote memory v = votes[id][positionId];
        return v.support && !v.cancelled ? v.weight : 0;
    }

    /// @notice Legacy informational flag only; v3.1 deposits close before governance opens (F-4).
    function depositsPaused() external view returns (bool) {
        uint256 id = activeProposalId;
        if (id == 0 || proposals[id].mode != Mode.Capital) return false;
        Proposal storage p = proposals[id];
        // Protocol deadlines and daily release explicitly use block time (P §§2.4,12.2).
        // forge-lint: disable-next-line(block-timestamp)
        return !_expired(p) && block.timestamp >= p.votingEnds;
    }

    function _open(Draft memory d, V.Parameters memory p, string calldata uri) internal returns (uint256 id) {
        uint256 active = activeProposalId;
        if (active != 0) {
            if (!_expired(proposals[active])) revert V.InvalidPhase();
            _resolve(active, Status.Expired);
        }
        // Protocol deadlines and daily release explicitly use block time (P §§2.4,12.2).
        // forge-lint: disable-next-line(block-timestamp)
        if (lastProposalAt != 0 && block.timestamp < uint256(lastProposalAt) + p.proposalInterval) revert V.Expired();
        uint64 votingEnds = SafeCast.toUint64(block.timestamp + p.voting);
        uint64 disputeEnds = votingEnds + p.dispute;
        uint64 executeEnds = disputeEnds + p.execution;
        if (executeEnds > d.end) revert V.Expired();
        id = ++proposalsCount;
        activeProposalId = id;
        lastProposalAt = SafeCast.toUint64(block.timestamp);
        Proposal storage q = proposals[id];
        q.amount = d.amount;
        q.capitalSnapshot = d.mode == Mode.Capital ? raise.eligibleCapital() : 0;
        q.votingEnds = votingEnds;
        q.disputeEnds = disputeEnds;
        q.executeEnds = executeEnds;
        q.status = Status.Active;
        q.uri = uri;
        q.kind = d.kind;
        q.mode = d.mode;
        q.recipient = d.recipient;
        q.tokenAmount = d.tokenAmount;
        if (d.mode == Mode.Token) {
            q.snapshotId = SafeCast.toUint64(IVotingToken(IGovernedRaise(address(raise)).modules().token).snapshot());
        }
        _emitProposed(id);
    }

    function _execute(uint256 id) internal action {
        Proposal storage p = proposals[id];
        if (p.status != Status.Passed || (p.mode == Mode.Capital && raise.phase() != V.Phase.Stage2)) {
            revert V.InvalidPhase();
        }
        // Protocol deadlines and daily release explicitly use block time (P §§2.4,12.2).
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < p.disputeEnds || block.timestamp >= p.executeEnds) revert V.Expired();
        if (!_passes(p, true)) revert V.InvalidAmount();
        _resolve(id, Status.Executed);
        if (p.kind == Kind.Draw) raise.governorDraw(id, p.amount, p.yesWeight);
        else IGovernedTreasury(treasury).spend(id, p.recipient, p.amount, p.tokenAmount);
    }

    /// @param valued Whether to apply the price-dependent value cap (Stage 3 execution only).
    function _passes(Proposal storage p, bool valued) internal view returns (bool) {
        uint256 cast = p.yesWeight + p.noWeight;
        if (cast == 0 || p.yesWeight < Math.mulDiv(cast, 60, 100, Math.Rounding.Ceil)) return false;
        if (p.mode == Mode.Capital) {
            return cast >= Math.mulDiv(p.capitalSnapshot, 40, 100, Math.Rounding.Ceil) && p.amount <= p.yesWeight / 10;
        }
        // Token part is price-free; the total is valued at the conservative reference price at execution.
        if (p.tokenAmount * 10_000 > p.yesWeight * spendCapBps) return false;
        if (!valued) return true;
        (uint160 sqrtPriceX96, bool tokenFirst) = referencePrice();
        uint256 spendValue = p.amount + _quoteValue(p.tokenAmount, sqrtPriceX96, tokenFirst);
        return spendValue * 10_000 <= _quoteValue(p.yesWeight, sqrtPriceX96, tokenFirst) * spendCapBps;
    }

    function _quoteValue(uint256 tokens, uint160 sqrtPriceX96, bool tokenFirst) internal pure returns (uint256) {
        if (sqrtPriceX96 == 0 || tokens == 0) return 0;
        if (tokenFirst) return Math.mulDiv(Math.mulDiv(tokens, sqrtPriceX96, Q96), sqrtPriceX96, Q96);
        return Math.mulDiv(Math.mulDiv(tokens, Q96, sqrtPriceX96), Q96, sqrtPriceX96);
    }

    function _expired(Proposal storage p) internal view returns (bool) {
        // Protocol deadlines and daily release explicitly use block time (P §§2.4,12.2).
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= p.executeEnds) return true;
        return p.mode == Mode.Capital && raise.phase() != V.Phase.Stage2;
    }

    function _resolve(uint256 id, Status status) internal {
        Proposal storage p = proposals[id];
        p.status = status;
        if (status != Status.Passed && activeProposalId == id) activeProposalId = 0;
        // The shared raise action lock covers these interactions and their resulting-nonce events (PS §§2,5).
        // forge-lint: disable-next-line(reentrancy-events)
        emit ProposalResolved(address(raise), raise.phase(), raise.stateNonce(), id, status, p.yesWeight, p.noWeight);
    }

    function _emitProposed(uint256 id) internal {
        Proposal storage p = proposals[id];
        // The shared raise action lock covers these interactions and their resulting-nonce events (PS §§2,5).
        // forge-lint: disable-start(reentrancy-events)
        emit Proposed(
            address(raise),
            raise.phase(),
            raise.stateNonce(),
            id,
            p.amount,
            p.capitalSnapshot,
            p.votingEnds,
            p.disputeEnds,
            p.executeEnds,
            p.uri
        );
        emit SpendProposed(address(raise), id, p.kind, p.mode, p.recipient, p.amount, p.tokenAmount, p.snapshotId);
        // forge-lint: disable-end(reentrancy-events)
    }
}
