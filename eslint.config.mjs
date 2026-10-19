import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescriptConfig from "eslint-config-next/typescript";

const eslintConfig = [
  {
    // `.freebuff/**` is workspace metadata (evidence scripts, downloaded caption
    // files, and the local yt-dlp install) and is gitignored. Linting it reported
    // warnings from third-party vendored JavaScript, which says nothing about
    // this repository's code.
    ignores: [
      ".next/**",
      "node_modules/**",
      "coverage/**",
      "next-env.d.ts",
      ".freebuff/**",
      // Project-local agent skills are vendored tool instructions and helper
      // scripts, not application source. Some ship CommonJS/React-hook lint
      // false positives under this repository's application-only ESLint rules.
      ".agents/**",
      ".codex/**",
      ".taste-skill/**",
      ".logs/**",
    ],
  },
  ...coreWebVitals,
  ...typescriptConfig,
];

export default eslintConfig;
