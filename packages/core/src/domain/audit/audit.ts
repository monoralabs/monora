/** Append-only audit trail. Written by use-cases (not interfaces) so every
 *  surface that triggers an action gets the same record. Action names are
 *  dotted + past-ish: `brain.create`, `folder.create`, `folder.ingest`. */
export interface AuditEntry {
  orgId: string;
  actorId: string | null;
  action: string;
  target?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface AuditRepository {
  record(entry: AuditEntry): Promise<void>;
}
