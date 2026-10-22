import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { AdminGuard } from './admin.guard';
import { RequireAdminRole } from './require-admin-role.decorator';
import { SecretsService } from '../secrets/secrets.service';

/**
 * Response shape for a single loaded secret.
 *
 * Deliberately excludes secret values and raw version identifiers so the
 * payload cannot be used to aid a brute-force guess.
 */
export class AdminSecretStatusDto {
  /** Logical name of the secret (e.g. `DATABASE_PASSWORD`). */
  name!: string;

  /** Whether the secret is required for the application to start. */
  required!: boolean;

  /** ISO-8601 timestamp of when the secret was last loaded/rotated. */
  loadedAt!: string | null;

  /** Whether a previous version is retained for rollback. */
  hasPreviousVersion!: boolean;
}

/**
 * Response shape for the secrets health snapshot.
 */
export class AdminSecretsStatusDto {
  /** Active secrets provider name (`env`, `aws-secrets-manager`, `vault-kv`). */
  provider!: string;

  /** Status of every loaded secret. */
  secrets!: AdminSecretStatusDto[];
}

@ApiTags('admin')
@ApiBearerAuth()
@Controller({ path: 'admin/secrets', version: '1' })
@UseGuards(AdminGuard)
@RequireAdminRole('admin')
export class AdminSecretsController {
  constructor(private readonly secretsService: SecretsService) {}

  @Get()
  @ApiOperation({
    summary: 'Get secrets provider health snapshot',
    description:
      'Reports the active secrets provider, the logical names of every loaded ' +
      'secret, and per-secret rotation state. Secret values and raw version ' +
      'identifiers are never included.',
  })
  @ApiOkResponse({
    description: 'Redacted secrets health snapshot.',
    type: AdminSecretsStatusDto,
  })
  getStatus(): AdminSecretsStatusDto {
    return this.secretsService.getStatusSnapshot();
  }
}