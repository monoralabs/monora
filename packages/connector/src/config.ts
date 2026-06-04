import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export interface Credentials {
  baseUrl: string;
  token: string;
}

export function defaultConfigPath(): string {
  return (
    process.env.MONORA_CONFIG ??
    path.join(homedir(), ".monora", "credentials.json")
  );
}

export async function writeCredentials(
  creds: Credentials,
  configPath: string = defaultConfigPath(),
): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(creds, null, 2) + "\n", {
    mode: 0o600,
  });
}

export async function readCredentials(
  configPath: string = defaultConfigPath(),
): Promise<Credentials> {
  return JSON.parse(await readFile(configPath, "utf8")) as Credentials;
}
