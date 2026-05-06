const fs = require('fs');
const path = require('path');

const OUTPUT_FILE = 'full_project_code.txt';
const ROOT_DIR = __dirname;

const EXCLUDED_DIRS = ['node_modules', 'build', '.dart_tool', '.git', 'dist'];
const EXCLUDED_EXTENSIONS = ['.g.dart'];
const INCLUDED_EXTENSIONS = ['.ts', '.dart', '.prisma'];

const EXCLUDED_PATTERNS = [/\.g\.dart$/, /\.mp4$/, /\.jpg$/, /\.png$/, /\.gif$/, /\.svg$/, /\.webp$/];

function shouldExclude(filePath) {
  const relativePath = path.relative(ROOT_DIR, filePath);
  const parts = relativePath.split(path.sep);
  
  for (const dir of EXCLUDED_DIRS) {
    if (parts.includes(dir)) return true;
  }
  
  const ext = path.extname(filePath).toLowerCase();
  if (EXCLUDED_EXTENSIONS.includes(ext)) return true;
  
  for (const pattern of EXCLUDED_PATTERNS) {
    if (pattern.test(filePath)) return true;
  }
  
  return false;
}

function collectFiles(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.includes(entry.name)) {
        collectFiles(fullPath, files);
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (INCLUDED_EXTENSIONS.includes(ext) && !shouldExclude(fullPath)) {
        files.push(fullPath);
      }
    }
  }
  
  return files;
}

function main() {
  console.log('🚀 Collecting project code...\n');
  
  const output = fs.createWriteStream(OUTPUT_FILE);
  
  output.write('='.repeat(60) + '\n');
  output.write('FULL PROJECT CODE COLLECTION\n');
  output.write('Generated: ' + new Date().toISOString() + '\n');
  output.write('='.repeat(60) + '\n\n');
  
  const srcDir = path.join(ROOT_DIR, 'src');
  const libDir = path.join(ROOT_DIR, '..', 'edutech_app', 'lib');
  
  console.log('Scanning directories:');
  console.log('  - ' + srcDir);
  console.log('  - ' + libDir + '\n');
  
  const files = [];
  
  if (fs.existsSync(srcDir)) {
    collectFiles(srcDir, files);
  }
  
  if (fs.existsSync(libDir)) {
    collectFiles(libDir, files);
  }
  
  console.log(`Found ${files.length} files to process.\n`);
  
  files.sort();
  
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const relativePath = path.relative(ROOT_DIR, file);
    
    console.log(`[${i + 1}/${files.length}] Processing: ${relativePath}`);
    
    output.write('\n' + '-'.repeat(50) + '\n');
    output.write('FILE: ' + relativePath + '\n');
    output.write('-'.repeat(50) + '\n\n');
    
    const content = fs.readFileSync(file, 'utf8');
    output.write(content);
    output.write('\n');
  }
  
  output.end();
  
  output.on('finish', () => {
    const stats = fs.statSync(OUTPUT_FILE);
    console.log(`\n✅ Done! Output written to: ${OUTPUT_FILE}`);
    console.log(`📄 Total size: ${(stats.size / 1024).toFixed(2)} KB`);
    console.log(`📁 Files included: ${files.length}`);
  });
}

main();