import { describe, test, expect } from 'bun:test';
import { deriveInbox, type InboxRaiseInput } from '../src/inbox.ts';

const NOW = 10_000;
const RAISE = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
const GOV = '0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb';

function base(overrides: Partial<InboxRaiseInput> = {}): InboxRaiseInput {
  return {
    address: RAISE,
    name: 'TestRaise',
    symbol: 'TST',
    state: 'Incubation',
    governor: null,
    principal: '1000000000',
    commitmentEnd: null,
    growthStart: null,
    epochLength: 300,
    numTranches: 4,
    minGraduationLiquidity: '20000000000',
    minRealRatioBps: 5000,
    realRatioBps: null,
    poolR: null,
    tranches: [],
    proposals: [],
    ...overrides,
  };
}

describe('deriveInbox', () => {
  test('no position → no items', () => {
    expect(deriveInbox(NOW, [base({ principal: '0' })])).toEqual([]);
  });

  test('refund_available on a Failed raise, and nothing else', () => {
    const items = deriveInbox(NOW, [base({
      state: 'Failed',
      governor: GOV,
      proposals: [{ id: 1, status: 'Active', votingEndsAt: NOW + 100, disputeEndsAt: null, userVoted: false, userVotedYes: false }],
    })]);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('refund_available');
    expect(items[0].severity).toBe('action');
  });

  test('claimable tranche now vs upcoming, with times', () => {
    const items = deriveInbox(NOW, [base({
      state: 'Growth',
      growthStart: NOW - 600,
      tranches: [
        { k: 1, state: 'Committed', principal: '250000000', claimableAt: NOW - 10 },
        { k: 2, state: 'Committed', principal: '250000000', claimableAt: NOW + 290 },
        { k: 3, state: 'Claimed', principal: '250000000', claimableAt: NOW - 100 },
        { k: 4, state: 'Locked', principal: '250000000', claimableAt: 0 },
      ],
    })]);
    const claimables = items.filter((i) => i.type === 'claimable_tranche');
    expect(claimables).toHaveLength(2);
    expect(claimables.find((i) => i.data.k === 1)?.severity).toBe('action');
    expect(claimables.find((i) => i.data.k === 2)?.severity).toBe('upcoming');
    expect(claimables.find((i) => i.data.k === 2)?.dueAt).toBe(NOW + 290);
  });

  test('commitment_closing only while the window is open and tranches are locked', () => {
    const input = base({
      state: 'Commitment',
      commitmentEnd: NOW + 120,
      tranches: [
        { k: 1, state: 'Locked', principal: '250000000', claimableAt: 0 },
        { k: 2, state: 'Committed', principal: '250000000', claimableAt: 0 },
      ],
    });
    const items = deriveInbox(NOW, [input]);
    expect(items.filter((i) => i.type === 'commitment_closing')).toHaveLength(1);
    expect(items[0].data.lockedTranches).toBe(1);
    expect(items[0].dueAt).toBe(NOW + 120);
    // window already over → nothing
    expect(deriveInbox(NOW, [{ ...input, commitmentEnd: NOW - 1 }])).toEqual([]);
  });

  test('vote_open while voting is live and the user has not voted', () => {
    const props = [{ id: 1, status: 'Active' as const, votingEndsAt: NOW + 100, disputeEndsAt: NOW + 400, userVoted: false, userVotedYes: false }];
    const items = deriveInbox(NOW, [base({ governor: GOV, proposals: props })]);
    expect(items.map((i) => i.type)).toEqual(['vote_open']);
    // already voted → no nag
    expect(deriveInbox(NOW, [base({ governor: GOV, proposals: [{ ...props[0], userVoted: true }] })])).toEqual([]);
    // voting over → no nag
    expect(deriveInbox(NOW, [base({ governor: GOV, proposals: [{ ...props[0], votingEndsAt: NOW }] })])).toEqual([]);
  });

  test('dispute_exit for non-YES voters inside the dispute window only', () => {
    const p = { id: 2, status: 'Passed' as const, votingEndsAt: NOW - 100, disputeEndsAt: NOW + 200, userVoted: true, userVotedYes: false };
    const items = deriveInbox(NOW, [base({ governor: GOV, proposals: [p] })]);
    expect(items.map((i) => i.type)).toEqual(['dispute_exit']);
    expect(items[0].dueAt).toBe(NOW + 200);
    // YES voters are locked — no exit item
    expect(deriveInbox(NOW, [base({ governor: GOV, proposals: [{ ...p, userVotedYes: true }] })])).toEqual([]);
    // dispute window over → gone
    expect(deriveInbox(NOW, [base({ governor: GOV, proposals: [{ ...p, disputeEndsAt: NOW - 1 }] })])).toEqual([]);
  });

  test('graduation_ready only when every gate is met', () => {
    const input = base({
      state: 'Growth',
      growthStart: NOW - 4 * 300, // all 4 epochs elapsed exactly now
      poolR: '25000000000',       // ≥ minGraduationLiquidity
      realRatioBps: 6000,         // ≥ minRealRatioBps
    });
    const items = deriveInbox(NOW, [input]);
    expect(items.map((i) => i.type)).toEqual(['graduation_ready']);
    expect(deriveInbox(NOW - 1, [input])).toEqual([]);                       // epochs not done
    expect(deriveInbox(NOW, [{ ...input, poolR: '1' }])).toEqual([]);        // liquidity short
    expect(deriveInbox(NOW, [{ ...input, realRatioBps: 4000 }])).toEqual([]); // ratio short
  });

  test('actions sort before upcoming, by soonest deadline', () => {
    const items = deriveInbox(NOW, [base({
      state: 'Commitment',
      commitmentEnd: NOW + 50,
      governor: GOV,
      tranches: [
        { k: 1, state: 'Locked', principal: '250000000', claimableAt: 0 },
        { k: 2, state: 'Committed', principal: '250000000', claimableAt: NOW + 10 },
      ],
      proposals: [{ id: 1, status: 'Active', votingEndsAt: NOW + 30, disputeEndsAt: null, userVoted: false, userVotedYes: false }],
    })]);
    expect(items.map((i) => i.type)).toEqual(['vote_open', 'commitment_closing', 'claimable_tranche']);
    expect(items.map((i) => i.severity)).toEqual(['action', 'action', 'upcoming']);
  });
});
