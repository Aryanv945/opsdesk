// Runs the API (with file watching) and the Vite dev server together.
// Vite proxies /api to the API, so open http://localhost:5173.
const { spawn } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const procs = [
  spawn(npm, ['--prefix', 'server', 'run', 'dev'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' }),
  spawn(npm, ['--prefix', 'client', 'run', 'dev'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' }),
];
const stop = () => { for (const p of procs) p.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => { if (code) stop(); });
