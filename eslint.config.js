import js from "@eslint/js"
import tseslint from "typescript-eslint"

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // The egress rule: only src/egress.ts opens connections (see
      // README.md, "Where it connects"). Everything else goes through the
      // client it hands out.
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "node:https", message: "Only src/egress.ts dials out." },
            {
              name: "node:http",
              message: "Only src/http.ts serves, and nothing dials over HTTP.",
            },
            { name: "http", message: "Only src/http.ts serves." },
            { name: "https", message: "Only src/egress.ts dials out." },
            { name: "node:net", message: "Only src/egress.ts dials out." },
            { name: "node:tls", message: "Only src/egress.ts dials out." },
            { name: "node:dgram", message: "No UDP." },
            { name: "node:child_process", message: "No child processes." },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "Only src/egress.ts dials out." },
      ],
    },
  },
  {
    files: ["src/egress.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    // The MCP side: a server it listens with, never a request it makes.
    files: ["src/http.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    files: ["test/**/*.ts"],
    rules: { "no-restricted-globals": "off", "no-restricted-imports": "off" },
  },
)
