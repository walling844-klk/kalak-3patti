'use strict';

const http = require('node:http');

const values = new Map();
const server = http.createServer((request, response) => {
  if (request.method !== 'POST') { response.writeHead(405); return response.end(); }
  let body = '';
  request.on('data', chunk => { body += chunk; if (body.length > 1024 * 1024) request.destroy(); });
  request.on('end', () => {
    try {
      const command = JSON.parse(body);
      const operation = String(command[0] || '').toUpperCase();
      const key = command[1];
      let result = null;
      if (operation === 'GET') result = values.get(key) ?? null;
      else if (operation === 'SET') { values.set(key, String(command[2])); result = 'OK'; }
      else if (operation === 'DEL') { result = values.delete(key) ? 1 : 0; }
      else { response.writeHead(400, { 'content-type': 'application/json' }); return response.end(JSON.stringify({ error: 'unsupported command' })); }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ result }));
    } catch (_) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'invalid command' }));
    }
  });
});

if (require.main === module) {
  const port = Number(process.env.FAKE_UPSTASH_PORT || 6380);
  server.listen(port, '127.0.0.1', () => console.log(`Fake Upstash REST listening on http://127.0.0.1:${port}`));
}

module.exports = { server, values };
