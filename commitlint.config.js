/**
 * commitlint.config.js
 *
 * Enforces Conventional Commits across all commits and PR titles in CI.
 * The git history already follows this convention informally — this config
 * makes it a hard requirement going forward.
 *
 * Allowed types:
 *   feat     — new feature
 *   fix      — bug fix
 *   docs     — documentation only
 *   style    — formatting, no logic change
 *   refactor — code change that is neither a feat nor a fix
 *   test     — adding or correcting tests
 *   chore    — build process, tooling, dependency updates
 *   perf     — performance improvement
 *   ci       — CI/CD configuration changes
 *   build    — changes that affect the build system
 *   revert   — reverting a prior commit
 *
 * Reference: https://www.conventionalcommits.org/
 *
 * Closes #137
 */

/** @type {import('@commitlint/types').UserConfig} */
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Keep subject lines readable in changelogs — 100 chars is generous enough
    // for descriptive messages while still fitting in a terminal / GitHub UI.
    'header-max-length': [2, 'always', 100],

    // Allow both lower-case and sentence-case subjects (the codebase mixes both).
    'subject-case': [
      1, // warn, not error — lets us phase this in without breaking existing flow
      'never',
      ['start-case', 'pascal-case', 'upper-case'],
    ],

    // Scopes are optional but must be lower-kebab-case when present.
    'scope-case': [2, 'always', 'lower-case'],

    // Body and footer lines have a generous limit for detailed explanations.
    'body-max-line-length': [1, 'always', 200],
    'footer-max-line-length': [1, 'always', 200],
  },
};
