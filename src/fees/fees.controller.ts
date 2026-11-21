import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { FeesService } from './fees.service';
import { quoteFee, FeeRule, ReferralCode, FeeInput, FeeQuote } from './fee-engine';

const MAX_SAMPLE_INPUTS = 100;

interface SimulateRuleError {
  index: number;
  ruleId?: string;
  errors: string[];
}

interface SimulateResponse {
  valid: boolean;
  ruleErrors: SimulateRuleError[];
  quotes?: FeeQuote[];
}

@Controller('api/v1/fees')
export class FeesController {
  constructor(private readonly feesService: FeesService) {}

  @Get()
  async list() {
    return this.feesService.list();
  }

  @Post('simulate')
  simulate(
    @Body()
    body: {
      rules?: FeeRule[];
      referralCodes?: ReferralCode[];
      samples?: FeeInput[];
    },
  ): SimulateResponse {
    const rules = body?.rules ?? [];
    const referralCodes = body?.referralCodes ?? [];
    const samples = body?.samples ?? [];

    if (!Array.isArray(rules) || !Array.isArray(referralCodes) || !Array.isArray(samples)) {
      throw new HttpException(
        'rules, referralCodes and samples must be arrays',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (samples.length > MAX_SAMPLE_INPUTS) {
      throw new HttpException(
        `samples must contain at most ${MAX_SAMPLE_INPUTS} entries`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const ruleErrors = validateRules(rules);
    if (ruleErrors.length > 0) {
      return { valid: false, ruleErrors };
    }

    const quotes = samples.map((sample) =>
      quoteFee(sample, rules, referralCodes),
    );

    return { valid: true, ruleErrors: [], quotes };
  }
}

function validateRules(rules: FeeRule[]): SimulateRuleError[] {
  const errors: SimulateRuleError[] = [];

  rules.forEach((rule, index) => {
    const ruleErrors: string[] = [];

    if (rule.minFee != null && rule.maxFee != null && rule.minFee > rule.maxFee) {
      ruleErrors.push('minFee must not exceed maxFee');
    }

    if (rule.minFee != null && rule.minFee < 0) {
      ruleErrors.push('minFee must be non-negative');
    }

    if (rule.maxFee != null && rule.maxFee < 0) {
      ruleErrors.push('maxFee must be non-negative');
    }

    if (Array.isArray(rule.tiers)) {
      rule.tiers.forEach((tier, tierIndex) => {
        if (tier.min != null && tier.max != null && tier.min > tier.max) {
          ruleErrors.push(`tiers[${tierIndex}]: min must not exceed max`);
        }
        if (tier.rate != null && tier.rate < 0) {
          ruleErrors.push(`tiers[${tierIndex}]: rate must be non-negative`);
        }
      });
    }

    if (ruleErrors.length > 0) {
      errors.push({ index, ruleId: rule.id, errors: ruleErrors });
    }
  });

  return errors;
}
