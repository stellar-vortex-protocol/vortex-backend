import { ParquetReader } from "parquetjs";
import { toParquet } from "./parquet-exporter";
import { DATASET_SCHEMAS } from "./schemas";
import { DatasetRow } from "./datasets.types";

async function readBack(buffer: Buffer): Promise<Record<string, unknown>[]> {
  const fs = await import("fs/promises");
  const os = await import("os");
  const nodePath = await import("path");
  // Use the OS temp dir rather than a hard-coded /tmp, which does not exist on
  // Windows and made this round-trip test fail outside Linux CI.
  const file = nodePath.join(
    os.tmpdir(),
    `parquet-roundtrip-${Date.now()}-${Math.random()}.parquet`,
  );
  await fs.writeFile(file, buffer);
  const reader = await ParquetReader.openFile(file);
  const cursor = reader.getCursor();
  const rows: Record<string, unknown>[] = [];
  let row: Record<string, unknown> | null;
  while ((row = (await cursor.next()) as Record<string, unknown> | null)) {
    rows.push(row);
  }
  await reader.close();
  await fs.unlink(file);
  return rows;
}

describe("toParquet", () => {
  const schema = DATASET_SCHEMAS.fees;

  it("returns null for an empty row set", async () => {
    expect(await toParquet(schema, [])).toBeNull();
  });

  it("writes a valid Parquet file that round-trips through a reader", async () => {
    const rows: DatasetRow[] = [
      { intentId: "i1", solver: null, srcChain: "stellar", dstToken: "C", feeAmount: "50", filledAt: 100 },
      { intentId: "i2", solver: "SOLVER", srcChain: "ethereum", dstToken: "C", feeAmount: "9999999999999999999", filledAt: null },
    ];
    const buffer = await toParquet(schema, rows, { schema: "fees-v1.0" });
    expect(buffer).not.toBeNull();

    const bufferBytes = buffer as Buffer;
    // Parquet magic bytes.
    expect(bufferBytes.slice(0, 4).toString("ascii")).toBe("PAR1");

    const readRows = await readBack(bufferBytes);
    expect(readRows).toHaveLength(2);
    expect(readRows[0].intentId).toBe("i1");
    expect(readRows[0].feeAmount).toBe("50");
    expect(readRows[0].filledAt).toBe(100);
    // Large numeric strings stay lossless (stored as UTF8).
    expect(readRows[1].feeAmount).toBe("9999999999999999999");
  });

  it("embeds the provided key-value metadata", async () => {
    const rows: DatasetRow[] = [{ intentId: "i1", solver: null, srcChain: "stellar", dstToken: "C", feeAmount: "1", filledAt: 1 }];
    const buffer = await toParquet(schema, rows, { schema: "fees-v1.0", date: "2026-09-28" });
    expect(buffer).not.toBeNull();
    // The footer carries key_value_metadata; just assert the buffer differs from
    // the no-metadata case (metadata is written into the footer).
    const without = await toParquet(schema, rows);
    expect((buffer as Buffer).equals(without as Buffer)).toBe(false);
  });
});
