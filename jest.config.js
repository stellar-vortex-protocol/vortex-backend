/** @type {import('jest').Config} */

// The single definition of the coverage gate. It is enforced on the *merged*
// shard report by scripts/ci/coverage-merge.mjs, not by individual shard runs
// (issue #486), which pass --coverageThreshold '{}' because a shard only ever
// executes part of the suite.
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: "src",
  testRegex: ".*\\.spec\\.ts$",
  collectCoverageFrom: ["**/*.(t|j)s"],
  coverageDirectory: "../coverage",
  // text-summary keeps local runs readable, lcov feeds editors, and json is what
  // coverage-merge.mjs consumes.
  coverageReporters: ["text-summary", "lcov", "json"],
  // Run both the main NestJS unit suite and the scripts suite under one command.
  projects: [
    // ── Main NestJS unit suite ──────────────────────────────────────────────
    {
      displayName: "src",
      preset: "ts-jest",
      testEnvironment: "node",
      rootDir: "src",
      testRegex: ".*\\.spec\\.ts$",
      // Exclude the scripts sub-suite so tests aren't picked up twice.
      testPathIgnorePatterns: ["/scripts/"],
      collectCoverageFrom: ["**/*.(t|j)s"],
      moduleNameMapper: {
        "^@nestjs/schedule$": "<rootDir>/../test/__mocks__/@nestjs/schedule.ts",
      },
    },

    // ── Scripts suite (ledger-utils, etc.) ─────────────────────────────────
    // Tests live in src/scripts/ but import from scripts/ (outside src/).
    // A dedicated tsconfig with broader rootDir handles the path.
    {
      displayName: "scripts",
      testEnvironment: "node",
      rootDir: ".",
      testMatch: ["<rootDir>/src/scripts/**/*.spec.ts"],
      transform: {
        "^.+\\.tsx?$": [
          "ts-jest",
          {
            tsconfig: "./tsconfig.scripts.json",
          },
        ],
      },
      moduleNameMapper: {
        "^@nestjs/schedule$": "<rootDir>/test/__mocks__/@nestjs/schedule.ts",
      },
    },
  ],

  // Coverage is collected from the project-level collectCoverageFrom above.
  coverageDirectory: "coverage",
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70,
    },
  },
};
