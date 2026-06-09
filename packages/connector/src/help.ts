/**
 * Help handling, kept in its own module so it carries NO side effects: `cli.ts`
 * runs `main()` on import, so the tests (and any other importer) read these
 * pure helpers without launching the CLI.
 */

const COMMAND_HELP: Record<string, string> = {
  login: "monora login --url <proxyUrl>\n  Connect this machine to your Monora server (opens a browser).",
  sync: "monora sync [--workspace <dir>] [--no-mcp]\n  Bring your authorized folders onto this computer (clone new, fast-forward the rest).",
  save: 'monora save -m "<message>" [--dry-run] [--force]\n  Commit and push EVERY changed folder in the workspace (use --dry-run to preview first).',
  status: "monora status\n  Show which folders have local changes (M / A / D).",
  doctor: "monora doctor\n  Diagnose why a folder is missing, divergent, or blocked.",
  add: "monora add <dir> [--name <display name>]\n  Promote a subdirectory into its own folder (staged; created on the next save).",
  collapse: "monora collapse <folder> [--dry-run]\n  Fold a folder's flat child folders back into it and archive the redundant child repos (recoverable).",
  restore: "monora restore [<name>]\n  List the trash, or restore an archived folder by name.",
  "new-brain": 'monora new-brain "<Name>" --from <dir> [--include-root <slug>]\n  Create a brain from a local directory and push its content.',
};

/**
 * Should this invocation show help instead of running a command? True for an
 * explicit `--help`/`-h` (anywhere in the raw args, so `-m --help` and
 * `-- --help` are caught, not just the parsed flag), the `help` subcommand, and
 * a bare `monora`. A help token quoted inside a value is a single argv entry, so
 * it does not match - `monora save -m "fix --help"` still saves.
 */
export function isHelpInvocation(
  rawArgs: string[],
  cmd: string | undefined,
  helpFlag: boolean | undefined,
): boolean {
  return (
    Boolean(helpFlag) ||
    rawArgs.some((a) => a === "-h" || a === "--help") ||
    cmd === "help" ||
    !cmd
  );
}

/** True when a commit message is really a help token fumbled into `-m`. */
export function isHelpToken(message: string | undefined): boolean {
  return /^(-h|--help|help)$/i.test((message ?? "").trim());
}

/** Render help text. NEVER runs a command. */
export function helpText(command?: string): string {
  if (command && COMMAND_HELP[command]) return COMMAND_HELP[command]!;
  const lines = ["usage: monora <command> [options]", "", "Commands:"];
  for (const line of Object.values(COMMAND_HELP)) {
    const [usage, desc] = line.split("\n");
    lines.push(`  ${usage!.replace(/^monora /, "").padEnd(34)} ${(desc ?? "").trim()}`);
  }
  lines.push("", "Run `monora <command> --help` for details on one command.");
  return lines.join("\n");
}
