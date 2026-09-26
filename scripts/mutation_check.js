/**
 * scripts/mutation_check.js
 * Proves the security regression suite actually guards each fix in SECURITY_FIXES.md.
 * For every mutation it re-introduces the original bug into the contracts, recompiles, runs
 * test/security_regressions.test.js and expects the matching [SEC-xx] checks to FAIL.
 * The contract is always restored and recompiled afterwards.
 *
 * Run: npm run test:mutation
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = {
  amm: path.join(rootDir, 'contracts', 'MonadUpDownAMM.sol'),
  oracle: path.join(rootDir, 'contracts', 'SignedPriceOracle.sol')
};
const originals = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, fs.readFileSync(f, 'utf8')]));

const MUTATIONS = [
  {
    id: 'SEC-28',
    name: 'Settle on a late report at once, with no challenge period',
    from: '        if (block.timestamp >= round.finalizeAfter) return true;',
    to: '        return true;',
    expect: ['SEC-28', 'SEC-02']
  },
  {
    id: 'SEC-28 (replace)',
    name: 'Let a later report replace the current lock report',
    from: 'require(publishTime < round.lockPublishTime, "Not earlier than the current lock report");',
    to: '',
    expect: ['SEC-28']
  },
  {
    id: 'SEC-29',
    name: 'Allow settling a round that is already refundable',
    from: '        require(block.timestamp >= round.closeTimestamp, "Close time not reached");\n        require(block.timestamp <= round.expiryTimestamp, "Round expired: refundable");',
    to: '        require(block.timestamp >= round.closeTimestamp, "Close time not reached");',
    expect: ['SEC-29']
  },
  {
    id: 'SEC-29 (snapshot)',
    name: 'Read the live emergencyTimeout instead of the per-round expiry',
    from: '(round.status == RoundStatus.Open || round.status == RoundStatus.Locked) && block.timestamp > round.expiryTimestamp',
    to: '(round.status == RoundStatus.Open || round.status == RoundStatus.Locked) && block.timestamp > round.closeTimestamp + emergencyTimeout',
    expect: ['SEC-29']
  },
  {
    id: 'SEC-01/02',
    name: 'Accept reports from any time within +/-60s instead of the pinned timestamp',
    file: 'oracle',
    from: 'require(r.timestampMs == timestampMs, "Report not at pinned timestamp");',
    to: 'require(r.timestampMs + 60000 >= timestampMs && r.timestampMs <= timestampMs + 60000, "Report not at pinned timestamp");',
    expect: ['SEC-02']
  },
  {
    id: 'SEC-01/28 (window)',
    name: 'Accept any report time up to 2 minutes around the pinned mark',
    from: 'require(publishTime >= first && publishTime <= first + round.maxReportDelay, "Report not at pinned timestamp");',
    to: 'require(publishTime + 120 >= first && publishTime <= first + 120, "Report not at pinned timestamp");',
    expect: ['SEC-01', 'SEC-02']
  },
  {
    id: 'SEC-02 (signers)',
    name: 'Accept any 3 signatures, letting the keeper choose which nodes form the median',
    file: 'oracle',
    from: 'require(n >= signerThreshold, "Not enough oracle signatures");',
    to: 'require(n >= 3, "Not enough oracle signatures");',
    expect: ['SEC-02']
  },
  {
    id: 'SEC-22',
    name: 'Apply an oracle signer change without the timelock',
    file: 'oracle',
    from: 'require(block.timestamp >= _proposal.eta, "Signer change still timelocked");',
    to: '',
    expect: ['SEC-22']
  },
  {
    id: 'SEC-21',
    name: 'Old 2-hour emergency timeout',
    from: 'uint256 public emergencyTimeout = 10 minutes;',
    to: 'uint256 public emergencyTimeout = 2 hours;',
    expect: ['SEC-21']
  },
  {
    id: 'SEC-24',
    name: 'Replace any expired round on a late bet, even a contested one',
    from: '            (round.totalUp == 0 || round.totalDown == 0) &&\n',
    to: '',
    expect: ['SEC-24']
  },
  {
    id: 'SEC-26',
    name: 'One-sided rounds refundable only after someone cancels them',
    from: 'if (round.status == RoundStatus.Open && block.timestamp > round.betCloseTimestamp && (round.totalUp == 0 || round.totalDown == 0)) {\n            return true;\n        }',
    to: '',
    expect: ['SEC-26']
  },
  {
    id: 'SEC-03',
    name: 'Push keeper bounty to the locker with an unbounded call',
    from: 'keeperRewards[locker] += split;',
    to: '(bool s1, ) = payable(locker).call{value: split}(""); if (!s1) treasuryFees[marketId] += split;',
    expect: ['SEC-03']
  },
  {
    id: 'SEC-05',
    name: 'Use the live lockBufferSeconds instead of the per-round snapshot',
    from: 'block.timestamp <= round.betCloseTimestamp,',
    to: 'block.timestamp <= round.lockTimestamp - lockBufferSeconds,',
    extra: [['round.betCloseTimestamp = uint40(lock - buffer);', 'round.betCloseTimestamp = uint40(lock - lockBufferSeconds);']],
    expect: ['SEC-05']
  },
  {
    id: 'SEC-06',
    name: 'Remove the pause check on bets',
    from: 'require(!paused, "Protocol paused");\n        require(msg.value >= minBet',
    to: 'require(msg.value >= minBet',
    expect: ['SEC-06']
  },
  {
    id: 'SEC-07',
    name: 'Single-step ownership transfer',
    from: 'pendingOwner = newOwner;',
    to: 'pendingOwner = newOwner; owner = newOwner;',
    expect: ['SEC-07']
  },
  {
    id: 'SEC-09',
    name: 'Market existence keyed on `active`',
    from: 'require(markets[marketId].creator == address(0), "Market already exists");',
    to: 'require(!markets[marketId].active, "Market already exists");',
    expect: ['SEC-09']
  }
];

function run(cmd) {
  try {
    return { ok: true, out: execSync(cmd, { cwd: rootDir, stdio: 'pipe', encoding: 'utf8' }) };
  } catch (err) {
    return { ok: false, out: `${err.stdout || ''}${err.stderr || ''}` };
  }
}

let allCaught = true;
try {
  for (const m of MUTATIONS) {
    const file = m.file || 'amm';
    let src = originals[file];
    for (const [from, to] of [[m.from, m.to], ...(m.extra || [])]) {
      if (!src.includes(from)) throw new Error(`[${m.id}] mutation anchor not found (contract changed?): ${from}`);
      src = src.replace(from, to);
    }
    fs.writeFileSync(FILES[file], src);

    const compiled = run('node scripts/compile.js');
    if (!compiled.ok) throw new Error(`[${m.id}] mutant failed to compile:\n${compiled.out}`);
    const result = run('node test/security_regressions.test.js');
    const failedIds = new Set([...result.out.matchAll(/\[FAIL\]\S* \[(SEC-\d+)\]/g)].map((x) => x[1]));
    const caught = m.expect.every((id) => failedIds.has(id));
    allCaught &&= caught;
    console.log(`${caught ? '[CAUGHT]' : '\x1b[31m[MISSED]\x1b[0m'} ${m.id}: ${m.name} -> failing: ${[...failedIds].join(', ') || 'none'}`);
    fs.writeFileSync(FILES[file], originals[file]);
  }
} finally {
  for (const [k, f] of Object.entries(FILES)) fs.writeFileSync(f, originals[k]);
  run('node scripts/compile.js');
}

console.log(allCaught ? '\nAll re-introduced bugs were detected by the regression suite.' : '\nSome re-introduced bugs were NOT detected.');
if (!allCaught) process.exitCode = 1;
