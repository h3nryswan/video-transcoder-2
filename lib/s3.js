import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import fs from "fs";
import path from "path";

const REGION = process.env.AWS_REGION || "ap-southeast-2";
export const BUCKET = process.env.S3_BUCKET;
export const s3 = new S3Client({ region: REGION });

// Upload a buffer (for /upload)
export async function putBuffer(Key, buffer, ContentType) {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key, Body: buffer, ContentType }));
}

// Upload a file from disk (for transcoded output)
export async function putFile(Key, filePath, ContentType) {
  const stream = fs.createReadStream(filePath);
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key, Body: stream, ContentType }));
}

// Download S3 object to a local file (for ffmpeg input)
export async function downloadToFile(Key, outPath) {
  const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key }));
  await new Promise((resolve, reject) => {
    const w = fs.createWriteStream(outPath);
    resp.Body.pipe(w);
    resp.Body.on("error", reject);
    w.on("finish", resolve);
  });
}

// Generate a presigned GET URL (for /download)
export async function presignGet(Key, expiresSec = 3600) {
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key });
  return getSignedUrl(s3, cmd, { expiresIn: expiresSec });
}

export async function presignPut(Key, ContentType, expiresSec = 300) {
  const cmd = new PutObjectCommand({ Bucket: BUCKET, Key, ContentType });
  return getSignedUrl(s3, cmd, { expiresIn: expiresSec });
}