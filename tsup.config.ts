import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false,
  minify: false,
  shims: false,
});
