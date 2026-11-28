import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { TokensService } from './tokens.service';
import { AdminTokensService } from './admin-tokens.service';
import { PatchAdminTokenDto } from './dto/admin-token.dto';
import { AdminGuard } from '../auth/admin.guard';

@ApiTags('tokens')
@Controller('tokens')
export class TokensController {
  constructor(
    private readonly tokensService: TokensService,
    private readonly adminTokensService: AdminTokensService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List registry tokens, optionally filtered by chain' })
  async list(@Query('chain') chain?: string) {
    if (chain) {
      return this.tokensService.getByChain(chain);
    }
    return this.tokensService.getAll();
  }

  @Get('canonical/:canonicalAssetId')
  @ApiOperation({
    summary: 'List every registry row sharing a canonical asset id, across all chains',
  })
  async getCanonicalGroup(@Param('canonicalAssetId') canonicalAssetId: string) {
    return this.tokensService.getByCanonicalAssetId(canonicalAssetId);
  }

  @Get(':chain/:address')
  @ApiOperation({ summary: 'Get a single registry token by chain and address' })
  async getOne(
    @Param('chain') chain: string,
    @Param('address') address: string,
  ) {
    return this.tokensService.getByChainAndAddress(chain, address);
  }

  @Patch(':chain/:address')
  @UseGuards(AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Admin: update a registry token (incl. canonicalAssetId)' })
  async patch(
    @Param('chain') chain: string,
    @Param('address') address: string,
    @Body() dto: PatchAdminTokenDto,
  ) {
    return this.adminTokensService.patch(chain, address, dto);
  }
}
