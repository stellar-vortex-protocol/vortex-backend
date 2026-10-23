import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ApiKeyService } from './api-key.service';
import { SIGNUP_TOKEN_STORE, SignupTokenStore } from './signup-token.store';

export class SignupRequestDto {
  @ApiProperty({
    description: 'Email address to send the verification link to.',
    example: 'integrator@example.com',
  })
  @IsEmail()
  @IsNotEmpty()
  email!: string;
}

export class SignupAcceptedDto {
  @ApiProperty({
    description:
      'Generic acknowledgement. Always identical regardless of whether the email is already associated with a key.',
    example: 'If the email is valid, a verification link has been sent.',
  })
  message!: string;
}

export class SelfServiceApiKeyResponseDto {
  @ApiProperty({ description: 'The plaintext API key. Shown exactly once.' })
  apiKey!: string;

  @ApiProperty({ description: 'The tier of the issued key.', example: 'integrator' })
  tier!: string;

  @ApiProperty({ description: 'The email the key was issued to.' })
  email!: string;
}

/**
 * Minimal outbound-mail abstraction. If the repo later gains a dedicated
 * mail/notification service, swap this out for it. Kept intentionally tiny so
 * the signup flow has no hard dependency on infrastructure that may not exist.
 */
export interface SignupMailer {
  sendVerificationEmail(email: string, verificationUrl: string): Promise<void>;
}

class LoggerSignupMailer implements SignupMailer {
  private readonly logger = new Logger(LoggerSignupMailer.name);

  async sendVerificationEmail(email: string, verificationUrl: string): Promise<void> {
    // Never log the raw token/URL at info level in production; log a redacted form.
    const redacted = verificationUrl.replace(/token=[^&]+/, 'token=***');
    this.logger.log(`Sending API-key signup verification email to ${email} (${redacted})`);
  }
}

const GENERIC_SIGNUP_MESSAGE =
  'If the email is valid, a verification link has been sent.';

@ApiTags('api-keys')
@Controller('api/v1/api-keys')
export class PublicApiKeyController {
  private readonly logger = new Logger(PublicApiKeyController.name);
  private readonly mailer: SignupMailer = new LoggerSignupMailer();

  constructor(
    private readonly apiKeyService: ApiKeyService,
    @Inject(SIGNUP_TOKEN_STORE) private readonly signupTokenStore: SignupTokenStore,
  ) {}

  @Post('signup')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Request a self-service API key',
    description:
      'Sends a verification link to the supplied email address. Always responds identically regardless of whether the email is already associated with a key, to prevent email enumeration. Self-service keys are always issued at the "integrator" tier.',
  })
  @ApiBody({ type: SignupRequestDto })
  @ApiAcceptedResponse({
    description: 'Verification email dispatched (if the email is valid).',
    type: SignupAcceptedDto,
  })
  @ApiBadRequestResponse({ description: 'Invalid email address.' })
  async signup(@Body() body: SignupRequestDto): Promise<SignupAcceptedDto> {
    const email = (body?.email ?? '').trim().toLowerCase();

    // Defensive: class-validator already enforces this, but keep the endpoint
    // safe even if validation is bypassed.
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('A valid email address is required.');
    }

    try {
      const token = await this.signupTokenStore.remember(email);
      const verificationUrl = `/api/v1/api-keys/signup/confirm?token=${encodeURIComponent(token)}`;
      await this.mailer.sendVerificationEmail(email, verificationUrl);
    } catch (err) {
      // Swallow errors so the response shape never leaks whether the email
      // exists or whether delivery succeeded.
      this.logger.warn(
        `Failed to dispatch signup verification email: ${(err as Error)?.message ?? err}`,
      );
    }

    return { message: GENERIC_SIGNUP_MESSAGE };
  }

  @Get('signup/confirm')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Confirm a self-service API-key signup',
    description:
      'Consumes a single-use, short-lived verification token and issues an "integrator"-tier API key. The plaintext key is returned exactly once.',
  })
  @ApiQuery({
    name: 'token',
    required: true,
    description: 'The verification token from the signup email.',
  })
  @ApiOkResponse({
    description: 'API key issued.',
    type: SelfServiceApiKeyResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Missing, expired, or already-used verification token.',
  })
  async confirm(
    @Query('token') token?: string,
  ): Promise<SelfServiceApiKeyResponseDto> {
    if (!token || typeof token !== 'string') {
      throw new BadRequestException('Invalid or expired verification token.');
    }

    const email = await this.signupTokenStore.consume(token);
    if (!email) {
      // Generic message for both expired and reused tokens.
      throw new BadRequestException('Invalid or expired verification token.');
    }

    // Tier is hard-coded to "integrator"; any body-supplied tier is ignored
    // because this endpoint takes no body at all.
    const created = await this.apiKeyService.createSelfServiceKey(email);

    return {
      apiKey: created.apiKey,
      tier: created.tier,
      email,
    };
  }
}