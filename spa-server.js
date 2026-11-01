// Spa Massage Online — máy chủ tĩnh tối giản (Node thuần, không phụ thuộc gói ngoài)
// Phục vụ trang spa-massage-online.html tại "/" và đường dẫn phát sóng "/phong-live.html" -> "/?live=1"
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PAGE = path.join(__dirname, 'spa-massage-online.html');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }
  if (url.pathname === '/phong-live.html') {
    res.writeHead(302, { Location: '/?live=1' });
    res.end();
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    fs.readFile(PAGE, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('spa page missing');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

server.listen(PORT, () => console.log('spa server listening on ' + PORT));
