const express = require('express');
const cors = require('cors');
const WebTorrent = require('webtorrent');
const SysTray = require('systray2').default;
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// Prevent companion process from crashing on unhandled network/socket/FS errors
process.on('uncaughtException', (err) => {
  console.error('[Companion Error] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Companion Error] Unhandled Rejection at:', promise, 'reason:', reason);
});

const app = express();
const client = new WebTorrent();

// Register WebTorrent client error handler to avoid unhandled socket/tracker error bubble-up crashes
client.on('error', (err) => {
  console.error('[WebTorrent Client Error]:', err.message || err);
});

const PORT = 8444;
let ffmpegPathResolved = null;

app.use(cors());

// Dynamic, cross-platform FFmpeg path resolver (supports packaged pkg environment!)
async function getFfmpegPath() {
  if (ffmpegPathResolved) return ffmpegPathResolved;

  // 1. Try to find globally installed ffmpeg
  try {
    const isWindows = process.platform === 'win32';
    const checkCmd = isWindows ? 'where ffmpeg' : 'which ffmpeg';
    const { execSync } = require('child_process');
    const pathFromSystem = execSync(checkCmd, { stdio: [] }).toString().trim().split('\r\n')[0].split('\n')[0];
    if (pathFromSystem && fs.existsSync(pathFromSystem)) {
      console.log(`[FFmpeg] Found globally installed FFmpeg at: ${pathFromSystem}`);
      ffmpegPathResolved = pathFromSystem;
      return ffmpegPathResolved;
    }
  } catch (e) {
    // Not found globally, proceed to bundle fallback
  }

  // 2. Try to use @ffmpeg-installer/ffmpeg package in node_modules
  try {
    const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
    if (ffmpegInstaller && ffmpegInstaller.path && fs.existsSync(ffmpegInstaller.path)) {
      const installerPath = ffmpegInstaller.path;
      
      // Vercel pkg snapshot files are virtual and cannot be executed directly by spawn/exec.
      // We dynamically extract the binary to the OS temp folder for seamless packed runtime execution!
      if (process.pkg) {
        const tempDir = os.tmpdir();
        const binaryName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
        const extractedPath = path.join(tempDir, `movieplay-companion-${binaryName}`);
        
        if (!fs.existsSync(extractedPath)) {
          console.log(`[FFmpeg] Packaged execution detected. Extracting binary to temp: ${extractedPath}`);
          const binaryData = fs.readFileSync(installerPath);
          fs.writeFileSync(extractedPath, binaryData, { mode: 0o755 });
        }
        
        ffmpegPathResolved = extractedPath;
      } else {
        ffmpegPathResolved = installerPath;
      }
      return ffmpegPathResolved;
    }
  } catch (e) {
    console.warn(`[FFmpeg] Dynamic static bundle resolution failed:`, e.message);
  }

  return null;
}

app.get('/status', (req, res) => {
  res.json({ 
    status: 'running', 
    version: '1.1.0',
    transcodingActive: !!ffmpegPathResolved 
  });
});

app.get('/stream', (req, res) => {
  const magnet = req.query.magnet;
  console.log(`[Proxy] Received stream request for: ${magnet ? magnet.substring(0, 40) : 'none'}...`);
  
  if (!magnet) {
    return res.status(400).send('Magnet link required');
  }

  // Check if torrent is already added
  let torrent = client.get(magnet);

  if (torrent) {
    torrent.on('error', (err) => {
      console.error(`[Torrent Error] Error on existing torrent:`, err.message || err);
    });
    
    if (torrent.ready) {
      console.log(`[Proxy] Torrent already exists and is ready. Preparing stream...`);
      handleTorrent(torrent, req, res);
    } else {
      console.log(`[Proxy] Torrent exists but metadata is still fetching. Waiting...`);
      torrent.once('ready', () => {
        console.log(`[Proxy] Torrent metadata fetched for queued request! Name: ${torrent.name}`);
        handleTorrent(torrent, req, res);
      });
    }
  } else {
    console.log(`[Proxy] New torrent requested. Adding to WebTorrent and fetching metadata...`);
    const newTorrent = client.add(magnet, (addedTorrent) => {
      console.log(`[Proxy] Torrent metadata fetched successfully! Name: ${addedTorrent.name}`);
      handleTorrent(addedTorrent, req, res);
    });
    
    newTorrent.on('error', (err) => {
      console.error(`[Torrent Error] Error on newly added torrent:`, err.message || err);
    });
  }
});

