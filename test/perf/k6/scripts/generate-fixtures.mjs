#!/usr/bin/env node
/**
 * generate-fixtures.mjs
 *
 * Generates the pre-computed Ed25519 fixture signatures stored in
 * test/perf/k6/lib/helpers.js and used by the k6 lifecycle scenario.
 *
 * These signatures are for FIXTURE_INTENT_ID = '00000000-0000-4000-8000-000000000001'
 * and the seeded solver keypairs from src/solvers/solvers.seed.ts.
 *
 * Run:
 *   node test/perf/k6/scripts/generate-fixtures.mjs
 *
 * The script prints the current signature values which should match what is
 * already in helpers.js.  If the seeded keys change, update helpers.js with
 * the new values printed here.
 */

// stellar-base is a CommonJS module accessed via dynamic import
const { Keypair } = await import(
  new URL('../../../../node_modules/@stellar/stellar-base/lib/index.js', import.meta.url)
).then(m => m);

const FIXTURE_INTENT_ID = '00000000-0000-4000-8000-000000000001';

const SEED_SOLVER_SECRETS = {
  ALPHA: 'SCWJJ7RJRPSCSLIJ2FUPEE5MSKKL7TIBK65EXB7NDFC5MGBN6IPOU7PF',
  BETA:  'SBWYIL4TL74OJO3AY2C7C6HACHBDQUURZAY5H2URSARNNJ2OHKO6BQ7A',
  GAMMA: 'SABOQPQHOWLQD27MQ5EHT2B2HCEFOUN2QONXBUZWWKPOMVQYBZVRASCM',
};

function sign(kp, msg) {
  return kp.sign(Buffer.from(msg, 'utf8')).toString('base64');
}

const alpha = Keypair.fromSecret(SEED_SOLVER_SECRETS.ALPHA);
const beta  = Keypair.fromSecret(SEED_SOLVER_SECRETS.BETA);

const alphaAddr = alpha.publicKey();
const betaAddr  = beta.publicKey();

const acceptAlphaSig = sign(alpha, `accept:${FIXTURE_INTENT_ID}:${alphaAddr}`);
const fillAlphaSig   = sign(alpha, `fill:${FIXTURE_INTENT_ID}:${alphaAddr}`);
const acceptBetaSig  = sign(beta,  `accept:${FIXTURE_INTENT_ID}:${betaAddr}`);
const fillBetaSig    = sign(beta,  `fill:${FIXTURE_INTENT_ID}:${betaAddr}`);

console.log('=== Fixture values for test/perf/k6/lib/helpers.js ===\n');
console.log('FIXTURE_INTENT_ID:', FIXTURE_INTENT_ID);
console.log('ALPHA_ADDR:   ', alphaAddr);
console.log('BETA_ADDR:    ', betaAddr);
console.log('');
console.log('ACCEPT_ALPHA_SIG:', acceptAlphaSig);
console.log('FILL_ALPHA_SIG:  ', fillAlphaSig);
console.log('ACCEPT_BETA_SIG: ', acceptBetaSig);
console.log('FILL_BETA_SIG:   ', fillBetaSig);

// Verify the signatures round-trip
const { StrKey } = await import(
  new URL('../../../../node_modules/@stellar/stellar-base/lib/index.js', import.meta.url)
).then(m => m);

function verify(kp, msg, sig) {
  return kp.verify(Buffer.from(msg, 'utf8'), Buffer.from(sig, 'base64'));
}

console.log('\n=== Verification ===');
console.log('accept/alpha valid:', verify(alpha, `accept:${FIXTURE_INTENT_ID}:${alphaAddr}`, acceptAlphaSig));
console.log('fill/alpha valid:  ', verify(alpha, `fill:${FIXTURE_INTENT_ID}:${alphaAddr}`, fillAlphaSig));
