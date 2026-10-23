import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';
import { AdminGuard, CurrentAdmin } from './admin.guard';
import { CanaryRegistryService } from './canary-registry.service';

export class AddCanaryAddressDto {
  @IsString()
  @IsNotEmpty()
  address!: string;
}

export interface CanaryAddressResponse {
  address: string;
  addedAt: string;
  addedBy: string;
}

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(AdminGuard)
@Controller('api/v1/admin/canary-addresses')
export class CanaryRegistryController {
  constructor(private readonly canaryRegistry: CanaryRegistryService) {}

  @Get()
  @ApiOperation({ summary: 'List registered canary addresses' })
  @ApiResponse({ status: 200, description: 'List of canary addresses' })
  async list(): Promise<CanaryAddressResponse[]> {
    const entries = await this.canaryRegistry.list();
    return entries.map((entry) => ({
      address: entry.address,
      addedAt: entry.addedAt.toISOString(),
      addedBy: entry.addedBy,
    }));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register a new canary address' })
  @ApiResponse({ status: 201, description: 'Canary address registered' })
  @ApiResponse({ status: 400, description: 'Invalid address' })
  @ApiResponse({ status: 409, description: 'Address already registered' })
  async add(
    @Body() dto: AddCanaryAddressDto,
    @CurrentAdmin() admin: { id: string },
  ): Promise<CanaryAddressResponse> {
    const entry = await this.canaryRegistry.add(dto.address, admin.id);
    return {
      address: entry.address,
      addedAt: entry.addedAt.toISOString(),
      addedBy: entry.addedBy,
    };
  }

  @Delete(':address')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a canary address' })
  @ApiParam({ name: 'address', description: 'Canary address to remove' })
  @ApiResponse({ status: 204, description: 'Canary address removed' })
  @ApiResponse({ status: 404, description: 'Address not found' })
  async remove(@Param('address') address: string): Promise<void> {
    await this.canaryRegistry.remove(address);
  }
}