require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const archiver = require('archiver');
const crypto = require('crypto');
const { spawn } = require('child_process');

// Optional AWS S3 / Cloudflare R2 Support
let s3Client = null;
const useCloudStorage = Boolean(
  process.env.R2_ACCOUNT_ID &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY &&
  process.env.R2_BUCKET_NAME
);

if (useCloudStorage) {
  try {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
    console.log('  [Storage] Connected to Cloudflare R2 Bucket:', process.env.R2_BUCKET_NAME);
  } catch (err) {
    console.error('  [Storage] Failed to initialize Cloudflare R2:', err.message);
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
let publicTunnelUrl = null;

// --- Config & Auth ---
const CONFIG_FILE = path.join(__dirname, 'config.json');
let config = { ownerPin: process.env.OWNER_PIN || '1234' };
try {
  if (fs.existsSync(CONFIG_FILE)) {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } else {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  }
} catch (e) {
  console.error('Config load error, using default:', e);
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {
    console.error('Config save error:', e);
  }
}

const activeTokens = new Set();

// --- Local Shared Files Directory (used when not in S3 mode) ---
const SHARED_DIR = path.join(__dirname, 'shared-files');
if (!fs.existsSync(SHARED_DIR)) fs.mkdirSync(SHARED_DIR, { recursive: true });

// --- Helpers ---
function getSafePath(rel) {
  const resolved = path.resolve(path.join(SHARED_DIR, rel || ''));
  if (!resolved.startsWith(path.resolve(SHARED_DIR))) return null;
  return resolved;
}

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name in interfaces) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal &&
          iface.address.startsWith('192.168.') &&
          !name.toLowerCase().includes('virtualbox') &&
          !name.toLowerCase().includes('vmware') &&
          !name.toLowerCase().includes('docker')) {
        return iface.address;
      }
    }
  }
  for (const name in interfaces) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

function isOwner(req) {
  const ip = req.ip || req.connection.remoteAddress || '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  const token = req.headers['x-owner-token'] || req.query.ownerToken;
  if (token && activeTokens.has(token)) return true;
  return false;
}

function formatSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function getFileIcon(name, isDir) {
  if (isDir) return '📁';
  const ext = path.extname(name).toLowerCase();
  const map = {
    '.pdf':'📄','.doc':'📝','.docx':'📝','.txt':'📃','.rtf':'📝','.md':'📝',
    '.jpg':'🖼️','.jpeg':'🖼️','.png':'🖼️','.gif':'🖼️','.bmp':'🖼️','.svg':'🖼️','.webp':'🖼️',
    '.mp4':'🎬','.avi':'🎬','.mkv':'🎬','.mov':'🎬','.wmv':'🎬','.flv':'🎬','.webm':'🎬',
    '.mp3':'🎵','.wav':'🎵','.flac':'🎵','.aac':'🎵','.ogg':'🎵','.m4a':'🎵',
    '.zip':'📦','.rar':'📦','.7z':'📦','.tar':'📦','.gz':'📦',
    '.exe':'⚙️','.html':'🌐','.css':'🎨','.js':'💻','.ts':'💻','.json':'📋','.py':'🐍',
    '.ppt':'📊','.pptx':'📊','.xls':'📊','.xlsx':'📊','.apk':'📱'
  };
  return map[ext] || '📄';
}

function getFileCategory(name, isDir) {
  if (isDir) return 'folder';
  const ext = path.extname(name).toLowerCase();
  const images = ['.jpg','.jpeg','.png','.gif','.bmp','.svg','.webp'];
  const videos = ['.mp4','.avi','.mkv','.mov','.wmv','.flv','.webm'];
  const audio = ['.mp3','.wav','.flac','.aac','.ogg','.m4a'];
  const docs = ['.pdf','.doc','.docx','.txt','.rtf','.md','.xls','.xlsx','.ppt','.pptx','.csv'];
  const archives = ['.zip','.rar','.7z','.tar','.gz'];
  if (images.includes(ext)) return 'image';
  if (videos.includes(ext)) return 'video';
  if (audio.includes(ext)) return 'audio';
  if (docs.includes(ext)) return 'document';
  if (archives.includes(ext)) return 'archive';
  return 'other';
}

