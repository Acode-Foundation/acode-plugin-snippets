const path = require('node:path');
const liveServer = require('live-server');
const getNetwork = require('./get-network');

const projectRoot = path.resolve(__dirname, '..');

function createServerOptions({ host, port, rootDir = projectRoot } = {}) {
  return {
    host,
    ignore: ['node_modules'],
    logLevel: 0,
    middleware: [(request, response, next) => {
      response.setHeader('Access-Control-Allow-Headers', '*');
      response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      response.setHeader('Expires', '0');
      response.setHeader('Pragma', 'no-cache');
      if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
        return;
      }
      next();
    }],
    open: false,
    port,
    root: rootDir,
  };
}

function startServer({
  host,
  port,
  rootDir = projectRoot,
  serverApi = liveServer,
} = {}) {
  const server = serverApi.start(createServerOptions({ host, port, rootDir }));

  return new Promise((resolve, reject) => {
    const onError = (error) => {
      if (error.code === 'EADDRINUSE') return;
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server);
    };

    server.once('error', onError);
    server.once('listening', onListening);
  });
}

async function closeServer(server, serverApi = liveServer) {
  await Promise.resolve(serverApi.watcher?.close?.());
  if (server?.listening) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  if (serverApi.server === server) serverApi.server = null;
}

async function main({ logger = console, runtime = process } = {}) {
  const { ip: host, port } = await getNetwork();
  const server = await startServer({ host, port });
  const address = server.address();
  const url = `http://${host}:${address.port}/dist.zip`;
  logger.log(`Plugin archive available at ${url}`);
  runtime.send?.({ status: 'ready', type: 'server', url });

  let closing = false;
  const shutdown = async (exitCode) => {
    if (closing) return;
    closing = true;
    try {
      await closeServer(server);
    } catch (error) {
      logger.error(error);
      runtime.exitCode = 1;
      return;
    }
    runtime.exitCode = exitCode;
  };

  runtime.once('SIGINT', () => void shutdown(130));
  runtime.once('SIGTERM', () => void shutdown(143));
  return { server, shutdown, url };
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  closeServer,
  createServerOptions,
  main,
  startServer,
};