function handleTorrent(torrent, req, res) {
  // Find the largest file in the torrent (usually the video)
  let file = torrent.files.reduce((a, b) => (a.length > b.length ? a : b));
  
  if (req.query.fileIdx) {
    const idx = parseInt(req.query.fileIdx, 10);
    if (torrent.files[idx]) {
      file = torrent.files[idx];
      console.log(`[Proxy] Selected specific file index ${idx}: ${file.name}`);
    }
  } else {
    console.log(`[Proxy] Auto-selected largest file: ${file.name} (${(file.length / 1024 / 1024).toFixed(2)} MB)`);
  }

  const total = file.length;
  const isMkv = file.name.toLowerCase().endsWith('.mkv');

  // If file is an MKV and FFmpeg is available, perform on-the-fly container remuxing!
  if (isMkv && ffmpegPathResolved) {
    console.log(`[FFmpeg] MKV container detected! Remuxing stream to fragmented MP4 (0% CPU video copy, AAC audio transcode)...`);

    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept, Range'
    });

    const inputStream = file.createReadStream();
    
    const ffmpegProcess = spawn(ffmpegPathResolved, [
      '-i', 'pipe:0',
      '-c:v', 'copy', // Copy video packets (instant, 0% CPU cost!)
      '-c:a', 'aac',  // Transcode audio to standard web-compatible AAC
      '-b:a', '192k',
      '-f', 'mp4',
      '-movflags', 'frag_keyframe+empty_moov+faststart', // Fragmented playable MP4 output
      'pipe:1'
    ]);

    req.on('close', () => {
      console.log(`[FFmpeg] Connection closed. Stopping stream pipelines.`);
      inputStream.destroy();
      ffmpegProcess.kill('SIGKILL');
    });

    inputStream.on('error', (err) => {
      console.error(`[FFmpeg] WebTorrent stream input error:`, err.message);
      inputStream.destroy();
      ffmpegProcess.kill('SIGKILL');
    });

    ffmpegProcess.on('error', (err) => {
      console.error(`[FFmpeg] Process error:`, err.message);
      inputStream.destroy();
    });

    // Pipe torrent stream through FFmpeg and out to the browser response!
    inputStream.pipe(ffmpegProcess.stdin);
    ffmpegProcess.stdout.pipe(res);

  } else {
    // Standard playback logic for MP4 files or fallback
    if (req.headers.range) {
      const range = req.headers.range;
      const parts = range.replace(/bytes=/, "").split("-");
      const partialstart = parts[0];
      const partialend = parts[1];

      const start = parseInt(partialstart, 10);
      const end = partialend ? parseInt(partialend, 10) : total - 1;
      const chunksize = (end - start) + 1;

      const stream = file.createReadStream({ start: start, end: end });

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'video/mp4',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept, Range'
      });

      req.on('close', () => stream.destroy());
      stream.on('error', (err) => console.log(`[Proxy] Stream error: ${err.message}`));

      stream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': total,
        'Content-Type': 'video/mp4'
      });

      const stream = file.createReadStream();
      req.on('close', () => stream.destroy());
      stream.on('error', (err) => console.log(`[Proxy] Stream error: ${err.message}`));
      stream.pipe(res);
    }
  }
}

app.listen(PORT, () => {
  console.log(`MoviePlay Companion Server running on http://localhost:${PORT}`);
  console.log(`Leave this window open to stream P2P torrents to the MoviePlay web app.`);
  
  // Resolve FFmpeg path asynchronously on startup
  getFfmpegPath().then(resolvedPath => {
    if (resolvedPath) {
      console.log(`[FFmpeg] Active and ready! Automatic on-the-fly MKV-to-MP4 stream remuxing is enabled.`);
    } else {
      console.warn(`[FFmpeg] Warning: FFmpeg could not be found. MKV files will fall back to direct streams.`);
    }
  });

  // Initialize System Tray
  const systray = new SysTray({
    menu: {
      icon: "", // We can leave it blank for default or add a base64 icon later
      title: "MoviePlay",
      tooltip: "MoviePlay Companion",
      items: [
        {
          title: "Proxy Running (Port 8444)",
          tooltip: "The torrent proxy is active",
          checked: true,
          enabled: false
        },
        {
          title: "Exit",
          tooltip: "Close the companion app",
          checked: false,
          enabled: true
        }
      ]
    },
    debug: false,
    copyDir: true // copies the binary to a temp dir so pkg can run it
  });

  systray.onClick(action => {
    if (action.item.title === "Exit") {
      systray.kill();
      process.exit(0);
    }
  });

  systray.ready().then(() => {
    console.log('[SysTray] Started successfully');
  }).catch(err => {
    console.log('[SysTray] Failed to start:', err);
  });
});
