const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const JSZip = require('jszip');

const { getIp } = require('../dev/get-network');
const { packZip } = require('../dev/pack-zip');
const { runWebpack } = require('../dev/run-webpack');
const {
  closeServer,
  startServer,
} = require('../dev/start-server');
const { main: startDevelopment } = require('../dev/start-dev');
const { createPackZipPlugin } = require('../webpack.config');

test('network discovery supports generic interfaces and localhost fallback', () => {
  assert.equal(getIp({
    en1: [
      { address: 'fe80::1', family: 'IPv6', internal: false },
      { address: '192.168.0.105', family: 'IPv4', internal: false },
    ],
  }), '192.168.0.105');
  assert.equal(getIp({
    eth0: [{ address: '10.0.0.8', family: 4, internal: false }],
  }), '10.0.0.8');
  assert.equal(getIp({
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  }), '127.0.0.1');
});

test('ZIP packaging replaces completed archives without partial files', async (context) => {
  const rootDir = await createPluginFixture();
  context.after(() => fs.promises.rm(rootDir, { recursive: true, force: true }));

  const outputFile = await packZip({ rootDir });
  const firstArchive = await fs.promises.readFile(outputFile);
  assert.equal(await readArchiveFile(firstArchive, 'main.js'), 'version one');
  assert.equal(await readArchiveFile(firstArchive, 'nested/module.js'), 'nested');
  assert.equal(
    await readArchiveFile(firstArchive, 'snippets/example.snippets'),
    'canonical snippet',
  );
  assert.equal(
    (await JSZip.loadAsync(firstArchive)).file('snippets/stale-only.snippets'),
    null,
  );

  await fs.promises.writeFile(path.join(rootDir, 'dist/main.js'), 'version two');
  await packZip({ rootDir });
  const secondArchive = await fs.promises.readFile(outputFile);
  assert.equal(await readArchiveFile(secondArchive, 'main.js'), 'version two');
  assert.notDeepEqual(secondArchive, firstArchive);
  assert.deepEqual(
    (await fs.promises.readdir(rootDir)).filter((name) => name.endsWith('.tmp')),
    [],
  );

  await fs.promises.rename(
    path.join(rootDir, 'dist'),
    path.join(rootDir, 'missing-dist'),
  );
  await assert.rejects(packZip({ rootDir }));
  assert.deepEqual(await fs.promises.readFile(outputFile), secondArchive);
});

test('HTTP development server serves the current archive without caching', async (context) => {
  const rootDir = await createPluginFixture();
  context.after(() => fs.promises.rm(rootDir, { recursive: true, force: true }));
  await packZip({ rootDir });

  const server = await startServer({
    host: '127.0.0.1',
    port: 0,
    rootDir,
  });
  context.after(() => closeServer(server));

  const archive = await request(server, '/dist.zip');
  assert.equal(archive.statusCode, 200);
  assert.equal(archive.headers['access-control-allow-origin'], '*');
  assert.equal(
    archive.headers['cache-control'],
    'no-store, no-cache, must-revalidate',
  );
  assert.equal(await readArchiveFile(archive.body, 'main.js'), 'version one');

  const missing = await request(server, '/missing.zip');
  assert.equal(missing.statusCode, 404);

  const preflight = await request(server, '/dist.zip', { method: 'OPTIONS' });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], '*');
});

test('webpack packaging hook waits for ZIP completion and skips failed builds', async () => {
  let hook;
  let releasePack;
  let packCalls = 0;
  const output = [];
  const packFinished = new Promise((resolve) => {
    releasePack = resolve;
  });
  const plugin = createPackZipPlugin(async () => {
    packCalls += 1;
    await packFinished;
    return '/plugin/dist.zip';
  }, { log: (message) => output.push(message) });
  plugin.apply({
    hooks: {
      done: {
        tapPromise(name, callback) {
          assert.equal(name, 'pack-zip');
          hook = callback;
        },
      },
    },
  });

  const pending = hook({ hasErrors: () => false });
  await Promise.resolve();
  assert.equal(packCalls, 1);
  assert.deepEqual(output, []);
  releasePack();
  await pending;
  assert.deepEqual(output, ['dist.zip written.']);

  await hook({ hasErrors: () => true });
  assert.equal(packCalls, 1);
});

