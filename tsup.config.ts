import { defineConfig, type Options } from "tsup";

const shared: Options = {
  format: ["esm"],
  target: "node22",
  platform: "node",
  splitting: false,
  sourcemap: true,
  dts: false,
  minify: false,
  shims: false,
};

export default defineConfig([
  // npm package: dependencies stay external and are installed by the package manager.
  { ...shared, entry: { index: "src/index.ts" }, outDir: "dist", clean: true },
  // Self-contained bundle for the Claude Desktop extension (.mcpb): no node_modules needed.
  {
    ...shared,
    entry: { index: "src/index.ts" },
    outDir: "dist/bundle",
    clean: false,
    sourcemap: false,
    noExternal: [/.*/],
    esbuildOptions(options) {
      options.mainFields = ["module", "main"];
      options.conditions = ["node", "import", "default"];
    },
  },
]);
