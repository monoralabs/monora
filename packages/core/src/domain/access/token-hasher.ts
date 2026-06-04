/** Owns the access-token secret format and hashing. The adapter (scrypt, in
 *  @monora/db) is the only thing that touches crypto; the domain just declares
 *  the port so use-cases stay deterministic and testable. */
export interface GeneratedToken {
  /** The full secret, shown to the user exactly once. */
  plaintext: string;
  /** Public, indexable lookup key derived from the plaintext. */
  prefix: string;
  /** What gets stored. */
  hash: string;
}

export interface TokenHasher {
  /** Mint a fresh random token. */
  generate(): Promise<GeneratedToken>;
  /** Extract the lookup prefix from a presented raw token (deterministic). */
  parsePrefix(plaintext: string): string;
  /** Constant-time verify a presented token against a stored hash. */
  verify(plaintext: string, hash: string): Promise<boolean>;
}
