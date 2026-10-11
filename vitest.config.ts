import { defineConfig } from "vitest/config";

// Tests run with the repo's profile handed to the engine, as every command does.
export default defineConfig({ test: { setupFiles: ["test/setup.ts"] } });
