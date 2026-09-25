'use strict';
// Cross-checks game-engine.js's evaluateHand()/compareHands() against the browser copy
// (evalHand/isSeq/cmpScore) extracted verbatim from public/KALAK_3PATTI.html, over a large
// number of random 3-card hand pairs. Run: node test-evaluator-crosscheck.js
//
// This closes the one correctness gap flagged before Phase 3: once the server engine is wired
// in, it becomes the sole authority on who wins each hand, so it must agree with the offline
// browser engine on every edge case (ties, suit ordering, A-2-3, etc.).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { evaluateHand: serverEval, compareHands: serverCompare } = require('./game-engine.js');

// --- Extract the browser evaluator functions verbatim from public/KALAK_3PATTI.html so we are
// testing the actual shipped code, not a hand-copied transcription of it.
const htmlPath = path.join(__dirname, 'public', 'KALAK_3PATTI.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const start = html.indexOf('function evalHand(hand){');
const end = html.indexOf('function rankStr(r){');
if (start === -1 || end === -1) {
  throw new Error('Could not locate evalHand()/isSeq()/cmpScore() in public/KALAK_3PATTI.html — the browser file changed shape; update the markers above.');
}
const browserSrc = html.slice(start, end);
// eslint-disable-next-line no-new-func
const browserModule = new Function(`${browserSrc}\nreturn { evalHand, isSeq, cmpScore };`)();
const { evalHand: browserEval, cmpScore: browserCompare } = browserModule;

function randomCard() {
  return { r: 2 + Math.floor(Math.random() * 13), s: Math.floor(Math.random() * 4) };
}
function randomHand() {
  // Hands need not be distinct cards across the deck for this test — each evaluator scores a
  // hand purely from its own 3 cards, so per-hand duplicate ranks/suits are fine and actually
  // exercise trail/pair edge cases more often than a full no-duplicate deal would.
  return [randomCard(), randomCard(), randomCard()];
}

const N = 100000;
let mismatches = [];
let tieCompareMismatches = [];

for (let i = 0; i < N; i += 1) {
  const handA = randomHand();
  const handB = randomHand();

  const sA = serverEval(handA);
  const sB = serverEval(handB);
  const bA = browserEval(handA);
  const bB = browserEval(handB);

  // 1) Same hand must get the same type + tiebreak values from both evaluators.
  const typeMatchA = sA.type === bA.t && JSON.stringify(sA.values) === JSON.stringify(bA.vals);
  const typeMatchB = sB.type === bB.t && JSON.stringify(sB.values) === JSON.stringify(bB.vals);
  if (!typeMatchA) mismatches.push({ hand: handA, server: sA, browser: bA });
  if (!typeMatchB) mismatches.push({ hand: handB, server: sB, browser: bB });

  // 2) Head-to-head comparison sign must agree (who wins, or a tie) between the two engines.
  const serverSign = Math.sign(serverCompare(sA, sB));
  const browserSign = Math.sign(browserCompare(bA, bB));
  if (serverSign !== browserSign) {
    tieCompareMismatches.push({ handA, handB, serverSign, browserSign, sA, sB, bA, bB });
  }
}

console.log(`Ran ${N} random hand-pairs (${N * 2} single-hand evaluations).`);
console.log(`Single-hand type/value mismatches: ${mismatches.length}`);
console.log(`Head-to-head comparison-sign mismatches: ${tieCompareMismatches.length}`);

if (mismatches.length) {
  console.log('\nFirst mismatch example:');
  console.log(JSON.stringify(mismatches[0], null, 2));
}
if (tieCompareMismatches.length) {
  console.log('\nFirst compare-sign mismatch example:');
  console.log(JSON.stringify(tieCompareMismatches[0], null, 2));
}

try {
  assert.strictEqual(mismatches.length, 0, `${mismatches.length} single-hand mismatches found`);
  assert.strictEqual(tieCompareMismatches.length, 0, `${tieCompareMismatches.length} compare-sign mismatches found`);
  console.log('\nPASS — server and browser evaluators agree on every case.');
  process.exitCode = 0;
} catch (e) {
  console.log(`\nFAIL — ${e.message}`);
  process.exitCode = 1;
}
