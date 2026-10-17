const http = require('node:http');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
let events;
const emit = (type, properties) => events.write(`data: ${JSON.stringify({ type, properties })}\n\n`);
http.createServer((req, res) => {
  const json = body => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
  if (req.url === '/global/health') return json({ healthy: true });
  if (req.url === '/session' && req.method === 'POST') return json({ id: 'ses_test' });
  if (req.url === '/event') {
    events = res;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"server.connected","properties":{}}\n\n');
    return;
  }
  if (req.url === '/session/ses_test/message' && req.method === 'POST') {
    req.resume();
    req.on('end', () => {
      const scenario = process.env.PI_FAKE_CASE;
      if (scenario === 'http429') { res.statusCode = 429; return json({ error: { message: 'Too many requests' } }); }
      if (scenario === 'sessionError') { emit('session.error', { sessionID: 'ses_test', error: { name: 'APIError', data: { statusCode: 429, message: 'Rate limit exceeded' } } }); return; }
      if (scenario === 'finalError') return json({ info: { error: { data: { statusCode: 429, message: 'Rate limit exceeded' } } } });
      if (scenario === 'retry') { emit('session.status', { sessionID: 'ses_test', status: { type: 'retry', attempt: 1, message: 'Rate limit exceeded. Please try again later.', next: Date.now() + 30000 } }); return; }
      // Retry errors unrelated to rate limits must not terminate successful requests.
      emit('session.status', { sessionID: 'ses_test', status: { type: 'retry', attempt: 1, message: 'Temporary upstream outage', next: Date.now() } });
      return json({ info: {}, parts: [] });
    });
    return;
  }
  json(true);
}).listen(port, '127.0.0.1');
