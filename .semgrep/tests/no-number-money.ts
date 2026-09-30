// Fixture for no-number-money + no-float-fee-math
// ruleid: no-number-money
const bad = Number(intent.srcAmount);
// ruleid: no-number-money
const bad2 = parseFloat(dto.fillAmount);
// ok: no-number-money
const good = BigInt(intent.srcAmount);
// ok: no-number-money
const units = parseBaseUnits(dto.srcAmount);
