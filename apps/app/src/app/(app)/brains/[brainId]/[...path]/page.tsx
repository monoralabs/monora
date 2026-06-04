"use client";

import { useParams } from "next/navigation";
import { BrainExplorer } from "@/components/brain-explorer";

/**
 * Deep links into a brain (Drive-style):
 *   /brains/<id>/<folderSlug>          -> inside a folder (its repo root)
 *   /brains/<id>/<folderSlug>/<sub..>  -> a subpath within that folder
 * The segments after the brain id drive the explorer's location.
 */
export default function BrainPathPage() {
  const params = useParams<{ brainId: string; path: string[] }>();
  const segments = Array.isArray(params.path) ? params.path : [];
  return (
    <div className="mx-auto max-w-5xl px-8 py-8">
      <BrainExplorer brainId={params.brainId} segments={segments} />
    </div>
  );
}
