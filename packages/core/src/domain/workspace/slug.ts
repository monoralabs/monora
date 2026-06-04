import { DomainError } from "../../shared/errors";

/** Lowercase kebab-case identifier, unique within its parent scope. Branded so
 *  a raw string cannot be passed where a validated Slug is required. */
export type Slug = string & { readonly __brand: "Slug" };

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function makeSlug(input: string): Slug {
  const v = input.trim().toLowerCase();
  if (!SLUG_RE.test(v)) {
    throw DomainError.validation(
      `Invalid slug ${JSON.stringify(input)}: expected lowercase kebab-case`,
    );
  }
  return v as Slug;
}

/** Lenient: derive a valid Slug from an arbitrary display name. */
export function slugify(input: string): Slug {
  const v = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (v === "") {
    throw DomainError.validation(
      `Cannot derive a slug from ${JSON.stringify(input)}`,
    );
  }
  return v as Slug;
}
