const express = require('express');
const cors = require('cors');
const WebTorrent = require('webtorrent');

const app = express();
const client = new WebTorrent();

const PORT = 8444;

app.use(cors());

app.get('/status', (req, res) => {
  res.json({ status: 'running', version: '1.0.0' });
});

app.get('/stream', (req, res) => {
  const magnet = req.query.magnet;
  if (!magnet) {
    return res.status(400).send('Magnet link required');
  }

  // Check if torrent is already added
  let torrent = client.get(magnet);

  if (torrent) {
    handleTorrent(torrent, req, res);
  } else {
    client.add(magnet, (newTorrent) => {
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
    }
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
      'Content-Type': 'video/mp4' // Generic, could be improved
    });

    stream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': total,
      'Content-Type': 'video/mp4'
    });

    const stream = file.createReadStream();
    stream.pipe(res);
  }
}

app.listen(PORT, () => {
  console.log(`MoviePlay Companion Server running on http://localhost:${PORT}`);
  console.log(`Leave this window open to stream P2P torrents to the MoviePlay web app.`);
});
