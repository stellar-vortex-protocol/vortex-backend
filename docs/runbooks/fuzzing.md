# Fuzzing Runbook (issue #466)

Property-based fuzzing for DTO validation, amount parsing and address
validation lives in `test/fuzz/` and runs on [fast-check](https://fast-check.dev/).

## Running locally

```bash
npx jest test/fuzz                 # bounded (200 runs/property)
FUZZ_NUM_RUNS=100000 npx jest test/fuzz   # long-run
