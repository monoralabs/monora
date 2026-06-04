"use client";

import { useParams } from "next/navigation";
import { BrainExplorer } from "@/components/brain-explorer";

/** Brain root: `/brains/<id>` (no folder selected). Deeper paths are served by
 *  the sibling `[...path]` catch-all - both feed the same explorer. */
export default function BrainPage() {
  const params = useParams<{ brainId: string }>();
  return (
    <div className="mx-auto max-w-5xl px-8 py-8">
      <BrainExplorer brainId={params.brainId} segments={[]} />
    </div>
  );
}
