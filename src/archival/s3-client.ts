import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { ArchivalConfig } from "./archival-config";

/**
 * Thin wrapper around the AWS S3 client that works with MinIO (#413).
 *
 * MinIO support: set `endpoint` to `http://localhost:9000` and
 * `forcePathStyle` is automatically enabled when a non-AWS endpoint is
 * detected.
 */
export class ArchivalS3Client {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: ArchivalConfig) {
    this.bucket = config.bucketName;
    const isMinIo = Boolean(config.endpoint);

    this.client = new S3Client({
      region: config.region,
      // MinIO / custom endpoint support.
      ...(isMinIo
        ? {
            endpoint: config.endpoint,
            forcePathStyle: true,
          }
        : {}),
      credentials:
        config.accessKeyId && config.secretAccessKey
          ? {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            }
          : undefined,
    });
  }

  /**
   * Upload a buffer to `s3://<bucket>/<key>`.
   * Throws on any S3 / network error — callers must not delete Postgres rows
   * unless this succeeds.
   */
  async put(key: string, body: Buffer, contentType = "application/octet-stream"): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.length,
      }),
    );
  }

  /**
   * Returns true when `key` already exists in the bucket (idempotency check).
   */
  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      if ((err as { name?: string }).name === "NotFound" || (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) {
        return false;
      }
      throw err;
    }
  }

  /**
   * List object keys under `prefix` using S3 `ListObjectsV2` (paginated).
   *
   * Returns the keys found on this page plus `nextContinuationToken` when more
   * results are available — pass it back in `opts.continuationToken` to fetch
   * the next page. Used by the integrity re-verification job to enumerate
   * archived manifest keys without a side-table of archived dates.
   */
  async listKeys(
    prefix: string,
    opts: { maxKeys?: number; continuationToken?: string } = {},
  ): Promise<{ keys: string[]; nextContinuationToken?: string }> {
    const response = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        MaxKeys: opts.maxKeys,
        ContinuationToken: opts.continuationToken,
      }),
    );

    const keys = (response.Contents ?? [])
      .map((obj) => obj.Key)
      .filter((key): key is string => typeof key === "string");

    return {
      keys,
      nextContinuationToken: response.IsTruncated
        ? response.NextContinuationToken
        : undefined,
    };
  }

  /**
   * Fetch the raw content of an existing object.
   */
  async get(key: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const stream = response.Body as Readable;
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", reject);
    });
  }
}
