import fs from 'fs';
import path from 'path';

const uploadsPath = path.join(process.cwd(), 'uploads');
const videoFile = process.argv[2];

if (!videoFile) {
  console.log('Usage: node check-video.js <filename>');
  console.log('Example: node check-video.js video-123456789.mp4');
  process.exit(1);
}

const filePath = path.join(uploadsPath, videoFile);

if (!fs.existsSync(filePath)) {
  console.log('❌ File not found:', filePath);
  process.exit(1);
}

const stats = fs.statSync(filePath);
const buffer = Buffer.alloc(4096);
const fd = fs.openSync(filePath, 'r');
fs.readSync(fd, buffer, 0, 4096, 0);
fs.closeSync(fd);

console.log('📄 File:', videoFile);
console.log('📏 Size:', (stats.size / (1024 * 1024)).toFixed(2), 'MB');

const boxTypes = [
  { offset: 4, name: 'ftyp', desc: 'File Type Box' },
  { offset: 4, name: 'moov', desc: 'Movie Box (metadata)' },
  { offset: 4, name: 'mdat', desc: 'Media Data Box' },
  { offset: 4, name: 'free', desc: 'Free Space' },
  { offset: 4, name: 'skip', desc: 'Skip Box' },
];

console.log('\n📦 MP4 Box Structure (first bytes):');
for (let i = 0; i < 8; i += 4) {
  const size = buffer.readUInt32BE(i);
  const type = buffer.slice(i + 4, i + 8).toString('ascii').replace(/[^a-z]/g, '_');
  if (type && size > 0) {
    console.log(`  - ${type} (size: ${size} bytes)`);
  }
}

console.log('\n🔍 Checking for H.264 (AVC) encoding:');
const hasAvc1 = buffer.includes(Buffer.from('avc1'));
const hasAvc3 = buffer.includes(Buffer.from('avc3'));
const hasHvc1 = buffer.includes(Buffer.from('hvc1'));
const hasHev1 = buffer.includes(Buffer.from('hev1'));

if (hasAvc1 || hasAvc3) {
  console.log('  ✅ Video is H.264/AVC (compatible with all browsers)');
} else if (hasHvc1 || hasHev1) {
  console.log('  ⚠️  Video is H.265/HEVC (may not work in older browsers)');
} else {
  console.log('  ❓ Could not detect codec - may be non-standard');
}

console.log('\n💡 Tips:');
console.log('  - For Chrome, use H.264 (avc1) encoding');
console.log('  - Use ffmpeg to re-encode: ffmpeg -i input.mp4 -c:v libx264 -c:a aac output.mp4');
console.log('  - Use MediaInfo tool for detailed codec info');