const { networkInterfaces } = require('node:os');

const DEFAULT_PORT = 5500;

function getIp(networks = networkInterfaces()) {
  for (const addresses of Object.values(networks)) {
    for (const address of addresses || []) {
      const isIpv4 = address.family === 'IPv4' || address.family === 4;
      if (isIpv4 && !address.internal) return address.address;
    }
  }

  return '127.0.0.1';
}

async function getNetwork() {
  return { ip: getIp(), port: DEFAULT_PORT };
}

module.exports = getNetwork;
module.exports.DEFAULT_PORT = DEFAULT_PORT;
module.exports.getIp = getIp;
