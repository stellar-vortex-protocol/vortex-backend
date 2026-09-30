/** @type {import('jest').Config} */
// Dedicated config for the property-based fuzz suite (issue #466).
// The main jest.config.js pins rootDir to "src" via its projects array, which
// would exclude test/fuzz entirely. This config keeps rootDir at the repo root
// and supplies an inline tsconfig so ts-jest never inherits tsconfig.json's
// rootDir:"./src" (which would raise TS6059 for files importing from src/).
module.exports = {
  testEnvironment: "node",
  rootDir: ".",
  testMatch: ["<rootDir>/test/fuzz/**/*.fuzz.spec.ts"],
  testPathIgnorePatterns: ["/node_modules/", "/dist/"],
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: {
          target: "ES2022",
          module: "commonjs",
          lib: ["ES2022"],
          strict: true,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          esModuleInterop: true,
          skipLibCheck: true,
          forceConsistentCasingInFileNames: true,
          resolveJsonModule: true,
          types: ["node", "jest"],
          // Intentionally NO rootDir / include here: test/fuzz imports from
          // src/, and a src-scoped rootDir would fail with TS6059.
        },
      },
    ],
  },
};
