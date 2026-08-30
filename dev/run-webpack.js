const webpack = require('webpack');
const createWebpackConfig = require('../webpack.config');

function runWebpack({
  configFactory = createWebpackConfig,
  createCompiler = (config) => webpack(config),
  logger = console,
  runtime = process,
} = {}) {
  const compiler = createCompiler(configFactory({}, { mode: 'development' }));
  let closing = false;
  let watching;

  const send = (message) => runtime.send?.(message);
  const close = (exitCode = 0) => {
    if (closing) return;
    closing = true;
    if (!watching) {
      runtime.exitCode = exitCode;
      return;
    }
    watching.close((error) => {
      if (error) logger.error(error);
      runtime.exitCode = error ? 1 : exitCode;
    });
  };

  watching = compiler.watch({}, (error, stats) => {
    if (error || !stats) {
      logger.error(error || new Error('Webpack returned no compilation stats.'));
      send({ status: 'fatal', type: 'compilation' });
      queueMicrotask(() => close(1));
      return;
    }

    const output = stats.toString({ colors: Boolean(process.stdout.isTTY) });
    if (output) logger.log(output);
    send({
      status: stats.hasErrors() ? 'errors' : 'success',
      type: 'compilation',
    });
  });

  runtime.once('SIGINT', () => close(130));
  runtime.once('SIGTERM', () => close(143));
  return { close, watching };
}

if (require.main === module) {
  try {
    runWebpack();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

module.exports = { runWebpack };
