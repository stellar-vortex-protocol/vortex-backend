import { Test, TestingModule } from '@nestjs/testing';
import { ParamsController } from './params.controller';
import { ProtocolParamsService } from './protocol-params.service';
import { GuardianStateService } from './guardian-state.service';

describe('ParamsController', () => {
  let controller: ParamsController;
  let protocolParams: { getParams: jest.Mock };
  let guardianState: { snapshot: jest.Mock };

  beforeEach(async () => {
    protocolParams = {
      getParams: jest.fn().mockResolvedValue({ feeBps: 30 }),
    };
    guardianState = {
      snapshot: jest.fn().mockReturnValue({ frozenParams: {} }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ParamsController],
      providers: [
        { provide: ProtocolParamsService, useValue: protocolParams },
        { provide: GuardianStateService, useValue: guardianState },
      ],
    }).compile();

    controller = module.get<ParamsController>(ParamsController);
  });

  it('is defined', () => {
    expect(controller).toBeDefined();
  });

  describe('freezeStatus', () => {
    it('reports nothing frozen when there are no frozen params', () => {
      guardianState.snapshot.mockReturnValue({ frozenParams: {} });

      const result = controller.freezeStatus();

      expect(result).toEqual({ globallyFrozen: false, frozenKeys: [] });
    });

    it('reports a single-key freeze with its guardian reason', () => {
      guardianState.snapshot.mockReturnValue({
        frozenParams: {
          feeBps: {
            reason: 'anomaly detected',
            since: '2024-01-01T00:00:00.000Z',
            actionId: 'action-1',
            txHash: '0xabc',
          },
        },
      });

      const result = controller.freezeStatus();

      expect(result.globallyFrozen).toBe(false);
      expect(result.frozenKeys).toEqual([
        {
          key: 'feeBps',
          since: '2024-01-01T00:00:00.000Z',
          reason: 'anomaly detected',
          actionId: 'action-1',
          txHash: '0xabc',
        },
      ]);
    });

    it('surfaces a global ALL_PARAMS freeze distinctly', () => {
      guardianState.snapshot.mockReturnValue({
        frozenParams: {
          '*': {
            reason: 'emergency halt',
            since: '2024-02-02T00:00:00.000Z',
            actionId: 'action-2',
            txHash: '0xdef',
          },
        },
      });

      const result = controller.freezeStatus();

      expect(result.globallyFrozen).toBe(true);
      expect(result.frozenKeys).toEqual([
        {
          key: '*',
          since: '2024-02-02T00:00:00.000Z',
          reason: 'emergency halt',
          actionId: 'action-2',
          txHash: '0xdef',
        },
      ]);
    });
  });
});
