import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: [
      "**/dist",
      "coverage",
      "node_modules",
      "examples",
      "target",
      "rust/**/*.rs",
      "vendor",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 20,
          allowDefaultProject: [
            "eslint.config.js",
            "scripts/*.mjs",
            "rust/*.mjs",
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-confusing-void-expression": "off",
    },
  },
  {
    files: ["scripts/*.mjs", "rust/*.mjs"],
    languageOptions: {
      globals: {
        AbortController: "readonly",
        Buffer: "readonly",
        console: "readonly",
        process: "readonly",
        URL: "readonly",
      },
    },
  },
  {
    // The module worker decodes untrusted JSON frames from the native host,
    // so values legitimately start as `any` before they are validated inline.
    files: ["rust/worker.mjs"],
    rules: {
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
    },
  },
);
