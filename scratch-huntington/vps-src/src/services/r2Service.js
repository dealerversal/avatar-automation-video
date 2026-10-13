import fs from 'fs';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

let s3Client = null;

export function getS3Client() {
    if (s3Client) return s3Client;

    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

    if (!accountId || !accessKeyId || !secretAccessKey) {
        console.warn('⚠️ Cloudflare R2 credentials are not fully configured.');
        return null;
    }

    s3Client = new S3Client({
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        forcePathStyle: true,
        credentials: {
            accessKeyId,
            secretAccessKey,
        },
    });

    return s3Client;
}

/**
 * Uploads a local media file to Cloudflare R2 under ai-content/{itemId}/{filename}
 * @param {string} localFilePath - Path to downloaded local file
 * @param {string} destinationKey - Target key in bucket (e.g. ai-content/gen_xxx/flow_image_123.png)
 * @param {string} contentType - MIME type (e.g. image/png or video/mp4)
 * @returns {Promise<{ r2Url: string|null, r2Key: string }>}
 */
export async function uploadToR2(localFilePath, destinationKey, contentType = 'application/octet-stream') {
    const client = getS3Client();
    const bucketName = process.env.R2_BUCKET_NAME;

    if (!client || !bucketName) {
        console.warn('⚠️ R2 Client or Bucket Name not configured — skipping R2 upload');
        return { r2Url: null, r2Key: destinationKey };
    }

    try {
        const fileStream = fs.createReadStream(localFilePath);

        const command = new PutObjectCommand({
            Bucket: bucketName,
            Key: destinationKey,
            Body: fileStream,
            ContentType: contentType,
        });

        await client.send(command);
        console.log(`      ☁️ ✅ Successfully uploaded file to Cloudflare R2 key: ${destinationKey}`);

        const publicDomain = process.env.R2_PUBLIC_DOMAIN;
        let r2Url = null;
        if (publicDomain) {
            const baseUrl = publicDomain.replace(/\/$/, '');
            const keyPath = destinationKey.replace(/^\//, '');
            r2Url = `${baseUrl}/${keyPath}`;
        } else {
            r2Url = `https://${bucketName}.r2.cloudflarestorage.com/${destinationKey}`;
        }

        return { r2Url, r2Key: destinationKey };
    } catch (err) {
        console.error(`      ❌ Failed to upload to Cloudflare R2: ${err.message}`);
        return { r2Url: null, r2Key: destinationKey, error: err.message };
    }
}
