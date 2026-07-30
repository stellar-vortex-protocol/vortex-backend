const mockServer = {
  getHealth: jest.fn().mockResolvedValue({ status: "ok" }),
  getLatestLedger: jest.fn().mockResolvedValue({ sequence: 1 }),
  getNetwork: jest.fn().mockResolvedValue({ passphrase: "test" }),
  getAccount: jest.fn().mockResolvedValue({ id: "test", sequence: "0" }),
};

export const SorobanRpc = {
  Server: jest.fn().mockImplementation(() => mockServer),
};
