const path = require('node:path');
const { packZip } = require('./dev/pack-zip');

function createPackZipPlugin(pack = packZip, logger = console) {
  return {
    apply(compiler) {
      compiler.hooks.done.tapPromise('pack-zip', async (stats) => {
        if (stats.hasErrors()) return;
        const outputFile = await pack();
        logger.log(`${path.basename(outputFile)} written.`);
      });
    },
  };
}

function createWebpackConfig(_environment, options) {
  const { mode = 'development' } = options;

  return [{
    mode,
    entry: {
      main: './src/main.js',
    },
    output: {
      path: path.resolve(__dirname, 'dist'),
    },
    module: {
      rules: [
        {
          test: /\.(js|jsx)$/i,
          loader: 'babel-loader',
        },
      ],
    },
    plugins: [createPackZipPlugin()],
  }];
}

module.exports = createWebpackConfig;
module.exports.createPackZipPlugin = createPackZipPlugin;
