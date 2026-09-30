#!/usr/bin/env node
// Shared helpers for the CI scripts in this directory (issue #486).
//
// Everything here is plain Node with no third-party imports so the scripts can
// run before (or entirely without) `npm ci` -- for example as a pre-commit guard
// on the quarantine file itself.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root, derived from this file's location (scripts/ci/ -> ../..). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const QUARANTINE_PATH = resolve(REPO_ROOT, "test", "quarantine.json");

const require = createRequire(import.meta.url);

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Repo-relative, forward-slash form of an absolute path, for stable output. */
export function relFromRepo(absolute) {
  return relative(REPO_ROOT, absolute).split("\\").join("/");
}

export function assertRepoRelative(path, label) {
  if (!path || typeof path !== "string") {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (isAbsolute(path) || path.startsWith("..")) {
    throw new Error(`${label} must be repo-relative, got "${path}"`);
  }
  return path;
}

/**
 * Read and validate test/quarantine.json.
 *
 * Returns `{ staleAfterDays, quarantined: [{ path, reason, owner, issue, addedAt, absolute }] }`.
 * Throws with a list of every problem found, so one CI run reports all of them
 * instead of drip-feeding one failure per attempt.
 */
export function loadQuarantine({ now = new Date() } = {}) {
  if (!existsSync(QUARANTINE_PATH)) {
    throw new Error(`missing ${relFromRepo(QUARANTINE_PATH)}`);
  }

  let raw;
  try {
    raw = readJson(QUARANTINE_PATH);
  } catch (error) {
    throw new Error(`${relFromRepo(QUARANTINE_PATH)} is not valid JSON: ${error.message}`);
  }

  const problems = [];
  const staleAfterDays = Number.isFinite(raw?.staleAfterDays) ? raw.staleAfterDays : 90;

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${relFromRepo(QUARANTINE_PATH)} must be an object with a "quarantined" array`);
  }
  if (!Array.isArray(raw.quarantined)) {
    throw new Error(`${relFromRepo(QUARANTINE_PATH)}: "quarantined" must be an array`);
  }

  const seen = new Map();
  const quarantined = [];

  for (const [index, entry] of raw.quarantined.entries()) {
    const at = `quarantined[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push(`${at}: must be an object`);
      continue;
    }

    const problemsBefore = problems.length;

    try {
      assertRepoRelative(entry.path, `${at}.path`);
    } catch (error) {
      problems.push(error.message);
    }
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
      problems.push(`${at}.reason: must describe why the test is quarantined`);
    }
    if (typeof entry.owner !== "string" || !/^@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(entry.owner.trim())) {
      problems.push(`${at}.owner: must be a GitHub handle such as "@octocat", got ${JSON.stringify(entry.owner)}`);
    }
    if (typeof entry.issue !== "string" || !/^(?:#\d+|https:\/\/github\.com\/.+\/issues\/\d+)$/.test(entry.issue.trim())) {
      problems.push(`${at}.issue: must be "#123" or a GitHub issue URL, got ${JSON.stringify(entry.issue)}`);
    }
    const addedAt = Date.parse(entry.addedAt ?? "");
    if (!Number.isFinite(addedAt)) {
      problems.push(`${at}.addedAt: must be an ISO date such as "2026-09-27", got ${JSON.stringify(entry.addedAt)}`);
    }

    if (typeof entry.path === "string") {
      if (seen.has(entry.path)) {
        problems.push(`${at}.path: ${entry.path} is already quarantined by ${seen.get(entry.path)}`);
      } else {
        seen.set(entry.path, at);
      }
      const absolute = resolve(REPO_ROOT, entry.path);
      if (!existsSync(absolute)) {
        problems.push(`${at}.path: ${entry.path} does not exist; remove the stale quarantine entry`);
      }
    }

    if (problems.length !== problemsBefore) continue;

    const ageDays = Math.floor((now.getTime() - addedAt) / 86_400_000);
    quarantined.push({
      ...entry,
      owner: entry.owner.trim(),
      issue: entry.issue.trim(),
      absolute,
      ageDays,
      stale: ageDays > staleAfterDays,
    });
  }

  if (problems.length) {
    throw new Error(
      `${relFromRepo(QUARANTINE_PATH)} is invalid:\n` + problems.map((p) => `  - ${p}`).join("\n"),
    );
  }

  return { staleAfterDays, quarantined };
}
