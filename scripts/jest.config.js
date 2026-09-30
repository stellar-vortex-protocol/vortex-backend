/** @type {import('jest').Config} */
// Jest config for tooling tests under scripts/ (e.g. the migration checker's
// fixtures). Run via `npm run test:scripts`. Kept separate from the main
// `jest.config.js` (rootDir `src`) so src/ coverage thresholds don't apply.
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: "..",
  testMatch: ["<rootDir>/scripts/**/*.spec.ts"],
};
