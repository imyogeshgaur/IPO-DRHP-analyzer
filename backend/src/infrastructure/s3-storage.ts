import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PresignedUploadCreator } from "../api/app.js";
import type {
  DocumentStorage,
  TemporaryDocument,
} from "../services/ingestion.js";
import { AppError } from "../shared/errors.js";

export class S3DocumentStorage
  implements DocumentStorage, PresignedUploadCreator
{
  private readonly client: S3Client;

  constructor(
    private readonly bucketName: string,
    private readonly maxUploadBytes: number,
    region?: string,
  ) {
    this.client = new S3Client(region ? { region } : {});
  }

  close(): void {
    this.client.destroy();
  }

  async save(
    documentId: string,
    extension: string,
    data: Buffer,
  ): Promise<string> {
    const storagePath = `documents/${documentId}${extension}`;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: storagePath,
        Body: data,
      }),
    );
    return storagePath;
  }

  async remove(storagePath: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: storagePath,
      }),
    );
  }

  async downloadToTemporaryFile(
    storagePath: string,
    extension: string,
  ): Promise<TemporaryDocument> {
    if (!/^\.[a-z0-9]{1,10}$/.test(extension)) {
      throw new AppError(
        "INVALID_FILE_EXTENSION",
        "The stored document has an invalid file extension",
        400,
      );
    }

    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucketName,
        Key: storagePath,
      }),
    );
    if (response.ContentLength && response.ContentLength > this.maxUploadBytes) {
      throw new AppError(
        "UPLOAD_TOO_LARGE",
        "The stored document exceeds the configured file size limit",
        413,
      );
    }
    if (!response.Body) {
      throw new AppError(
        "EMPTY_DOCUMENT",
        "The stored S3 object has no content",
        422,
      );
    }

    const bytes = await response.Body.transformToByteArray();
    if (bytes.length === 0 || bytes.length > this.maxUploadBytes) {
      throw new AppError(
        bytes.length === 0 ? "EMPTY_DOCUMENT" : "UPLOAD_TOO_LARGE",
        bytes.length === 0
          ? "The stored S3 object has no content"
          : "The stored document exceeds the configured file size limit",
        bytes.length === 0 ? 422 : 413,
      );
    }

    const filePath = path.join(tmpdir(), `drhp-${randomUUID()}${extension}`);
    await mkdir(tmpdir(), { recursive: true });
    try {
      await writeFile(filePath, bytes, { flag: "wx" });
    } catch (error) {
      await rm(filePath, { force: true });
      throw error;
    }
    return {
      path: filePath,
      cleanup: async () => {
        await rm(filePath, { force: true });
      },
    };
  }

  async create(input: {
    documentId: string;
    extension: string;
    contentType: string;
  }): Promise<{
    storagePath: string;
    uploadUrl: string;
    fields: Record<string, string>;
  }> {
    const storagePath = `documents/${input.documentId}${input.extension}`;
    const post = await createPresignedPost(this.client, {
      Bucket: this.bucketName,
      Key: storagePath,
      Expires: 300,
      Fields: { "Content-Type": input.contentType },
      Conditions: [
        ["content-length-range", 1, this.maxUploadBytes],
        ["eq", "$Content-Type", input.contentType],
      ],
    });

    return {
      storagePath,
      uploadUrl: post.url,
      fields: post.fields,
    };
  }
}
