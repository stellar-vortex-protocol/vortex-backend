import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEnum, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from "class-validator";
import {
  KILL_SWITCH_OPERATION_ENUM,
  KILL_SWITCH_REASON_CODE_ENUM,
  KILL_SWITCH_SCOPE_ENUM,
  KillSwitchOperation,
  KillSwitchReasonCode,
  KillSwitchScope,
} from "../killswitch.types";

export class PauseKillSwitchDto {
  @ApiProperty({ enum: KILL_SWITCH_SCOPE_ENUM, description: "Breadth of the pause." })
  @IsEnum(KILL_SWITCH_SCOPE_ENUM)
  scope!: KillSwitchScope;

  @ApiPropertyOptional({ description: "Required for chain/token/operation scope." })
  @IsOptional()
  @IsString()
  chain?: string;

  @ApiPropertyOptional({ description: "Required for token scope; wildcard for operation scope." })
  @IsOptional()
  @IsString()
  token?: string;

  @ApiPropertyOptional({ enum: KILL_SWITCH_OPERATION_ENUM, description: "Required for operation scope." })
  @IsOptional()
  @IsEnum(KILL_SWITCH_OPERATION_ENUM)
  operation?: KillSwitchOperation;

  @ApiProperty({ enum: KILL_SWITCH_REASON_CODE_ENUM })
  @IsEnum(KILL_SWITCH_REASON_CODE_ENUM)
  reasonCode!: KillSwitchReasonCode;

  @ApiProperty({ description: "Operator explanation, shown to clients and in the audit log." })
  @IsString()
  @MinLength(4)
  @MaxLength(500)
  reason!: string;
}

export class ApproveResumeDto {
  @ApiPropertyOptional({ description: "Why the resume is safe." })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({ default: 2, minimum: 2, description: "Distinct approvals needed." })
  @IsOptional()
  @IsInt()
  @Min(2)
  approvalsRequired?: number;
}
