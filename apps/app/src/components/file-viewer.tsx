"use client";

import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { Lock, FileQuestion, ImageOff } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { resolveFileType, viewerModeFor } from "@/components/file-types";

export type OpenFile = { name: string; path: string };

/**
 * The full-file view: an in-page panel (Drive/GitHub-style, not a modal) that
 * fetches a file's content via `brain.readFile` (server-side `can(read)`-gated)
 * and renders it - markdown formatted, text/code as monospace, binary as a
 * graceful fallback. The file lives at its own URL, so it's deep-linkable and
 * the browser back button returns to the folder.
 */
export function FileView({
  folderId,
  file,
}: {
  folderId: string;
  file: OpenFile;
}) {
  const type = resolveFileType(file.name);
  const Icon = type.Icon;

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-card">
      <header className="flex items-center gap-3 border-b border-border px-5 py-3">
        <Icon className={`size-4 shrink-0 ${type.accentClass}`} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{file.name}</div>
          <div className="truncate font-mono text-xs text-faint">
            {file.path}
          </div>
        </div>
      </header>

      <FileBody folderId={folderId} file={file} />
    </div>
  );
}

/** URL of the raw-bytes endpoint for a file (images, etc.). Access is enforced
 *  there server-side, so this is safe to drop straight into an <img src>. */
function rawUrl(folderId: string, path: string): string {
  const qs = new URLSearchParams({ folderId, path });
  return `/api/brains/raw?${qs.toString()}`;
}

function FileBody({ folderId, file }: { folderId: string; file: OpenFile }) {
  const mode = viewerModeFor(file.name);
  const query = trpc.brain.readFile.useQuery(
    { folderId, path: file.path },
    { retry: false, enabled: mode === "markdown" || mode === "text" },
  );

  if (mode === "image") {
    return <ImageBody src={rawUrl(folderId, file.path)} name={file.name} />;
  }

  if (mode === "binary") {
    return (
      <Fallback
        icon={<FileQuestion className="size-6 text-faint" />}
        title="No inline preview for this file type yet"
        body="It opens in the connector workspace. In-app preview for binaries (images, PDFs, video) comes with a file-serving endpoint."
      />
    );
  }

  if (query.isLoading) {
    return <p className="px-6 py-10 text-sm text-muted-foreground">Loading…</p>;
  }

  if (query.error) {
    const forbidden = query.error.data?.code === "FORBIDDEN";
    return (
      <Fallback
        icon={<Lock className="size-6 text-faint" />}
        title={forbidden ? "No read access to this file" : "Could not open file"}
        body={
          forbidden
            ? "Access is enforced server-side. Grant yourself read in Manage access."
            : query.error.message
        }
      />
    );
  }

  const data = query.data!;

  return (
    <div className="px-6 py-5">
      {data.truncated && (
        <p className="mb-3 rounded-md border border-border bg-surface-soft px-3 py-2 text-xs text-muted-foreground">
          Large file - showing the first 1 MB.
        </p>
      )}
      {mode === "markdown" ? (
        <MarkdownView content={data.content} />
      ) : (
        <pre className="overflow-x-auto whitespace-pre rounded-lg border border-border bg-surface-soft p-4 font-mono text-xs leading-relaxed">
          {data.content}
        </pre>
      )}
    </div>
  );
}

function ImageBody({ src, name }: { src: string; name: string }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <Fallback
        icon={<ImageOff className="size-6 text-faint" />}
        title="Could not load image"
        body="It may be too large to preview, or you may not have access."
      />
    );
  }

  return (
    <div className="grid place-items-center bg-surface-soft p-6">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={name}
        onError={() => setFailed(true)}
        className="max-h-[70vh] max-w-full rounded-lg object-contain shadow-card"
      />
    </div>
  );
}

function Fallback({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="px-6 py-12 text-center">
      <div className="mx-auto grid size-12 place-items-center rounded-full bg-surface-soft">
        {icon}
      </div>
      <p className="mt-3 text-sm font-medium">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

/* ------------------------------- markdown -------------------------------- */

const MD_COMPONENTS: Components = {
  h1: (props) => <h1 className="mt-6 mb-3 font-display text-2xl first:mt-0" {...props} />,
  h2: (props) => <h2 className="mt-6 mb-2 font-display text-xl" {...props} />,
  h3: (props) => <h3 className="mt-4 mb-2 text-lg font-medium" {...props} />,
  h4: (props) => <h4 className="mt-4 mb-1 font-medium" {...props} />,
  p: (props) => <p className="my-3 leading-relaxed" {...props} />,
  a: (props) => (
    <a
      className="text-accent underline underline-offset-2"
      target="_blank"
      rel="noreferrer"
      {...props}
    />
  ),
  ul: (props) => <ul className="my-3 list-disc space-y-1 pl-6" {...props} />,
  ol: (props) => <ol className="my-3 list-decimal space-y-1 pl-6" {...props} />,
  blockquote: (props) => (
    <blockquote
      className="my-3 border-l-2 border-border pl-4 italic text-muted-foreground"
      {...props}
    />
  ),
  hr: () => <hr className="my-6 border-border" />,
  table: (props) => (
    <div className="my-4 overflow-x-auto">
      <table className="w-full border-collapse text-sm" {...props} />
    </div>
  ),
  th: (props) => (
    <th className="border border-border bg-surface-soft px-3 py-1.5 text-left font-medium" {...props} />
  ),
  td: (props) => <td className="border border-border px-3 py-1.5" {...props} />,
  pre: (props) => (
    <pre
      className="my-4 overflow-x-auto rounded-lg border border-border bg-surface-soft p-4 font-mono text-xs leading-relaxed"
      {...props}
    />
  ),
  code: ({ className, children, ...props }) => {
    const isBlock = /language-/.test(className ?? "");
    if (isBlock) {
      return (
        <code className={`font-mono ${className ?? ""}`} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code
        className="rounded bg-secondary px-1 py-0.5 font-mono text-[0.85em]"
        {...props}
      >
        {children}
      </code>
    );
  },
  img: (props) => (
    // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
    <img className="my-4 max-w-full rounded-lg" {...props} />
  ),
};

export function MarkdownView({ content }: { content: string }) {
  return (
    <div className="text-sm text-foreground">
      <Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
        {content}
      </Markdown>
    </div>
  );
}
