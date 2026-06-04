import { DomainError } from "../../shared/errors";
import type { Slug } from "./slug";

/** A Brain = a workspace / shared drive inside an org. Groups folders. An org
 *  can hold several; the MVP creates one ("Acme"). */
export interface Brain {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly slug: Slug;
  readonly createdAt: Date;
}

export function createBrain(input: {
  id: string;
  orgId: string;
  name: string;
  slug: Slug;
  createdAt: Date;
}): Brain {
  const name = input.name.trim();
  if (name === "") {
    throw DomainError.validation("Brain name cannot be empty");
  }
  return {
    id: input.id,
    orgId: input.orgId,
    name,
    slug: input.slug,
    createdAt: input.createdAt,
  };
}
