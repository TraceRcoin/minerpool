'use strict';
var fs = require('fs');
var conf = fs.readFileSync('/root/.tracercoin/tracercoin.conf','utf8');
var m = conf.match(/rpcpassword=(.+)/);
if (!m){ console.error('rpcpassword not found'); process.exit(1); }
var pw = m[1].trim();
var user = (conf.match(/rpcuser=(.+)/)||[])[1].trim();
var cfg = {
  coin: { name:'tracercoin', symbol:'TFX-test', algorithm:'scrypt', peerMagic:'544658f1', reward:'POW', txMessages:false },
  address: 'ttfx1q5p2uxxc6hswef9k9s0dhjcghqtqj7arum9dhln',
  rewardRecipients: { 'ttfx1q04pmcsqt0jdtc5lqhd4a3z8ez4cnc4mmhdgf5m': 2.0 },
  blockRefreshInterval: 1000,
  jobRebroadcastTimeout: 55,
  connectionTimeout: 600,
  emitInvalidBlockHashes: false,
  tcpProxyProtocol: false,
  banning: { enabled:false },
  ports: {
    '3032': { diff: 0.1,  varDiff: { minDiff:0.05, maxDiff:16,   targetTime:15, retargetTime:60, variancePercent:30 } },
    '3333': { diff: 8,    varDiff: { minDiff:1,    maxDiff:8192, targetTime:15, retargetTime:90, variancePercent:30 } }
  },
  daemons: [ { host:'127.0.0.1', port:19556, user:user, password:pw } ],
  p2p: { enabled:false }
};
fs.writeFileSync('/opt/tfxpool/pool_config.json', JSON.stringify(cfg,null,2), { mode:0o600 });
console.log('pool_config.json written (rpcpassword injected, not printed)');
