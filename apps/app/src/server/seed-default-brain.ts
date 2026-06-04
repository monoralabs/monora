import "server-only";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { brains, folders } from "@monora/db";
import { useCases } from "./usecases";
import { withTenant } from "./db/tenant";
import { env } from "@/env";

/**
 * Every org gets a default **"Monora Guide"** brain holding the product guide
 * (how to use Monora, AI-brain best practices, how to share secrets). Every
 * member can read it. This seeds that brain on org creation and grants read on
 * member join.
 *
 * It lives at slug `monora-guide` (not `monora`) so the `monora` slug stays free
 * for an org's own "Monora" brain - e.g. the product knowledge base.
 *
 * The guide content ships in the image (see the Dockerfile COPY of `seed/`);
 * `DEFAULT_BRAIN_SEED_DIR` points at it (defaults to the repo path in dev).
 */
const BRAIN_NAME = "Monora Guide";
const BRAIN_SLUG = "monora-guide";
const FOLDER_SLUG = "guide";

function seedDir(): string {
  return (
    env.DEFAULT_BRAIN_SEED_DIR ??
    path.resolve(process.cwd(), "../../seed/default-brain")
  );
}

/** The guide folder's id if the brain + folder already exist in this org. */
async function findGuideFolderId(orgId: string): Promise<string | null> {
  return withTenant(orgId, async (tx) => {
    const [b] = await tx
      .select({ id: brains.id })
      .from(brains)
      .where(and(eq(brains.orgId, orgId), eq(brains.slug, BRAIN_SLUG)))
      .limit(1);
    if (!b) return null;
    const [f] = await tx
      .select({ id: folders.id })
      .from(folders)
      .where(and(eq(folders.brainId, b.id), eq(folders.slug, FOLDER_SLUG)))
      .limit(1);
    return f?.id ?? null;
  });
}

/**
 * Ensure the org has the Monora guide brain and that `userId` can read it.
 * Idempotent: the brain + guide folder are created (and the guide snapshot
 * ingested) once; later calls only add the read grant. NEVER throws into the
 * caller - a seeding failure must not block sign-up / org creation / accepting
 * an invite; it's logged and the brain can be backfilled.
 */
export async function ensureDefaultBrainAccess(
  orgId: string,
  userId: string,
): Promise<void> {
  try {
    let folderId = await findGuideFolderId(orgId);
    if (!folderId) {
      const brain = await useCases.ensureBrain({ orgId, name: BRAIN_NAME });
      if (!brain.ok) throw new Error(`ensureBrain: ${brain.error.message}`);
      const r = await useCases.importFolder({
        orgId,
        brainId: brain.value.id,
        name: "Guide",
        slug: FOLDER_SLUG,
        path: FOLDER_SLUG,
        sourceDir: seedDir(),
        excludeMedia: true,
        message: "seed Monora guide",
      });
      if (!r.ok) throw new Error(`importFolder: ${r.error.message}`);
      folderId = r.value.folder.id;
    }
    const g = await useCases.grantAccess({
      orgId,
      folderId,
      userId,
      permission: "read",
    });
    if (!g.ok) throw new Error(`grantAccess: ${g.error.message}`);
  } catch (e) {
    console.error(
      `[default-brain] seeding failed for org ${orgId}:`,
      e instanceof Error ? e.message : e,
    );
  }
}
