import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { GuardianController } from './guardian.controller';
import { GuardianStateService } from './guardian-state.service';
import { GuardianStreamController } from './guardian-stream.controller';

@Module({
  imports: [EventEmitterModule.forRoot()],
  controllers: [GuardianController, GuardianStreamController],
  providers: [GuardianStateService],
  exports: [GuardianStateService],
})
export class GuardianModule {}
