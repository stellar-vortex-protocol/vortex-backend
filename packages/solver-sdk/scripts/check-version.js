/**
 * Semantic versioning tied to the API version (issue #446): the SDK's
 * major.minor must equal the OpenAPI `info.version` major.minor it was
 * generated from, and `vortexApiVersion` must match it exactly.
 */
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const pkg = require("../package.json");
const openapi = JSON.parse(readFileSync(join(__dirname, "../../../src/generated/openapi.json"), "utf8"));
const api = openapi.info.version;
const majorMinor = (v) => v.split(".").slice(0, 2).join(".");

if (pkg.vortexApiVersion !== api || majorMinor(pkg.version) !== majorMinor(api)) {
  console.error(`SDK ${pkg.version} (vortexApiVersion ${pkg.vortexApiVersion}) does not match API ${api}`);
  process.exit(1);
}
console.log(`SDK ${pkg.version} matches API ${api}`);
