const typescriptParser = require("@typescript-eslint/parser");
const { importX } = require("eslint-plugin-import-x");

module.exports = [
  { ignores: ["node_modules/**", "out/**", "dist/**", "resources/**", "docs/**", ".github/**"] },
  {
    files: ["src/**/*.{ts,tsx,js,cjs,mjs}", "scripts/**/*.{ts,js,cjs,mjs}", "eslint.config.cjs"],
    languageOptions: { parser: typescriptParser },
    plugins: { "import-x": importX },
    settings: {
      // The extension host provides this module; it is not an npm runtime dependency.
      "import-x/core-modules": ["vscode"],
      "import-x/resolver": { typescript: true },
    },
    rules: {
      "import-x/no-extraneous-dependencies": ["error", {
        devDependencies: ["src/test/**", "scripts/**", "eslint.config.cjs"],
        optionalDependencies: false,
        peerDependencies: false,
        bundledDependencies: false,
        // Type-only imports are erased and may use development dependencies.
        includeTypes: false,
      }],
      // The dependency rule skips unresolved imports; reject those as well.
      "import-x/no-unresolved": ["error", { commonjs: true }],
    },
  },
];
