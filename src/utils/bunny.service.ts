import axios from 'axios';
import { logger } from './logger';

const STORAGE_ZONE_NAME = process.env.BUNNY_STORAGE_ZONE_NAME;
const ACCESS_KEY = process.env.BUNNY_STORAGE_ACCESS_KEY;
const CDN_URL = process.env.BUNNY_CDN_URL;
const REGION = process.env.BUNNY_STORAGE_REGION || 'de';

// Bunny Stream Config
const STREAM_API_KEY = process.env.BUNNY_STREAM_API_KEY;
const STREAM_LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID;

// API host depends on the Storage Zone region. Frankfurt/DE uses the
// unprefixed host; other regions use e.g. ny.storage.bunnycdn.com.
const STORAGE_HOST = !REGION || REGION === 'de'
  ? 'storage.bunnycdn.com'
  : `${REGION}.storage.bunnycdn.com`;
const BASE_STORAGE_URL = `https://${STORAGE_HOST}/${STORAGE_ZONE_NAME}`;
const BASE_STREAM_URL = `https://video.bunnycdn.com/library/${STREAM_LIBRARY_ID}`;

export class BunnyService {
  /**
   * Creates a video placeholder in Bunny Stream
   * Returns the Video ID (GUID)
   */
  static async createStreamVideo(title: string): Promise<{ guid: string; libraryId: string }> {
    try {
      if (!STREAM_API_KEY || !STREAM_LIBRARY_ID) {
        throw new Error('Bunny Stream credentials are not configured.');
      }

      const response = await axios.post(
        `${BASE_STREAM_URL}/videos`,
        { title },
        {
          headers: {
            AccessKey: STREAM_API_KEY,
            'Content-Type': 'application/json',
          },
        }
      );

      return {
        guid: response.data.guid,
        libraryId: STREAM_LIBRARY_ID,
      };
    } catch (error: any) {
      logger.error('❌ Bunny Stream Create Error:', error.response?.data || error.message);
      throw new Error(`Failed to create video in Bunny Stream: ${error.message}`);
    }
  }

  /**
   * Uploads a file buffer to Bunny.net Storage
   * @param buffer The file buffer
   * @param remotePath The path in the storage zone (e.g., 'videos/lesson1.mp4')
   */
  static async uploadFile(buffer: Buffer, remotePath: string): Promise<string> {
    try {
      if (!STORAGE_ZONE_NAME || !ACCESS_KEY || !CDN_URL) {
        throw new Error('Bunny.net Storage Zone, access key, and CDN URL must be configured.');
      }

      const url = `${BASE_STORAGE_URL}/${remotePath}`;

      logger.info(`📤 Uploading to Bunny.net: ${url}`);

      const response = await axios.put(url, buffer, {
        headers: {
          AccessKey: ACCESS_KEY,
          'Content-Type': 'application/octet-stream',
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 300000, // 5 minutes for large files
      });

      if (response.status === 201 || response.status === 200) {
        // Construct the public CDN URL
        const publicUrl = `${CDN_URL}/${remotePath}`;
        logger.info(`✅ Bunny.net upload success: ${publicUrl}`);
        return publicUrl;
      } else {
        throw new Error(`Bunny.net upload failed with status ${response.status}`);
      }
    } catch (error: any) {
      logger.error('❌ Bunny.net Upload Error:', error.response?.data || error.message);
      
      if (error.code === 'ECONNABORTED') {
        throw new Error('Bunny.net upload timed out. Please check your connection or try again.');
      }
      
      if (error.response?.status === 401) {
        throw new Error('Bunny.net authentication failed. Please check your Access Key.');
      }

      throw new Error(`Failed to upload file to Bunny.net: ${error.message}`);
    }
  }

  /**
   * Deletes a file from Bunny.net Storage
   * @param remotePath The path in the storage zone
   */
  static async deleteFile(remotePath: string): Promise<void> {
    try {
      const url = `${BASE_STORAGE_URL}/${remotePath}`;
      
      await axios.delete(url, {
        headers: { AccessKey: ACCESS_KEY },
      });
      
      logger.info(`🗑️ Deleted from Bunny.net: ${remotePath}`);
    } catch (error: any) {
      logger.error('❌ Bunny.net Delete Error:', error.response?.data || error.message);
      // We don't throw here to avoid breaking the flow if a file was already deleted
    }
  }
}
