const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
let jitiModule;
try { jitiModule = require('jiti'); } catch {
  const root = path.join(os.homedir(), '.pi/agent/install');
  const version = fs.readFileSync(path.join(root, 'current-version'), 'utf8').trim();
  jitiModule = require(path.join(root, 'releases', version, 'node_modules/jiti/lib/jiti.cjs'));
}
const jiti = jitiModule.createJiti(__filename);
test('rate-limit errors and network errors remain distinct, without exposing request secrets', async () => {
  const { rateLimitError, formatOpenCodeError } = await jiti.import('../errors.ts');
  assert.match(formatOpenCodeError({ data: { statusCode: 429, message: 'Slow down' } }).message, /rate limit.*HTTP 429/i);
  assert.match(formatOpenCodeError({ responseBody: JSON.stringify({ error: { message: 'Rate limit exceeded' } }) }).message, /rate limit/i);
  const limited = rateLimitError('Rate limit exceeded', Date.now() + 30000);
  assert.match(formatOpenCodeError(limited).message, /retry in about.*seconds/i);
  assert.equal(rateLimitError('Temporary upstream outage'), undefined);
  const timeout = formatOpenCodeError(new TypeError('fetch failed', { cause: Object.assign(new Error('Headers Timeout'), { code: 'UND_ERR_HEADERS_TIMEOUT' }) }));
  assert.match(timeout.message, /timed out waiting for response headers.*UND_ERR_HEADERS_TIMEOUT/);
  assert(!timeout.message.startsWith('OpenCode upstream rate limit'));
  assert.match(formatOpenCodeError(new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })).message, /Cannot connect/);
  assert(!formatOpenCodeError({ message: 'failed', request: { authorization: 'SECRET_DO_NOT_PRINT' } }).message.includes('SECRET_DO_NOT_PRINT'));
  assert(!formatOpenCodeError(new Error('Bearer SECRET_DO_NOT_PRINT')).message.includes('SECRET_DO_NOT_PRINT'));
});

test('HTTP, SSE retry/session errors and final response surface limits promptly', async () => {
  const serverPath = path.join(__dirname, '../server.ts');
  const code = jiti.transform({ source: fs.readFileSync(serverPath, 'utf8'), filename: serverPath, ts: true });
  const errors = await jiti.import('../errors.ts');
  const module = { exports: {} };
  const mockedRequire = id => id === 'node:child_process' ? require('./fixtures/child-process.cjs') : id === './errors' ? errors : require(id);
  new Function('require', 'module', 'exports', code)(mockedRequire, module, module.exports);
  const { runOpenCode } = module.exports;
  const previous = process.env.PI_FAKE_CASE;
  try {
    for (const scenario of ['retry', 'sessionError', 'http429', 'finalError']) {
      process.env.PI_FAKE_CASE = scenario;
      const start = Date.now();
      await assert.rejects(runOpenCode({}, () => {}, AbortSignal.timeout(10000)), /OpenCode upstream rate limit/);
      assert(Date.now() - start < 8000, `limit should surface before HTTP timeout: ${scenario}`);
    }
    process.env.PI_FAKE_CASE = 'otherRetry';
    assert.deepEqual(await runOpenCode({}, () => {}, AbortSignal.timeout(10000)), { info: {}, parts: [] });
  } finally {
    if (previous === undefined) delete process.env.PI_FAKE_CASE;
    else process.env.PI_FAKE_CASE = previous;
  }
});
