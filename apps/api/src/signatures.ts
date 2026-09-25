import { verifyMessage, getAddress, type Address } from 'viem';

/**
 * EIP-191 personal_sign message formats (binding for the frontend):
 *
 *   feedback: "Portex feedback\nraise: <address lowercase>\nrating: <n>\ntext: <text>"
 *   metadata: "Portex metadata\nraise: <address lowercase>\ndescription: <description>\nwebsite: <website>"
 *             (website line always present; empty string when omitted)
 */
export function feedbackMessage(raise: string, rating: number, text: string): string {
  return `Portex feedback\nraise: ${raise.toLowerCase()}\nrating: ${rating}\ntext: ${text}`;
}

export function metadataMessage(raise: string, description: string, website: string): string {
  return `Portex metadata\nraise: ${raise.toLowerCase()}\ndescription: ${description}\nwebsite: ${website}`;
}

export async function verifySignature(
  author: string, message: string, signature: string,
): Promise<boolean> {
  try {
    return await verifyMessage({
      address: getAddress(author) as Address,
      message,
      signature: signature as `0x${string}`,
    });
  } catch {
    return false;
  }
}