test('webpack watcher reports structured results and closes cleanly', async () => {
  const messages = [];
  const output = [];
  const runtime = new EventEmitter();
  runtime.send = (message) => messages.push(message);
  let compile;
  let closeCalls = 0;
  runWebpack({
    configFactory: (_environment, options) => ({ mode: options.mode }),
    createCompiler(config) {
      assert.deepEqual(config, { mode: 'development' });
      return {
        watch(_options, callback) {
          compile = callback;
          return {
            close(done) {
              closeCalls += 1;
              done();
            },
          };
        },
      };
    },
    logger: {
      error: (value) => output.push(String(value)),
      log: (value) => output.push(value),
    },
    runtime,
  });

  compile(null, compilationStats(false));
  compile(null, compilationStats(true));
  assert.deepEqual(messages, [
    { status: 'success', type: 'compilation' },
    { status: 'errors', type: 'compilation' },
  ]);
  assert.deepEqual(output, ['compiled successfully', 'compiled with errors']);

  runtime.emit('SIGTERM');
  assert.equal(closeCalls, 1);
  assert.equal(runtime.exitCode, 143);
});

test('development supervisor starts once and propagates child failures', () => {
  const runtime = new EventEmitter();
  const children = [];
  const errors = [];
  startDevelopment({
    forkProcess(modulePath) {
      const child = new FakeChild(modulePath);
      children.push(child);
      return child;
    },
    logger: {
      error: (message) => errors.push(message),
      log() {},
    },
    runtime,
  });

  const watcher = children[0];
  watcher.emit('message', { status: 'errors', type: 'compilation' });
  assert.equal(children.length, 1);
  watcher.emit('message', { status: 'success', type: 'compilation' });
  watcher.emit('message', { status: 'success', type: 'compilation' });
  assert.equal(children.length, 2);

  const server = children[1];
  server.emit('error', new Error('port unavailable'));
  assert.equal(runtime.exitCode, 1);
  assert.equal(watcher.killed, true);
  assert.equal(watcher.signal, 'SIGTERM');
  assert.match(errors[0], /Plugin server failed: port unavailable/);
});

test('development supervisor terminates its watcher on Ctrl+C', () => {
  const runtime = new EventEmitter();
  let watcher;
  startDevelopment({
    forkProcess(modulePath) {
      watcher = new FakeChild(modulePath);
      return watcher;
    },
    logger: { error() {}, log() {} },
    runtime,
  });

  runtime.emit('SIGINT');
  assert.equal(runtime.exitCode, 130);
  assert.equal(watcher.killed, true);
  assert.equal(watcher.signal, 'SIGINT');
});

function compilationStats(hasErrors) {
  return {
    hasErrors: () => hasErrors,
    toString: () => (hasErrors ? 'compiled with errors' : 'compiled successfully'),
  };
}

class FakeChild extends EventEmitter {
  constructor(modulePath) {
    super();
    this.killed = false;
    this.modulePath = modulePath;
    this.signal = null;
  }

  kill(signal) {
    this.killed = true;
    this.signal = signal;
    return true;
  }
}

async function createPluginFixture() {
  const rootDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'acode-snippets-dev-'),
  );
  await fs.promises.mkdir(path.join(rootDir, 'dist/nested'), {
    recursive: true,
  });
  await fs.promises.mkdir(path.join(rootDir, 'dist/snippets'), {
    recursive: true,
  });
  await fs.promises.mkdir(path.join(rootDir, 'snippets'), {
    recursive: true,
  });
  await Promise.all([
    fs.promises.writeFile(path.join(rootDir, 'icon.png'), 'icon'),
    fs.promises.writeFile(path.join(rootDir, 'plugin.json'), '{"name":"test"}'),
    fs.promises.writeFile(path.join(rootDir, 'readme.md'), '# Test'),
    fs.promises.writeFile(path.join(rootDir, 'dist/main.js'), 'version one'),
    fs.promises.writeFile(path.join(rootDir, 'dist/nested/module.js'), 'nested'),
    fs.promises.writeFile(
      path.join(rootDir, 'dist/snippets/example.snippets'),
      'stale generated snippet',
    ),
    fs.promises.writeFile(
      path.join(rootDir, 'dist/snippets/stale-only.snippets'),
      'stale only',
    ),
    fs.promises.writeFile(
      path.join(rootDir, 'snippets/example.snippets'),
      'canonical snippet',
    ),
  ]);
  return rootDir;
}

async function readArchiveFile(archive, filename) {
  const zip = await JSZip.loadAsync(archive);
  return zip.file(filename).async('string');
}

function request(server, pathname, options = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      host: '127.0.0.1',
      method: options.method || 'GET',
      path: pathname,
      port,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        body: Buffer.concat(chunks),
        headers: response.headers,
        statusCode: response.statusCode,
      }));
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}