function getDirSize(dir) {
  let size = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      size += entry.isDirectory() ? getDirSize(full) : fs.statSync(full).size;
    }
  } catch (e) {}
  return size;
}

function countFiles(dir) {
  let count = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      count += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1;
    }
  } catch (e) {}
  return count;
}

// --- Multer Storage (Local or Memory for R2) ---
const uploadMemory = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 * 1024 } });

const localStorageEngine = multer.diskStorage({
  destination: function(req, file, cb) {
    const currentDir = req.body.currentDir || '';
    const baseTarget = getSafePath(currentDir);
    if (!baseTarget) return cb(new Error('Invalid directory'));

    let paths = [];
    try { paths = JSON.parse(req.body.paths || '[]'); } catch (e) {}

    if (req._fileIndex === undefined) req._fileIndex = 0;
    const customPath = paths[req._fileIndex] || file.originalname;
    const dir = path.dirname(customPath);
    let finalTarget = baseTarget;

    if (dir !== '.') {
      finalTarget = path.join(baseTarget, dir);
      if (!getSafePath(path.join(currentDir, dir))) return cb(new Error('Invalid structure'));
    }

    if (!fs.existsSync(finalTarget)) fs.mkdirSync(finalTarget, { recursive: true });
    cb(null, finalTarget);
  },
  filename: function(req, file, cb) {
    let paths = [];
    try { paths = JSON.parse(req.body.paths || '[]'); } catch (e) {}

    const customPath = paths[req._fileIndex] || file.originalname;
    req._fileIndex++;

    const originalName = path.basename(customPath);
    const dir = path.dirname(customPath);
    const currentDir = req.body.currentDir || '';
    const targetPath = path.join(SHARED_DIR, currentDir, dir === '.' ? '' : dir, originalName);

    if (fs.existsSync(targetPath)) {
      const ext = path.extname(originalName);
      const base = path.basename(originalName, ext);
      cb(null, base + '_' + Date.now() + ext);
    } else {
      cb(null, originalName);
    }
  }
});
const uploadLocal = multer({ storage: localStorageEngine, limits: { fileSize: 20 * 1024 * 1024 * 1024 } });

// --- Middleware ---
app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', '1');
  next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/static', express.static(path.join(__dirname, 'public')));

// --- API Routes ---

