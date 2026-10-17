const childProcess = require('child_process');
const path = require('node:path');
exports.spawn = (_binary, args, options) => childProcess.spawn(process.execPath, [path.join(__dirname, 'fake-server.cjs'), ...args], options);
exports.execFile = childProcess.execFile;
