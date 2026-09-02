/**
 * Fails with a diff if the Joi schema in src/config/env.validation.ts, the
 * .env*.example files, and the process.env.X reads in src/config/configuration.ts
 * disagree about which environment variables exist.
 *
 * Run: tsx scripts/check-env-drift.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");

function extractJoiKeys(source: string): Set<string> {
  const keys = new Set<string>();
  // Matches top-level `  KEY_NAME: Joi....` lines inside Joi.object({ ... }).
  const re = /^\s{2}([A-Z][A-Z0-9_]*):\s/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    keys.add(match[1]);
  }
  return keys;
}

function extractExampleKeys(source: string): Set<string> {
  const keys = new Set<string>();
  const re = /^([A-Z][A-Z0-9_]*)=/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    keys.add(match[1]);
  }
  return keys;
}

function extractProcessEnvKeys(source: string): Set<string> {
  const keys = new Set<string>();
  const re = /process\.env\.([A-Z][A-Z0-9_]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    keys.add(match[1]);
  }
  return keys;
}

function diff(label: string, have: Set<string>, wantMissingFrom: Set<string>, wantLabel: string): string[] {
  const problems: string[] = [];
  for (const key of have) {
    if (!wantMissingFrom.has(key)) {
      problems.push(`  - ${key}: in ${label} but missing from ${wantLabel}`);
    }
  }
  return problems;
}

function main(): void {
  const envValidationSource = readFileSync(join(ROOT, "src/config/env.validation.ts"), "utf8");
  const configurationSource = readFileSync(join(ROOT, "src/config/configuration.ts"), "utf8");

  const exampleFiles = readdirSync(ROOT).filter((f) => /^\.env.*\.example$/.test(f));
  const genericExampleFile = ".env.example";

  const joiKeys = extractJoiKeys(envValidationSource);
  const configKeys = extractProcessEnvKeys(configurationSource);

  const genericExampleKeys = extractExampleKeys(
    readFileSync(join(ROOT, genericExampleFile), "utf8"),
  );

  let allExampleKeys = new Set<string>();
  for (const file of exampleFiles) {
    const keys = extractExampleKeys(readFileSync(join(ROOT, file), "utf8"));
    allExampleKeys = new Set([...allExampleKeys, ...keys]);
  }

  const problems: string[] = [];

  // Every process.env.X read in configuration.ts must be validated by Joi.
  problems.push(...diff("src/config/configuration.ts", configKeys, joiKeys, "env.validation.ts Joi schema"));

  // Every Joi-validated key must be documented in at least the generic .env.example.
  problems.push(...diff("env.validation.ts Joi schema", joiKeys, genericExampleKeys, genericExampleFile));

  // Every variable documented in any .env*.example file must have a matching Joi key.
  problems.push(...diff("a .env*.example file", allExampleKeys, joiKeys, "env.validation.ts Joi schema"));

  if (problems.length > 0) {
    console.error("Environment variable drift detected:\n");
    console.error(problems.join("\n"));
    console.error(
      "\nKeep src/config/env.validation.ts, .env*.example, and src/config/configuration.ts in sync.",
    );
    process.exit(1);
  }

  console.log("No environment variable drift detected.");
}

main();
