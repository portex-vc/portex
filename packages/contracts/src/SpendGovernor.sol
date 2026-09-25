// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {GovernorConfig} from "./libraries/PortexTypes.sol";
import {Raise} from "./Raise.sol";

/// @notice Rule 2 milestone funding (§5.7), Incubation only in v1. Deployed as an EIP-1167 clone
///         per raise, pinned in the template bundle as `governorImpl`. The builder proposes a
///         spend; backers vote with weight = their current principal in the raise; the builder
///         address cannot vote. A proposal passes iff participation ≥ quorumBps of the principal
///         snapshot, YES ≥ approvalBps of votes cast, and amount ≤ 10% × YES principal. A pass
///         opens a dispute window in which everyone who did not vote YES can withdraw 100%;
///         YES voters are withdraw-locked from vote time until the end of the window so YES
///         weight cannot leave. execute() pays the builder through Raise.governorSpend, which
///         lowers the principal index: everyone who stayed pays pro rata, later depositors join
///         at the new index and never pay for past spends.
///
///         Weight rules (documented design choice): a vote's weight is fixed at vote time and
///         votes are never adjusted afterwards. YES capital is locked, so it cannot be moved and
///         re-voted. NO (and abstained) capital CAN be withdrawn mid-vote and re-voted from fresh
///         addresses, multiplying counted NO weight. This is accepted: multiplied NO weight can
///         only ever bias a proposal toward defeat — the safe direction in which no funds move.
///         Passing rests entirely on YES pillars (approval share, and the 10% cap on locked YES
///         capital that provably stays through the window), so gaming participation/quorum maths
///         on the NO side is a liveness grief, never a solvency risk.
contract SpendGovernor is Initializable {
    uint256 internal constant BPS = 10_000;
    /// @notice A spend may not exceed 10% of the YES principal backing it (checked at
    ///         finalization and re-checked at execution).
    uint16 public constant MAX_SPEND_OF_YES_BPS = 1000;

    enum Status {
        None,
        Active, // voting open
        Passed, // voting over, passed; dispute window running (or executable after it)
        Defeated, // voting over, failed; YES locks releasable via releaseLock
        Executed, // spend paid out
        Expired // passed but never executed within the grace period; unblocks proposals
    }

    struct Proposal {
        uint64 createdAt;
        uint64 votingEnds;
        uint64 disputeEnds; // == votingEnds + disputeWindow; fixed at creation (locks align to it)
        uint256 amount;
        string uri;
        uint256 yesPrincipal; // sum of YES weights (fixed at each vote time)
        uint256 noPrincipal; // sum of NO weights (fixed at each vote time)
        uint256 totalPrincipalSnapshot; // quorum basis, snapshotted at creation
        Status status;
    }

    struct Vote {
        uint256 weight;
        bool support;
        bool cast;
    }

    Raise public raise;
    GovernorConfig internal govCfg;

    uint256 public proposalsCount;
    uint256 public activeProposalId; // proposal currently blocking lifecycle/proposals (0 = none)
    uint64 public lastProposalAt;

    mapping(uint256 id => Proposal) internal proposals;
    mapping(uint256 id => mapping(address voter => Vote)) internal votes;

    event Proposed(
        uint256 indexed id,
        uint256 amount,
        string uri,
        uint64 votingEnds,
        uint64 disputeEnds,
        uint256 totalPrincipalSnapshot
    );
    event Voted(uint256 indexed id, address indexed voter, bool support, uint256 weight);
    event Finalized(uint256 indexed id, bool passed, uint256 yesPrincipal, uint256 noPrincipal);
    event Executed(uint256 indexed id, uint256 amount, address indexed to);
    event Expired(uint256 indexed id);
    event VoteLockReleased(uint256 indexed id, address indexed voter);

    error OnlyBuilder();
    error InvalidState();
    error ZeroAmount();
    error ZeroAddress();
    error DurationsInvalid();
    error BpsInvalid();
    error ProposalActive();
    error IntervalNotElapsed();
    error CeilingExceeded();
    error ProposalNotActive();
    error VotingEnded();
    error VotingNotEnded();
    error BuilderCannotVote();
    error AlreadyVoted();
    error ZeroWeight();
    error NotPassed();
    error ExecuteWindowClosed();
    error DisputeNotEnded();
    error CapExceeded();
    error ExpireTooEarly();
    error NotDefeated();
    error NoLockToRelease();

    constructor() {
        _disableInitializers();
    }

    /// @notice Called once by the factory, atomically with cloning.
    function initialize(address raise_, GovernorConfig calldata cfg_) external initializer {
        if (raise_ == address(0)) revert ZeroAddress();
        if (cfg_.votingPeriod == 0 || cfg_.disputeWindow == 0) revert DurationsInvalid();
        if (cfg_.quorumBps == 0 || cfg_.quorumBps > BPS) revert BpsInvalid();
        if (cfg_.approvalBps == 0 || cfg_.approvalBps > BPS) revert BpsInvalid();
        raise = Raise(payable(raise_));
        govCfg = cfg_;
    }

    /// @notice Builder proposes a spend of `amount` quote (paid from escrow at execution).
    ///         Incubation only; one proposal in flight at a time; `minProposalInterval` between
    ///         successive proposals; must fit the raise's cumulative spend ceiling.
    function propose(uint256 amount, string calldata uri) external returns (uint256 id) {
        if (msg.sender != raise.builder()) revert OnlyBuilder();
        if (raise.state() != Raise.State.Incubation) revert InvalidState();
        if (amount == 0) revert ZeroAmount();
        if (activeProposalId != 0) revert ProposalActive();
        // interval between successive proposals; the first proposal is always allowed
        if (lastProposalAt != 0 && block.timestamp < lastProposalAt + govCfg.minProposalInterval) {
            revert IntervalNotElapsed();
        }
        _checkCeiling(amount);

        id = ++proposalsCount;
        activeProposalId = id;
        lastProposalAt = uint64(block.timestamp);
        uint64 votingEnds = uint64(block.timestamp) + govCfg.votingPeriod;
        proposals[id] = Proposal({
            createdAt: uint64(block.timestamp),
            votingEnds: votingEnds,
            disputeEnds: votingEnds + govCfg.disputeWindow,
            amount: amount,
            uri: uri,
            yesPrincipal: 0,
            noPrincipal: 0,
            totalPrincipalSnapshot: raise.totalPrincipal(),
            status: Status.Active
        });
        emit Proposed(id, amount, uri, votingEnds, votingEnds + govCfg.disputeWindow, raise.totalPrincipal());
    }

    /// @notice Vote with weight = the voter's current principal in the raise, fixed at vote time.
    ///         One vote per address; the builder address cannot vote. A YES vote immediately
    ///         withdraw-locks the voter until the proposal can no longer be executed
    ///         (lockUntil = disputeEnds + disputeWindow, the expiry deadline). Locking only until
    ///         disputeEnds would let a YES voter withdraw in the gap before execute() and dodge the
    ///         spend they approved. The lock is released early once the proposal is executed,
    ///         expired or defeated (releaseLock).
    function vote(uint256 id, bool support) external {
        Proposal storage p = proposals[id];
        if (p.status != Status.Active) revert ProposalNotActive();
        if (raise.state() != Raise.State.Incubation) revert InvalidState(); // e.g. Failed via cancel
        if (block.timestamp >= p.votingEnds) revert VotingEnded();
        if (msg.sender == raise.builder()) revert BuilderCannotVote();
        if (votes[id][msg.sender].cast) revert AlreadyVoted();

        uint256 weight = raise.principalOf(msg.sender);
        if (weight == 0) revert ZeroWeight();

        votes[id][msg.sender] = Vote({weight: weight, support: support, cast: true});
        if (support) {
            p.yesPrincipal += weight;
            raise.setWithdrawLock(msg.sender, _lockUntil(p));
        } else {
            p.noPrincipal += weight;
        }
        emit Voted(id, msg.sender, support, weight);
    }

    /// @notice Close voting and compute the outcome. Passes iff participation ≥ quorumBps of the
    ///         proposal-time total principal, YES ≥ approvalBps of votes cast, and
    ///         amount ≤ 10% × YES principal. On a pass the dispute window runs until disputeEnds
    ///         (fixed at creation); on a defeat the proposal stops blocking the lifecycle and YES
    ///         locks become releasable via releaseLock. Permissionless.
    function finalize(uint256 id) external {
        Proposal storage p = proposals[id];
        if (p.status != Status.Active) revert ProposalNotActive();
        if (block.timestamp < p.votingEnds) revert VotingNotEnded();

        uint256 castVotes = p.yesPrincipal + p.noPrincipal;
        bool quorumMet = castVotes * BPS >= p.totalPrincipalSnapshot * govCfg.quorumBps;
        bool approvalMet = castVotes > 0 && p.yesPrincipal * BPS >= castVotes * govCfg.approvalBps;
        bool capMet = p.amount * BPS <= p.yesPrincipal * MAX_SPEND_OF_YES_BPS;

        if (quorumMet && approvalMet && capMet) {
            p.status = Status.Passed;
        } else {
            p.status = Status.Defeated;
            activeProposalId = 0;
        }
        emit Finalized(id, p.status == Status.Passed, p.yesPrincipal, p.noPrincipal);
    }

    /// @notice Pay out a passed proposal after the dispute window. Re-checks the 10%-of-YES cap
    ///         and the raise's cumulative ceiling, then Raise.governorSpend lowers the index so
    ///         everyone still in the raise pays pro rata. Funds only ever go to the builder.
    ///         Permissionless.
    function execute(uint256 id) external {
        Proposal storage p = proposals[id];
        if (p.status != Status.Passed) revert NotPassed();
        if (block.timestamp < p.disputeEnds) revert DisputeNotEnded();
        // YES locks lapse at the expiry deadline; a spend must never execute once they have.
        if (block.timestamp >= _lockUntil(p)) revert ExecuteWindowClosed();
        if (p.amount * BPS > p.yesPrincipal * MAX_SPEND_OF_YES_BPS) revert CapExceeded();
        _checkCeiling(p.amount);

        p.status = Status.Executed;
        activeProposalId = 0;
        address builder = raise.builder();
        raise.governorSpend(p.amount, builder);
        emit Executed(id, p.amount, builder);
    }

    /// @notice A passed proposal that was never executed within one disputeWindow of grace after
    ///         the dispute ended can be expired by anyone, unblocking new proposals and
    ///         startCommitment. No funds move. (Escape hatch for pathological stalls, e.g. exits
    ///         draining escrow below the amount so execute() can never succeed.)
    function expire(uint256 id) external {
        Proposal storage p = proposals[id];
        if (p.status != Status.Passed) revert NotPassed();
        if (block.timestamp < p.disputeEnds + govCfg.disputeWindow) revert ExpireTooEarly();
        p.status = Status.Expired;
        activeProposalId = 0;
        emit Expired(id);
    }

    /// @notice Once a proposal is resolved (defeated, executed or expired), release a YES voter's
    ///         withdraw lock early (it would lapse at the expiry deadline anyway). O(1) per voter
    ///         on purpose — finalize/execute never iterate voters. Permissionless; only clears the
    ///         lock if it is still this proposal's (a later proposal's lock has a different, later
    ///         deadline and is left untouched).
    function releaseLock(uint256 id, address voter) external {
        Proposal storage p = proposals[id];
        if (p.status != Status.Defeated && p.status != Status.Executed && p.status != Status.Expired) {
            revert NotDefeated();
        }
        Vote storage v = votes[id][voter];
        if (!v.cast || !v.support) revert NoLockToRelease();
        if (raise.withdrawLockUntil(voter) == _lockUntil(p)) {
            raise.setWithdrawLock(voter, 0);
        }
        emit VoteLockReleased(id, voter);
    }

    /// @dev YES locks cover the whole period in which execute() is possible.
    function _lockUntil(Proposal storage p) internal view returns (uint64) {
        return p.disputeEnds + govCfg.disputeWindow;
    }

    // ---------------- views ----------------

    /// @notice True while a proposal is in voting, in its dispute window, or passed and awaiting
    ///         execution. Raise.startCommitment reverts while this holds, so a vote always
    ///         resolves (and a passed spend always executes or expires) before the lifecycle
    ///         moves on.
    function proposalInFlight() external view returns (bool) {
        return activeProposalId != 0;
    }

    /// @notice True from the moment voting closes on the in-flight proposal until it is
    ///         defeated, executed or expired. Raise.deposit reverts while this holds: a depositor
    ///         who could no longer vote must never pay pro rata for that spend.
    function depositsPaused() external view returns (bool) {
        uint256 id = activeProposalId;
        if (id == 0) return false;
        return block.timestamp >= proposals[id].votingEnds;
    }

    /// @notice When YES voters' withdraw lock for proposal `id` lapses on its own.
    function lockUntil(uint256 id) external view returns (uint64) {
        return _lockUntil(proposals[id]);
    }

    function getProposal(uint256 id) external view returns (Proposal memory) {
        return proposals[id];
    }

    function voteOf(uint256 id, address voter) external view returns (Vote memory) {
        return votes[id][voter];
    }

    function getGovernorConfig() external view returns (GovernorConfig memory) {
        return govCfg;
    }

    // ---------------- internals ----------------

    /// @dev Pre-check of the raise's hard ceiling (Raise.governorSpend re-checks it authoritatively):
    ///      cumulativeSpend + amount ≤ maxCumulativeSpendBps × peakPrincipal / BPS.
    function _checkCeiling(uint256 amount) internal view {
        uint16 capBps = raise.getConfig().maxCumulativeSpendBps;
        if (raise.cumulativeSpend() + amount > (uint256(capBps) * raise.peakPrincipal()) / BPS) {
            revert CeilingExceeded();
        }
    }
}
