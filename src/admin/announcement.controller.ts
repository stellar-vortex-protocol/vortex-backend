import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';
import { AdminGuard } from './admin.guard';
import { CurrentAdmin } from './current-admin.decorator';
import { AnnouncementService } from './announcement.service';

export type AnnouncementSeverity = 'info' | 'warning' | 'critical';

export class SetAnnouncementDto {
  @ApiPropertyOptional({
    description:
      'Announcement message. Provide a non-empty string to set/update the banner; omit or send null/empty to clear it.',
    example: 'Elevated settlement latency — transactions may take longer than usual.',
    maxLength: 500,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string | null;

  @ApiPropertyOptional({
    description: 'Severity of the announcement.',
    enum: ['info', 'warning', 'critical'],
    example: 'warning',
  })
  @IsOptional()
  @IsIn(['info', 'warning', 'critical'])
  severity?: AnnouncementSeverity;

  @ApiPropertyOptional({
    description:
      'Optional ISO-8601 timestamp after which the announcement is treated as cleared automatically.',
    example: '2025-01-01T12:00:00.000Z',
    nullable: true,
  })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string | null;
}

export class AnnouncementResponseDto {
  @ApiProperty({
    description: 'Announcement message, or null when no active announcement exists.',
    example: 'Elevated settlement latency — transactions may take longer than usual.',
    nullable: true,
  })
  message!: string | null;

  @ApiProperty({
    description: 'Severity of the announcement, or null when none is active.',
    enum: ['info', 'warning', 'critical'],
    nullable: true,
  })
  severity!: AnnouncementSeverity | null;

  @ApiProperty({
    description: 'Expiry timestamp (ISO-8601) or null when the announcement does not expire.',
    example: '2025-01-01T12:00:00.000Z',
    nullable: true,
  })
  expiresAt!: string | null;

  @ApiProperty({
    description: 'When the announcement was last set (ISO-8601), or null when none is active.',
    example: '2025-01-01T10:00:00.000Z',
    nullable: true,
  })
  updatedAt!: string | null;
}

@ApiTags('admin')
@Controller('admin/announcement')
@UseGuards(AdminGuard)
@ApiBearerAuth()
export class AnnouncementController {
  constructor(private readonly announcementService: AnnouncementService) {}

  @Put()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Set or clear the service status announcement',
    description:
      'Admin-only. Sets or updates the operator-authored status banner (message + severity + optional expiry), or clears it when the message is omitted/empty. Broadcasts a `status_announcement` WebSocket event to connected clients on any actual state change.',
  })
  @ApiBody({ type: SetAnnouncementDto })
  @ApiOkResponse({ type: AnnouncementResponseDto })
  async set(
    @Body() dto: SetAnnouncementDto,
    @CurrentAdmin() admin: { id: string; email?: string },
  ): Promise<AnnouncementResponseDto> {
    const result = await this.announcementService.setOrClear(
      {
        message: dto.message ?? null,
        severity: dto.severity,
        expiresAt: dto.expiresAt ?? null,
      },
      { id: admin?.id, email: admin?.email },
    );
    return this.toResponse(result);
  }

  private toResponse(
    announcement: {
      message: string | null;
      severity: AnnouncementSeverity | null;
      expiresAt: Date | string | null;
      updatedAt: Date | string | null;
    } | null,
  ): AnnouncementResponseDto {
    if (!announcement || !announcement.message) {
      return { message: null, severity: null, expiresAt: null, updatedAt: null };
    }
    return {
      message: announcement.message,
      severity: announcement.severity ?? 'info',
      expiresAt: this.toIso(announcement.expiresAt),
      updatedAt: this.toIso(announcement.updatedAt),
    };
  }

  private toIso(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : value;
  }
}

@ApiTags('status')
@Controller('api/v1/status')
export class PublicAnnouncementController {
  constructor(private readonly announcementService: AnnouncementService) {}

  @Get('announcement')
  @ApiOperation({
    summary: 'Get the current service status announcement',
    description:
      'Public. Returns the current non-expired operator-authored status announcement, or null fields when none is active. Expired announcements are treated as cleared at read time.',
  })
  @ApiOkResponse({ type: AnnouncementResponseDto })
  async get(): Promise<AnnouncementResponseDto> {
    const announcement = await this.announcementService.getActive();
    if (!announcement || !announcement.message) {
      return { message: null, severity: null, expiresAt: null, updatedAt: null };
    }
    return {
      message: announcement.message,
      severity: announcement.severity ?? 'info',
      expiresAt: this.toIso(announcement.expiresAt),
      updatedAt: this.toIso(announcement.updatedAt),
    };
  }

  private toIso(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : value;
  }
}