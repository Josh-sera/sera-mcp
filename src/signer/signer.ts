import { Wallet, TypedDataDomain, TypedDataField } from "ethers";
import type { SeraIntent } from "../sera/types.js";

export type SignerMode = "local" | "external" | "readonly";

export interface SignedIntent {
  intent: SeraIntent;
  signature: string;
  taker: string;
}

export interface Signer {
  mode: SignerMode;
  /** Address that will be the `taker` on Intents. May be undefined in external mode. */
  address(): Promise<string | undefined>;
  /** Sign an Intent. Throws if mode !== "local". */
  signIntent(intent: SeraIntent, domain: TypedDataDomain): Promise<SignedIntent>;
}

const INTENT_TYPES: Record<string, TypedDataField[]> = {
  Intent: [
    { name: "taker", type: "address" },
    { name: "inputToken", type: "address" },
    { name: "outputToken", type: "address" },
    { name: "maxInputAmount", type: "uint256" },
    { name: "minOutputAmount", type: "uint256" },
    { name: "recipient", type: "address" },
    { name: "initialDepositAmount", type: "uint256" },
    { name: "uuid", type: "uint256" },
    { name: "deadline", type: "uint48" },
  ],
};

class LocalSigner implements Signer {
  readonly mode: SignerMode = "local";
  private wallet: Wallet;
  constructor(privateKey: string) {
    this.wallet = new Wallet(privateKey);
  }
  async address() {
    return this.wallet.address;
  }
  async signIntent(intent: SeraIntent, domain: TypedDataDomain): Promise<SignedIntent> {
    // ethers v6 signs typed data with `signTypedData`.
    const signature = await this.wallet.signTypedData(domain, INTENT_TYPES, intent as any);
    return { intent, signature, taker: this.wallet.address };
  }
}

class ExternalSigner implements Signer {
  readonly mode: SignerMode = "external";
  async address() {
    return undefined;
  }
  async signIntent(): Promise<SignedIntent> {
    throw new Error(
      "Signer is in 'external' mode. Use sera.prepare_swap to obtain route_params + EIP-712 domain, " +
        "sign them in your wallet, and submit via sera.execute_swap.",
    );
  }
}

class ReadonlySigner implements Signer {
  readonly mode: SignerMode = "readonly";
  async address() {
    return undefined;
  }
  async signIntent(): Promise<SignedIntent> {
    throw new Error("Signer is in 'readonly' mode. Execution tools are disabled.");
  }
}

export function createSigner(mode: SignerMode, privateKey?: string): Signer {
  switch (mode) {
    case "local":
      if (!privateKey) throw new Error("SIGNER_PRIVATE_KEY required when SERA_SIGNER_MODE=local");
      return new LocalSigner(privateKey);
    case "external":
      return new ExternalSigner();
    case "readonly":
      return new ReadonlySigner();
  }
}

export { INTENT_TYPES };
