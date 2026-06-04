import { DomainError } from "../../shared/errors";

/** read < write < admin: a higher grant satisfies a lower requirement. */
export const PERMISSIONS = ["read", "write", "admin"] as const;
export type Permission = (typeof PERMISSIONS)[number];

const RANK: Record<Permission, number> = { read: 0, write: 1, admin: 2 };

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

export function makePermission(value: string): Permission {
  if (!isPermission(value)) {
    throw DomainError.validation(`Invalid permission: ${JSON.stringify(value)}`);
  }
  return value;
}

/** Does holding `held` satisfy a requirement for `required`? */
export function permissionSatisfies(
  held: Permission,
  required: Permission,
): boolean {
  return RANK[held] >= RANK[required];
}
