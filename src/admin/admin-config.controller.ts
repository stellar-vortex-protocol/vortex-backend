import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { AdminGuard } from './admin.guard';
import { AppConfig } from '../config/configuration';
import { redactConfig } from '../config/config-redaction';

@ApiTags('admin')
@ApiBearerAuth()
@Controller('api/v1/admin/config')
@UseGuards(AdminGuard)
export class AdminConfigController {
  constructor(private readonly configService: ConfigService) {}

  @Get()
  @ApiOperation({
    summary: 'Get resolved runtime configuration',
    description:
      'Returns the resolved, non-secret runtime configuration for the running process. ' +
      'Secret-shaped fields (databaseUrl, *Key/*Secret/*Token fields, secrets.extra) are redacted. ' +
      'This endpoint is strictly read-only.',
  })
  @ApiOkResponse({
    description:
      'The resolved AppConfig object with secret-shaped fields redacted.',
  })
  getConfig(): Record<string, unknown> {
    const resolved = this.configService.get<AppConfig>('app') ?? ({} as AppConfig);
    return redactConfig(resolved);
  }
}