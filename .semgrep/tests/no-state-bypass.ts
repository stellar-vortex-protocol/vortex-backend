// Fixture for no-direct-state-mutation + no-query-raw-unsafe
// ruleid: no-direct-state-mutation
await service.update(id, { state: "expired" });
// ok: no-direct-state-mutation
await service.expireIfOpen(id);
// ruleid: no-query-raw-unsafe
await prisma.$queryRawUnsafe("SELECT * FROM intents");
// ok: no-query-raw-unsafe
await prisma.$queryRaw`SELECT * FROM intents WHERE intent_id = ${id}`;
