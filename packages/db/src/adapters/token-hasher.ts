import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { TokenHasher, GeneratedToken } from "@monora/core";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const TOKEN_BYTES = 24;
const PREFIX_LEN = 16; // "mna_" + 12 chars of base64url
const KEY_LEN = 32;

/**
 * The default TokenHasher: random `mna_<base64url>` secret, scrypt hash stored
 * as `scrypt$<saltHex>$<keyHex>`. No native dependency. The lookup prefix is a
 * deterministic slice of the plaintext, so the proxy can index it.
 */
export class ScryptTokenHasher implements TokenHasher {
  async generate(): Promise<GeneratedToken> {
    const plaintext = `mna_${randomBytes(TOKEN_BYTES).toString("base64url")}`;
    const salt = randomBytes(16);
    const key = await scrypt(plaintext, salt, KEY_LEN);
    return {
      plaintext,
      prefix: plaintext.slice(0, PREFIX_LEN),
      hash: `scrypt$${salt.toString("hex")}$${key.toString("hex")}`,
    };
  }

  parsePrefix(plaintext: string): string {
    return plaintext.slice(0, PREFIX_LEN);
  }

  async verify(plaintext: string, hash: string): Promise<boolean> {
    const [scheme, saltHex, keyHex] = hash.split("$");
    if (scheme !== "scrypt" || !saltHex || !keyHex) return false;
    const expected = Buffer.from(keyHex, "hex");
    const actual = await scrypt(plaintext, Buffer.from(saltHex, "hex"), expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}
