/**
 * Mock personas: one HD mnemonic, generated on first run and stored (mode 0600) in
 * tools/mock/state/<chainId>/wallets.json, which is gitignored. The mnemonic is never printed.
 */
import { resolve } from 'node:path';
import { toHex, type Address, type Hex } from 'viem';
import {
  english,
  generateMnemonic,
  mnemonicToAccount,
  privateKeyToAccount,
  type PrivateKeyAccount,
} from 'viem/accounts';
import { readJson, stateDir, writeJsonAtomic } from './state';

export type PersonaKind = 'builder' | 'conservative' | 'rollover' | 'stage2' | 'stage3' | 'whale' | 'voter';

/** About forty personas; the mix drives who deposits, trades, rolls over and votes. */
export const PERSONA_MIX: [PersonaKind, number][] = [
  ['builder', 8],
  ['conservative', 10],
  ['rollover', 4],
  ['stage2', 6],
  ['stage3', 6],
  ['whale', 2],
  ['voter', 4],
];

export interface Persona {
  index: number;
  kind: PersonaKind;
  label: string;
  address: Address;
  account: PrivateKeyAccount;
}

interface WalletFile {
  version: 1;
  createdAt: string;
  note: string;
  mnemonic: string;
  personas: { index: number; kind: PersonaKind; label: string; address: Address }[];
}

function derive(mnemonic: string, index: number): PrivateKeyAccount {
  const hd = mnemonicToAccount(mnemonic, { addressIndex: index });
  return privateKeyToAccount(toHex(hd.getHdKey().privateKey!) as Hex);
}

/** Load (or create) the persona wallets for this chain. */
export function loadPersonas(chainId: number): { personas: Persona[]; created: boolean; path: string } {
  const path = resolve(stateDir(chainId), 'wallets.json');
  let file = readJson<WalletFile>(path);
  let created = false;
  if (!file) {
    const mnemonic = generateMnemonic(english);
    const personas: WalletFile['personas'] = [];
    let index = 0;
    for (const [kind, count] of PERSONA_MIX) {
      for (let n = 1; n <= count; n++, index++)
        personas.push({ index, kind, label: `${kind}-${n}`, address: derive(mnemonic, index).address });
    }
    file = {
      version: 1,
      createdAt: new Date().toISOString(),
      note: 'Portex mock personas. Secret: never commit or share this file.',
      mnemonic,
      personas,
    };
    writeJsonAtomic(path, file, 0o600);
    created = true;
  }
  const personas = file.personas.map((p) => {
    const account = derive(file!.mnemonic, p.index);
    if (account.address !== p.address) throw new Error(`wallets.json persona ${p.index} does not match its mnemonic`);
    return { ...p, account };
  });
  return { personas, created, path };
}

export const ofKind = (personas: Persona[], ...kinds: PersonaKind[]) => personas.filter((p) => kinds.includes(p.kind));
