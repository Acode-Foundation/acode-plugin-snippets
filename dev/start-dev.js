const { fork } = require('node:child_process');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');

function childOptions() {
  return {
    cwd: projectRoot,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  };
}

function main({
  forkProcess = fork,
  logger = console,
  runtime = process,
} = {}) {
  logger.log('Starting snippets plugin development server.');

  const activeChildren = new Map();
  let server;
  let stopping = false;

  const stop = (signal, exitCode) => {
    if (stopping) return;
    stopping = true;
    runtime.exitCode = exitCode;
    for (const child of activeChildren.keys()) {
      if (!child.killed) child.kill(signal);
    }
  };
  const fail = (message, exitCode = 1) => {
    if (!stopping) logger.error(message);
    stop('SIGTERM', exitCode || 1);
  };
  const registerChild = (child, name) => {
    activeChildren.set(child, name);
    child.once('error', (error) => {
      fail(`${name} failed: ${error.message}`);
    });
    child.once('exit', (code, signal) => {
      activeChildren.delete(child);
      if (!stopping) {
        const reason = signal ? `signal ${signal}` : `exit code ${code}`;
        fail(`${name} exited unexpectedly with ${reason}.`, code);
      }
    });
    return child;
  };
  const startServer = () => {
    if (server || stopping) return;
    server = registerChild(
      forkProcess(
        path.resolve(__dirname, 'start-server.js'),
        [],
        childOptions(),
      ),
      'Plugin server',
    );
  };

  runtime.once('SIGINT', () => stop('SIGINT', 130));
  runtime.once('SIGTERM', () => stop('SIGTERM', 143));

  const watcher = registerChild(
    forkProcess(
      path.resolve(__dirname, 'run-webpack.js'),
      [],
      childOptions(),
    ),
    'Webpack watcher',
  );
  watcher.on('message', (message) => {
    if (message?.type !== 'compilation') return;
    if (message.status === 'success') startServer();
    if (message.status === 'fatal') fail('Webpack watcher failed.');
  });

  return {
    shutdown: () => stop('SIGTERM', 0),
  };
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

module.exports = { childOptions, main };
