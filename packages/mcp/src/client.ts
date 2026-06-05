export interface MonoraMcpClientOptions {
  urlBase: string;
  token: string;
  fetchImpl?: typeof fetch;
}

interface MountEntry {
  repoName: string;
  mountPath: string;
  permission: string;
}

export type TextToolResult = {
  content: { type: "text"; text: string }[];
};

const text = (value: string): TextToolResult => ({
  content: [{ type: "text", text: value }],
});

async function api(
  opts: MonoraMcpClientOptions,
  path: string,
): Promise<Response> {
  const fetcher = opts.fetchImpl ?? fetch;
  return fetcher(`${opts.urlBase.replace(/\/+$/, "")}${path}`, {
    headers: { authorization: `Bearer ${opts.token}` },
  });
}

async function manifest(opts: MonoraMcpClientOptions): Promise<MountEntry[]> {
  const res = await api(opts, "/manifest");
  if (!res.ok) throw new Error(`manifest: HTTP ${res.status}`);
  const data = (await res.json()) as { entries: MountEntry[] };
  return data.entries;
}

function resolvePath(
  entries: MountEntry[],
  rawPath: string,
): { repo: string; rel: string } | null {
  const clean = rawPath.replace(/^\/+/, "");
  const ordered = [...entries].sort(
    (a, b) => b.mountPath.length - a.mountPath.length,
  );
  for (const e of ordered) {
    if (clean === e.mountPath || clean.startsWith(e.mountPath + "/")) {
      return { repo: e.repoName, rel: clean.slice(e.mountPath.length + 1) };
    }
  }
  return null;
}

export function createMonoraMcpClient(opts: MonoraMcpClientOptions) {
  return {
    async listFolders(): Promise<TextToolResult> {
      const entries = await manifest(opts);
      if (!entries.length) return text("No folders authorized for this token.");
      return text(
        entries
          .map((e) => `- ${e.mountPath}/  (${e.permission})  [${e.repoName}]`)
          .join("\n"),
      );
    },

    async readFile(path: string): Promise<TextToolResult> {
      const r = await resolvePath(await manifest(opts), path);
      if (!r) return text(`No authorized folder for path: ${path}`);
      const res = await api(
        opts,
        `/read?repo=${encodeURIComponent(r.repo)}&path=${encodeURIComponent(r.rel)}`,
      );
      if (res.status === 401) return text("Access denied.");
      if (!res.ok) return text(`Not found: ${path}`);
      const data = (await res.json()) as { content: string };
      return text(data.content);
    },

    async listFiles(folder: string): Promise<TextToolResult> {
      const entry = (await manifest(opts)).find((e) => e.mountPath === folder);
      if (!entry) return text(`No authorized folder: ${folder}`);
      const res = await api(
        opts,
        `/tree?repo=${encodeURIComponent(entry.repoName)}`,
      );
      if (!res.ok) return text("Access denied.");
      const data = (await res.json()) as { files: string[] };
      return text(data.files.map((f) => `${folder}/${f}`).join("\n"));
    },

    async search(query: string): Promise<TextToolResult> {
      const res = await api(opts, `/search?q=${encodeURIComponent(query)}`);
      if (!res.ok) return text("Search failed.");
      const data = (await res.json()) as {
        results: { mountPath: string; matches: string[] }[];
      };
      if (!data.results.length) return text(`No matches for "${query}".`);
      return text(
        data.results
          .map(
            (r) =>
              `## ${r.mountPath}\n` +
              r.matches.map((m) => m.replace(/^HEAD:/, "")).join("\n"),
          )
          .join("\n\n"),
      );
    },
  };
}
