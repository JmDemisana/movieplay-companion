const express = require('express');
const cors = require('cors');
const WebTorrent = require('webtorrent');
const SysTray = require('systray2').default;

const app = express();
const client = new WebTorrent();

const PORT = 8444;

app.use(cors());

app.get('/status', (req, res) => {
  res.json({ status: 'running', version: '1.0.0' });
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
    client.add(magnet, (newTorrent) => {
      console.log(`[Proxy] Torrent metadata fetched successfully! Name: ${newTorrent.name}`);
      handleTorrent(newTorrent, req, res);
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

app.listen(PORT, () => {
  console.log(`MoviePlay Companion Server running on http://localhost:${PORT}`);
  console.log(`Leave this window open to stream P2P torrents to the MoviePlay web app.`);
  
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
