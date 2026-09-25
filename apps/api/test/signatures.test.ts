import { describe, test, expect } from 'bun:test';
import { privateKeyToAccount } from 'viem/accounts';
import { feedbackMessage, metadataMessage, verifySignature } from '../src/signatures.ts';
import { ANVIL_ACCOUNTS } from '../src/config.ts';

const RAISE = '0x1234567890abcdef1234567890ABCDEF12345678';
const backer = privateKeyToAccount(ANVIL_ACCOUNTS[4].privateKey as `0x${string}`);
const builder = privateKeyToAccount(ANVIL_ACCOUNTS[3].privateKey as `0x${string}`);

describe('EIP-191 feedback signatures', () => {
  test('message format matches the API contract', () => {
    expect(feedbackMessage(RAISE, 4, 'hello world')).toBe(
      `Portex feedback\nraise: ${RAISE.toLowerCase()}\nrating: 4\ntext: hello world`,
    );
  });

  test('valid signature verifies', async () => {
    const text = 'Solid product, withdrawals worked instantly.';
    const message = feedbackMessage(RAISE, 5, text);
    const signature = await backer.signMessage({ message });
    expect(await verifySignature(backer.address, message, signature)).toBe(true);
  });

  test('wrong author fails', async () => {
    const message = feedbackMessage(RAISE, 5, 'text');
    const signature = await backer.signMessage({ message });
    expect(await verifySignature(builder.address, message, signature)).toBe(false);
  });

  test('tampered text fails', async () => {
    const signature = await backer.signMessage({ message: feedbackMessage(RAISE, 5, 'original') });
    expect(await verifySignature(backer.address, feedbackMessage(RAISE, 5, 'tampered'), signature)).toBe(false);
  });

  test('tampered rating fails', async () => {
    const signature = await backer.signMessage({ message: feedbackMessage(RAISE, 1, 'text') });
    expect(await verifySignature(backer.address, feedbackMessage(RAISE, 5, 'text'), signature)).toBe(false);
  });

  test('garbage signature fails closed', async () => {
    expect(await verifySignature(backer.address, feedbackMessage(RAISE, 3, 'x'), '0xdeadbeef')).toBe(false);
  });
});

describe('EIP-191 metadata signatures', () => {
  test('builder signature verifies; empty website line is always present', async () => {
    const description = 'An AI hedge fund for memecoins.';
    const message = metadataMessage(RAISE, description, '');
    expect(message).toBe(`Portex metadata\nraise: ${RAISE.toLowerCase()}\ndescription: ${description}\nwebsite: `);
    const signature = await builder.signMessage({ message });
    expect(await verifySignature(builder.address, message, signature)).toBe(true);
    expect(await verifySignature(backer.address, message, signature)).toBe(false);
  });
});
