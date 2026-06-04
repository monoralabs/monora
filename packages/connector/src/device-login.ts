import { execFile } from "node:child_process";

/**
 * Device Authorization Grant (RFC 8628) client. Gets a code from the proxy,
 * shows it to the user, opens the browser to approve, then polls until the
 * proxy hands back a freshly minted token. The token never appears on the
 * command line - this is what `login` uses instead of `--token`.
 */

interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  interval: number;
  expiresIn: number;
}

interface DeviceTokenResponse {
  status: "authorization_pending" | "complete" | "denied" | "expired";
  token?: string;
}

function trimUrl(u: string): string {
  return u.replace(/\/+$/, "");
}

/** Best-effort: open the approval URL in the default browser. Never throws. */
function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    execFile(cmd, args, () => {});
  } catch {
    // ignore - we always print the URL too
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run the full device login against `baseUrl` (the proxy). Resolves to the
 * access token once the user approves in the browser.
 */
export async function deviceLogin(
  baseUrl: string,
  log: (line: string) => void = console.log,
): Promise<string> {
  const base = trimUrl(baseUrl);

  const codeRes = await fetch(`${base}/device/code`, { method: "POST" });
  if (!codeRes.ok) {
    throw new Error(
      `could not start device login: HTTP ${codeRes.status}. Is --url correct?`,
    );
  }
  const flow = (await codeRes.json()) as DeviceCodeResponse;

  log("");
  log("To connect this machine, approve it in your browser:");
  log("");
  log(`  ${flow.verificationUri}`);
  log(`  code:  ${flow.userCode}`);
  log("");
  log("Opening your browser… (approve there, then come back here)");
  openBrowser(flow.verificationUriComplete);

  const intervalMs = Math.max(1, flow.interval) * 1000;
  const deadline = Date.now() + flow.expiresIn * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const res = await fetch(`${base}/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode: flow.deviceCode }),
    });
    if (!res.ok) {
      // Transient server error: keep polling until the deadline.
      continue;
    }
    const data = (await res.json()) as DeviceTokenResponse;
    if (data.status === "complete" && data.token) return data.token;
    if (data.status === "denied") throw new Error("login was denied.");
    if (data.status === "expired") {
      throw new Error("the code expired before it was approved. Run login again.");
    }
    // authorization_pending: loop.
  }
  throw new Error("timed out waiting for approval. Run login again.");
}
