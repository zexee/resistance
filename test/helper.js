const { spawn } = require('child_process');
const path = require('path');

const running = [];
process.on('exit', () => {
  for (const proc of running) {
    try { proc.kill(); } catch (e) {}
  }
});

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: Object.assign({}, process.env, { PORT: '0' }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    running.push(proc);
    let out = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('server did not start:\n' + out));
    }, 5000);
    proc.stdout.on('data', chunk => {
      out += String(chunk);
      const match = out.match(/listening at .*:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve({ proc: proc, port: Number(match[1]) });
      }
    });
    proc.stderr.on('data', chunk => process.stderr.write(chunk));
    proc.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function stopServer(server) {
  return new Promise(resolve => {
    server.proc.once('exit', resolve);
    server.proc.kill();
    setTimeout(resolve, 1000);
  });
}

module.exports = { startServer, stopServer };
