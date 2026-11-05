/**
 * ExpireGuard — Local HTTP Server
 * Run: node server.js
 * Then open: http://localhost:3000
 *
 * Service Workers REQUIRE http:// or https:// — they are blocked on file://
 * This tiny server lets you use background notifications locally.
 */
const http = require('http');
const fs   = require('fs');
const path = require('path');
const PORT = 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js'  : 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css' : 'text/css; charset=utf-8',
  '.png' : 'image/png',
  '.ico' : 'image/x-icon',
  '.svg' : 'image/svg+xml',
  '.webp': 'image/webp',
};

const server = http.createServer((req, res) => {
  // Resolve path — default to expiry_alert.html
  let filePath = '.' + req.url.split('?')[0];
  if (filePath === './' || filePath === '.') filePath = './expiry_alert.html';

  const ext  = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const abs  = path.resolve(__dirname, filePath);

  fs.readFile(abs, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404); res.end('404 Not Found: ' + filePath);
      } else {
        res.writeHead(500); res.end('500 Server Error');
      }
      return;
    }

    // Headers that help with PWA / Service Worker
    res.writeHead(200, {
      'Content-Type'           : mime,
      'Service-Worker-Allowed' : '/',
      'Cache-Control'          : 'no-cache, no-store, must-revalidate',
    });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  ╔════════════════════════════════════════════╗');
  console.log('  ║   ExpireGuard — Background Notification Server  ║');
  console.log('  ╠════════════════════════════════════════════╣');
  console.log(`  ║  Open:  http://localhost:${PORT}                     ║`);
  console.log('  ║  Press Ctrl+C to stop                           ║');
  console.log('  ╚════════════════════════════════════════════╝');
  console.log('');
  console.log('  ✅ sw.js registered — notifications fire even when the tab is closed.');
  console.log('  ✅ Background notifications are fully enabled.');
  console.log('  ⚠️  Keep this terminal open to keep the server running.');
  console.log('');
});
