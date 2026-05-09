import axios from 'axios';

const STORAGE_ZONE_NAME = process.env.BUNNY_STORAGE_ZONE_NAME;
const ACCESS_KEY = process.env.BUNNY_STORAGE_ACCESS_KEY;
const CDN_URL = process.env.BUNNY_CDN_URL;
const REGION = process.env.BUNNY_STORAGE_REGION || 'de';

// API Host based on region (Frankfurt/DE uses storage.bunnycdn.com)
const BASE_STORAGE_URL = `https://storage.bunnycdn.com/${STORAGE_ZONE_NAME}`;

export class BunnyService {
  /**
   * Uploads a file buffer to Bunny.net Storage
   * @param buffer The file buffer
   * @param remotePath The path in the storage zone (e.g., 'videos/lesson1.mp4')
   */
  static async uploadFile(buffer: Buffer, remotePath: string): Promise<string> {
    try {
      if (!STORAGE_ZONE_NAME || !ACCESS_KEY) {
        throw new Error('Bunny.net credentials are not configured in environment variables.');
      }

      const url = `${BASE_STORAGE_URL}/${remotePath}`;

      console.log(`📤 Uploading to Bunny.net: ${url}`);

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
        console.log(`✅ Bunny.net upload success: ${publicUrl}`);
        return publicUrl;
      } else {
        throw new Error(`Bunny.net upload failed with status ${response.status}`);
      }
    } catch (error: any) {
      console.error('❌ Bunny.net Upload Error:', error.response?.data || error.message);
      
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
      
      console.log(`🗑️ Deleted from Bunny.net: ${remotePath}`);
    } catch (error: any) {
      console.error('❌ Bunny.net Delete Error:', error.response?.data || error.message);
      // We don't throw here to avoid breaking the flow if a file was already deleted
    }
  }
}
