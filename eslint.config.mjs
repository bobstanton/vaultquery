import tsparser from "@typescript-eslint/parser";
import obsidianmd from "eslint-plugin-obsidianmd";

export default [
  {
    ignores: [
      "node_modules/**",
      "main.js",
      "**/*.js",
      "**/*.mjs",
      "**/*.d.ts",
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      "versions.json",
    ],
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: ["./tsconfig.json"],
      },
    },
    rules: {
      "obsidianmd/ui/sentence-case": "warn",
      "@typescript-eslint/no-base-to-string": "warn",
      "@typescript-eslint/no-unnecessary-type-assertion": "warn",
      "@typescript-eslint/restrict-template-expressions": "warn",
    },
  },
  {
    files: ["**/generated-help/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "obsidianmd/hardcoded-config-path": "off",
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
];
