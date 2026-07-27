'use strict';
var fs = require('fs');
var cp = require('child_process');
var Stratum = require('/opt/tfxpool/engine/lib/index.js');
var bridge = require('/opt/tfxpool/portal_bridge.js');
var cfg = JSON.parse(fs.readFileSync('/opt/tfxpool/pool_config.json','utf8'));

function ts(){ return new Date().toISOString(); }
function log(){ process.stdout.write(ts()+' '+[].slice.call(arguments).join(' ')+'\n'); }
function redis(){ try { cp.execFile('redis-cli', [].slice.call(arguments), function(){}); } catch(e){} }

// PORTAL-INTEGRATED auth: every rig login is verified against the miner portal's
// /api/portal/worker-auth (shared X-Pool-Token). Anonymous logins are rejected.
// On success the resolved account + payout address is cached so shares/blocks are
// credited to the right miner.
var authorizeFn = function(ip, port, workerName, password, cb){
  bridge.workerAuth(workerName, password, function(err, info){
    if (err || !info){
      log('AUTH REJECTED ip='+ip+' worker='+workerName+' reason='+(err ? err.message : 'unknown'));
      redis('hincrby','tfxpool:auth','rejected',1);
      cb({ error: null, authorized: false, disconnect: false });
      return;
    }
    log('AUTH OK ip='+ip+' port='+port+' worker='+workerName+' account='+info.username+' payout='+info.payout_address);
    redis('hincrby','tfxpool:auth','count',1);
    cb({ error: null, authorized: true, disconnect: false });
  });
};

var pool = Stratum.createPool(cfg, authorizeFn);
pool.on('share', function(isValidShare, isValidBlock, data){
  if (isValidBlock){
    log('*** BLOCK FOUND *** height='+data.height+' blockHash='+data.blockHash+' worker='+data.worker+' rewardSat='+data.blockReward);
    redis('rpush','tfxpool:blocks', JSON.stringify({t:ts(),height:data.height,hash:data.blockHash,worker:data.worker}));
    try { bridge.recordShare(data.worker, data.shareDiff); } catch(e){ log('bridge.recordShare(block) err '+e.message); }
    try { bridge.recordBlock(data.height, data.blockHash, data.worker, data.blockReward); }
    catch(e){ log('bridge.recordBlock err '+e.message); }
  } else if (isValidShare){
    log('share ACCEPTED worker='+data.worker+' diff='+data.difficulty+' shareDiff='+data.shareDiff);
    redis('incr','tfxpool:shares:accepted');
    try { bridge.recordShare(data.worker, data.shareDiff); } catch(e){ log('bridge.recordShare err '+e.message); }
  } else {
    log('share REJECTED worker='+(data.worker||'?')+' err='+JSON.stringify(data.error));
    redis('incr','tfxpool:shares:rejected');
    try { bridge.recordStale(data.worker); } catch(e){}
  }
});
pool.on('log', function(sev, text){ log('['+sev+'] '+text); });
pool.on('difficultyUpdate', function(worker, diff){ log('vardiff worker='+worker+' newDiff='+diff); });
pool.on('started', function(){ log('POOL STARTED'); });
pool.start();
log('init.js launched (portal-integrated auth + stats writer)');
