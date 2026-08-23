import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/tests/**/*.test.ts"],
    globals: false,
    setupFiles: ["src/tests/setup.ts"],
    // Ledger tests share a single Postgres test database via truncate-between-tests
    // (src/tests/helpers/db.ts); running files in parallel workers would race on it.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // See src/tests/stubs/server-only.ts for why this alias exists.
      "server-only": path.resolve(__dirname, "./src/tests/stubs/server-only.ts"),
    },
  },
});