// List files (Supports Cloudflare R2 or Local)
app.get('/api/files', async function(req, res) {
  try {
    const currentDir = req.query.dir || '';

    if (useCloudStorage && s3Client) {
      const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
      const prefix = currentDir ? (currentDir.endsWith('/') ? currentDir : currentDir + '/') : '';

      const command = new ListObjectsV2Command({
        Bucket: process.env.R2_BUCKET_NAME,
        Prefix: prefix,
        Delimiter: '/'
      });
      const s3Res = await s3Client.send(command);

      const files = [];

      // Subfolders
      if (s3Res.CommonPrefixes) {
        for (const p of s3Res.CommonPrefixes) {
          const folderName = p.Prefix.replace(prefix, '').replace(/\/$/, '');
          if (folderName) {
            files.push({
              name: folderName,
              path: p.Prefix.replace(/\/$/, ''),
              isDirectory: true,
              size: 0,
              sizeFormatted: 'Folder',
              modified: new Date().toISOString(),
              icon: '📁',
              category: 'folder',
              ext: 'folder',
              fileCount: 0
            });
          }
        }
      }

      // Files
      if (s3Res.Contents) {
        for (const item of s3Res.Contents) {
          if (item.Key === prefix || item.Key.endsWith('/')) continue;
          const fileName = path.basename(item.Key);
          files.push({
            name: fileName,
            path: item.Key,
            isDirectory: false,
            size: item.Size,
            sizeFormatted: formatSize(item.Size),
            modified: item.LastModified,
            icon: getFileIcon(fileName, false),
            category: getFileCategory(fileName, false),
            ext: path.extname(fileName).toLowerCase().slice(1),
            fileCount: null
          });
        }
      }

      return res.json({
        files,
        ip: getLocalIP(),
        port: PORT,
        isOwner: isOwner(req),
        publicUrl: publicTunnelUrl || (process.env.PUBLIC_URL || null),
        currentDir,
        storageType: 'r2'
      });
    }

    // Local Disk Mode
    const targetDir = getSafePath(currentDir);
    if (!targetDir || !fs.existsSync(targetDir)) return res.status(404).json({ error: 'Not found' });

    const entries = fs.readdirSync(targetDir, { withFileTypes: true });
    const files = entries.map(function(entry) {
      const fullPath = path.join(targetDir, entry.name);
      const isDir = entry.isDirectory();
      const stats = fs.statSync(fullPath);
      const size = isDir ? getDirSize(fullPath) : stats.size;
      const category = getFileCategory(entry.name, isDir);
      return {
        name: entry.name,
        path: currentDir ? currentDir + '/' + entry.name : entry.name,
        isDirectory: isDir,
        size: size,
        sizeFormatted: formatSize(size),
        modified: stats.mtime,
        icon: getFileIcon(entry.name, isDir),
        category: category,
        ext: isDir ? 'folder' : path.extname(entry.name).toLowerCase().slice(1),
        fileCount: isDir ? countFiles(fullPath) : null
      };
    });

    files.sort(function(a, b) {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return new Date(b.modified) - new Date(a.modified);
    });

    res.json({
      files: files,
      ip: getLocalIP(),
      port: PORT,
      isOwner: isOwner(req),
      publicUrl: publicTunnelUrl,
      currentDir: currentDir,
      storageType: 'local'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Overall stats
app.get('/api/stats', function(req, res) {
  try {
    const totalSize = getDirSize(SHARED_DIR);
    const totalFiles = countFiles(SHARED_DIR);
    res.json({
      totalFiles,
      totalSize,
      totalSizeFormatted: formatSize(totalSize),
      uptime: process.uptime(),
      ip: getLocalIP(),
      port: PORT,
      publicUrl: publicTunnelUrl || (process.env.PUBLIC_URL || null),
      isOwner: isOwner(req),
      cloudMode: useCloudStorage
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Owner Authentication Endpoints
app.post('/api/auth/login', function(req, res) {
  const pin = (req.body.pin || '').trim();
  if (!pin) return res.status(400).json({ error: 'PIN required' });
  if (pin === config.ownerPin) {
    const token = crypto.randomBytes(24).toString('hex');
    activeTokens.add(token);
    return res.json({ success: true, token, isOwner: true });
  }
  res.status(401).json({ error: 'Invalid PIN. Try default (1234) or your configured PIN.' });
});

app.post('/api/auth/logout', function(req, res) {
  const token = req.headers['x-owner-token'] || req.body.token;
  if (token) activeTokens.delete(token);
  res.json({ success: true });
});

app.post('/api/auth/change-pin', function(req, res) {
  if (!isOwner(req)) return res.status(403).json({ error: 'Owner access required' });
  const newPin = (req.body.newPin || '').trim();
  if (!newPin || newPin.length < 4) return res.status(400).json({ error: 'PIN must be at least 4 digits' });
  config.ownerPin = newPin;
  saveConfig();
  res.json({ success: true, message: 'Owner PIN updated successfully' });
});

// Create New Folder
app.post('/api/folder', async function(req, res) {
  try {
    const currentDir = req.body.currentDir || '';
    const name = (req.body.name || '').trim();
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
      return res.status(400).json({ error: 'Invalid folder name' });
    }

    if (useCloudStorage && s3Client) {
      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      const folderKey = (currentDir ? currentDir + '/' + name : name) + '/';
      await s3Client.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: folderKey,
        Body: ''
      }));
      return res.json({ success: true, name: name, path: currentDir ? currentDir + '/' + name : name });
    }

    const targetDir = getSafePath(path.join(currentDir, name));
    if (!targetDir) return res.status(400).json({ error: 'Invalid path' });
    if (fs.existsSync(targetDir)) return res.status(400).json({ error: 'A folder with this name already exists' });
    fs.mkdirSync(targetDir, { recursive: true });
    res.json({ success: true, name: name, path: currentDir ? currentDir + '/' + name : name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rename file or folder (Owner only)
app.post('/api/rename', async function(req, res) {
  if (!isOwner(req)) return res.status(403).json({ error: 'Only owner can rename items' });
  try {
    const oldRelPath = req.body.oldPath;
    const newName = (req.body.newName || '').trim();
    if (!oldRelPath || !newName || newName.includes('/') || newName.includes('\\') || newName.includes('..')) {
      return res.status(400).json({ error: 'Invalid name provided' });
    }

    if (useCloudStorage && s3Client) {
      const { CopyObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
      const targetKey = path.posix.join(path.posix.dirname(oldRelPath), newName);
      await s3Client.send(new CopyObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        CopySource: `${process.env.R2_BUCKET_NAME}/${oldRelPath}`,
        Key: targetKey
      }));
      await s3Client.send(new DeleteObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: oldRelPath
      }));
      return res.json({ success: true });
    }

    const src = getSafePath(oldRelPath);
    if (!src || !fs.existsSync(src)) return res.status(404).json({ error: 'Item not found' });
    const dest = path.join(path.dirname(src), newName);
    if (fs.existsSync(dest)) return res.status(400).json({ error: 'An item with that name already exists' });
    fs.renameSync(src, dest);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload
const uploadHandler = useCloudStorage ? uploadMemory.array('files', 1000) : uploadLocal.array('files', 1000);
app.post('/api/upload', uploadHandler, async function(req, res) {
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

  if (useCloudStorage && s3Client) {
    try {
      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      let paths = [];
      try { paths = JSON.parse(req.body.paths || '[]'); } catch (e) {}
      const currentDir = req.body.currentDir || '';

      for (let i = 0; i < req.files.length; i++) {
        const file = req.files[i];
        const customPath = paths[i] || file.originalname;
        const key = currentDir ? path.posix.join(currentDir, customPath) : customPath;

        await s3Client.send(new PutObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: key,
          Body: file.buffer,
          ContentType: file.mimetype
        }));
      }
      return res.json({ success: true, count: req.files.length });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  res.json({ success: true, count: req.files.length });
});

// Bulk Delete (owner only)
app.delete('/api/files', async function(req, res) {
  if (!isOwner(req)) return res.status(403).json({ error: 'Only owner can delete files' });
  var filesToDelete = req.body.files;
  if (!Array.isArray(filesToDelete)) return res.status(400).json({ error: 'Invalid request' });

  if (useCloudStorage && s3Client) {
    try {
      const { DeleteObjectsCommand } = require('@aws-sdk/client-s3');
      const objects = filesToDelete.map(k => ({ Key: k }));
      await s3Client.send(new DeleteObjectsCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Delete: { Objects: objects }
      }));
      return res.json({ success: true, deleted: filesToDelete.length });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  var deleted = 0;
  for (var i = 0; i < filesToDelete.length; i++) {
    try {
      var filePath = getSafePath(filesToDelete[i]);
      if (filePath && fs.existsSync(filePath)) {
        var stats = fs.statSync(filePath);
        if (stats.isDirectory()) fs.rmSync(filePath, { recursive: true, force: true });
        else fs.unlinkSync(filePath);
        deleted++;
      }
    } catch (e) {}
  }
  res.json({ success: true, deleted: deleted });
});

// Batch Download (ZIP)
app.post('/api/download-batch', async function(req, res) {
  try {
    var files = JSON.parse(req.body.files || '[]');
    if (!files.length) return res.status(400).send('No files selected');

    res.attachment('WiFiShare_Archive.zip');
    var archive = archiver.create('zip', { zlib: { level: 5 } });
    archive.pipe(res);

    if (useCloudStorage && s3Client) {
      const { GetObjectCommand } = require('@aws-sdk/client-s3');
      for (const key of files) {
        try {
          const s3Obj = await s3Client.send(new GetObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: key
          }));
          archive.append(s3Obj.Body, { name: path.basename(key) });
        } catch (e) {}
      }
      return archive.finalize();
    }

    for (var i = 0; i < files.length; i++) {
      var filePath = getSafePath(files[i]);
      if (filePath && fs.existsSync(filePath)) {
        var s = fs.statSync(filePath);
        if (s.isDirectory()) archive.directory(filePath, path.basename(filePath));
        else archive.file(filePath, { name: path.basename(filePath) });
      }
    }
    archive.finalize();
  } catch (err) {
    res.status(500).send('Error generating batch archive');
  }
});

// Preview a file
app.get('/api/preview/*', async function(req, res) {
  const relPath = decodeURIComponent(req.params[0]);

  if (useCloudStorage && s3Client) {
    try {
      const { GetObjectCommand } = require('@aws-sdk/client-s3');
      const s3Obj = await s3Client.send(new GetObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: relPath
      }));
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('Content-Type', s3Obj.ContentType || 'application/octet-stream');
      return s3Obj.Body.pipe(res);
    } catch (e) {
      return res.status(404).send('Not found');
    }
  }

  var filePath = getSafePath(relPath);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('Not found');
  if (fs.statSync(filePath).isDirectory()) return res.status(400).send('Cannot preview folder');
  
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('ngrok-skip-browser-warning', '1');
  res.sendFile(filePath);
});

// Download a file or folder
app.get('/api/download/*', async function(req, res) {
  const relPath = decodeURIComponent(req.params[0]);

  if (useCloudStorage && s3Client) {
    try {
      const { GetObjectCommand } = require('@aws-sdk/client-s3');
      const s3Obj = await s3Client.send(new GetObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: relPath
      }));
      res.attachment(path.basename(relPath));
      return s3Obj.Body.pipe(res);
    } catch (e) {
      return res.status(404).send('Not found');
    }
  }

  var filePath = getSafePath(relPath);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('Not found');

  if (fs.statSync(filePath).isDirectory()) {
    var name = path.basename(filePath);
    res.attachment(name + '.zip');
    var archive = archiver.create('zip', { zlib: { level: 5 } });
    archive.pipe(res);
    archive.directory(filePath, name);
    archive.finalize();
  } else {
    res.download(filePath);
  }
});

// Serve the main page
app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Start Server ---
var server = http.createServer(app);
server.listen(PORT, '0.0.0.0', function() {
  var ip = getLocalIP();
  console.log('');
  console.log('  ==========================================');
  console.log('  |    WiFi Share Cloud is LIVE!           |');
  console.log('  ==========================================');
  console.log('  Local:   http://localhost:' + PORT);
  console.log('  Network: http://' + ip + ':' + PORT);

  // Ngrok permanent tunnel (for local Windows running)
  var ngrokPath = path.join(__dirname, 'ngrok.exe');
  if (fs.existsSync(ngrokPath) && !process.env.PORT) {
    var ngrokProcess = spawn(ngrokPath, [
      'http',
      '--domain=coffee-naturist-preschool.ngrok-free.dev',
      '--authtoken=3I67DAqUW2GymcJJXsRIfxWxtg2_4aMTqdcBL21hJYfknXReH',
      PORT.toString()
    ]);

    publicTunnelUrl = 'https://coffee-naturist-preschool.ngrok-free.dev';
    console.log('');
    console.log('  PERMANENT URL: ' + publicTunnelUrl);

    ngrokProcess.stdout.on('data', function(d) {});
    ngrokProcess.stderr.on('data', function(d) {
      var msg = d.toString().trim();
      if (msg.includes('ERROR')) console.log('  [ngrok] ' + msg);
    });
    ngrokProcess.on('error', function(err) {
      console.log('  Ngrok error: ' + err.message);
    });
  }

  console.log('');
  console.log('  Mode: ' + (useCloudStorage ? 'Cloudflare R2 (24/7 Global Cloud)' : 'Local Disk'));
  console.log('  Files: ' + SHARED_DIR);
  console.log('  ==========================================');
  console.log('');
});
