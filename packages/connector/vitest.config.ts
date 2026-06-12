import { defineConfig } from "vitest/config";

// The suite exercises raw-git failure paths on purpose; none of that may ever
// reach real telemetry. Tests that DO cover telemetry inject env + fetch
// explicitly (telemetry.test.ts), so this blanket off-switch is safe.
export default defineConfig({
  test: {
    env: { MONORA_TELEMETRY: "0" },
  },
});
