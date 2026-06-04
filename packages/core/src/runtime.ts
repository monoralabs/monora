import { randomUUID } from "node:crypto";
import type { Clock, IdGenerator } from "./shared/ports";

/**
 * The production adapters for the ambient ports. Kept out of `domain/` so the
 * domain stays pure; composition roots import these. Tests pass fakes instead.
 */
export const systemClock: Clock = {
  now: () => new Date(),
};

export const uuidIdGenerator: IdGenerator = {
  next: () => randomUUID(),
};
