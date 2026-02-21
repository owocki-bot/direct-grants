/**
 * Direct Grants API
 * 
 * Simple mechanism: POST a grant request → ETH sent directly to recipient
 * Perfect for AI agents that need to fund work quickly without complex processes.
 * 
 * Flow:
 * 1. AI agent or user POSTs grant request with recipient, amount, reason
 * 2. System verifies funding tx and sends ETH (minus 5% fee)
 * 3. Grant recorded on-chain for transparency
 */

const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { ethers } = require('ethers');

const app = express();
app.use(cors());
app.use(express.json());

// ============================================================================
// CONFIG
// ============================================================================

const BASE_RPC = process.env.BASE_RPC || 'https://mainnet.base.org';
const TREASURY_ADDRESS = '0xccD7200024A8B5708d381168ec2dB0DC587af83F';
const TREASURY_PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY?.trim();
const FEE_PERCENT = 5n;

let provider = null;
let wallet = null;

function getProvider() {
  if (!provider) provider = new ethers.JsonRpcProvider(BASE_RPC);
  return provider;
}

function getWallet() {
  if (!wallet && TREASURY_PRIVATE_KEY) {
    wallet = new ethers.Wallet(TREASURY_PRIVATE_KEY, getProvider());
  }
  return wallet;
}

// ============================================================================
// DATA STORAGE
// ============================================================================

const grants = new Map();
const grantors = new Map(); // address -> stats

// ============================================================================
// HELPERS
// ============================================================================

function formatETH(wei) {
  return parseFloat(ethers.formatEther(wei.toString())).toFixed(6) + ' ETH';
}

function parseETH(ethString) {
  const cleaned = ethString.toString().replace(' ETH', '').trim();
  return ethers.parseEther(cleaned);
}

// ============================================================================
// API: GRANTS
// ============================================================================

/**
 * Create and fund a direct grant
 * POST /grants { recipient, amount, reason, txHash }
 * 
 * txHash = transaction where you sent ETH to treasury
 * We verify it and forward to recipient (minus 5% fee)
 */

// ============================================================================
// WHITELIST MIDDLEWARE
// ============================================================================

let _whitelistCache = null;
let _whitelistCacheTime = 0;
const WHITELIST_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function fetchWhitelist() {
  const now = Date.now();
  if (_whitelistCache && (now - _whitelistCacheTime) < WHITELIST_CACHE_TTL) {
    return _whitelistCache;
  }
  try {
    const res = await fetch('https://www.owockibot.xyz/api/whitelist');
    const data = await res.json();
    _whitelistCache = new Set(data.map(e => (e.address || e).toLowerCase()));
    _whitelistCacheTime = now;
    return _whitelistCache;
  } catch (err) {
    console.error('Whitelist fetch failed:', err.message);
    if (_whitelistCache) return _whitelistCache;
    return new Set();
  }
}

function requireWhitelist(addressField = 'address') {
  return async (req, res, next) => {
    const addr = req.body?.[addressField] || req.body?.creator || req.body?.participant || req.body?.sender || req.body?.from || req.body?.address;
    if (!addr) {
      return res.status(400).json({ error: 'Address required' });
    }
    const whitelist = await fetchWhitelist();
    if (!whitelist.has(addr.toLowerCase())) {
      return res.status(403).json({ error: 'Invite-only. Tag @owockibot on X to request access.' });
    }
    next();
  };
}


app.post('/grants', requireWhitelist(), async (req, res) => {
  const { recipient, amount, reason, txHash, grantor } = req.body;
  const isMock = req.query.mock === 'true';

  if (!recipient || !txHash) {
    return res.status(400).json({
      error: 'recipient and txHash required',
      example: {
        recipient: '0x...',
        amount: '0.01',
        reason: 'Great work on the docs',
        txHash: '0x...'
      },
      instructions: {
        step1: `Send ETH to treasury: ${TREASURY_ADDRESS}`,
        step2: 'POST /grants with txHash and recipient'
      }
    });
  }

  if (!ethers.isAddress(recipient)) {
    return res.status(400).json({ error: 'Invalid recipient address' });
  }

  // Check for duplicate tx
  const existingGrant = Array.from(grants.values()).find(g => g.fundingTxHash?.toLowerCase() === txHash.toLowerCase());
  if (existingGrant) {
    return res.status(400).json({ error: 'Transaction already used for grant', grantId: existingGrant.id });
  }

  try {
    let fundingAmount;
    let txFrom;

    if (!isMock) {
      // Verify the funding transaction
      const tx = await getProvider().getTransaction(txHash);
      if (!tx) {
        return res.status(400).json({ error: 'Transaction not found' });
      }

      const receipt = await getProvider().getTransactionReceipt(txHash);
      if (!receipt || receipt.status !== 1) {
        return res.status(400).json({ error: 'Transaction failed or pending' });
      }

      if (tx.to?.toLowerCase() !== TREASURY_ADDRESS.toLowerCase()) {
        return res.status(400).json({
          error: 'Not sent to treasury',
          expected: TREASURY_ADDRESS,
          got: tx.to
        });
      }

      fundingAmount = tx.value;
      txFrom = tx.from;
    } else {
      // Mock mode: use fake data
      fundingAmount = amount ? parseETH(amount) : ethers.parseEther('0.01');
      txFrom = grantor || '0x' + '1'.repeat(40);
    }
    const fee = (fundingAmount * FEE_PERCENT) / 100n;
    const netAmount = fundingAmount - fee;

    let distributeTxHash;

    if (!isMock) {
      // Send to recipient
      const w = getWallet();
      if (!w) {
        return res.status(500).json({ error: 'Wallet not configured' });
      }

      const distributeTx = await w.sendTransaction({
        to: recipient,
        value: netAmount
      });
      distributeTxHash = distributeTx.hash;
    } else {
      // Mock mode: fake tx hash
      distributeTxHash = '0xmock' + uuidv4().replace(/-/g, '');
    }

    const grant = {
      id: uuidv4(),
      recipient: recipient.toLowerCase(),
      grantor: (grantor || txFrom).toLowerCase(),
      reason: reason || 'Direct grant',
      grossAmount: fundingAmount.toString(),
      grossAmountFormatted: formatETH(fundingAmount),
      fee: fee.toString(),
      feeFormatted: formatETH(fee),
      netAmount: netAmount.toString(),
      netAmountFormatted: formatETH(netAmount),
      fundingTxHash: txHash,
      distributionTxHash: distributeTxHash,
      status: 'completed',
      mock: isMock || undefined,
      createdAt: Date.now()
    };

    grants.set(grant.id, grant);

    // Track grantor stats
    const grantorAddr = grant.grantor;
    if (!grantors.has(grantorAddr)) {
      grantors.set(grantorAddr, { totalGrants: 0, totalAmount: 0n });
    }
    const stats = grantors.get(grantorAddr);
    stats.totalGrants++;
    stats.totalAmount = BigInt(stats.totalAmount) + fundingAmount;

    console.log(`[GRANT] ${formatETH(netAmount)} to ${recipient.slice(0, 10)}... - "${reason || 'Direct grant'}"`);

    res.status(201).json({
      success: true,
      grant,
      mock: isMock || undefined,
      basescanUrl: `https://basescan.org/tx/${distributeTxHash}`
    });

  } catch (err) {
    console.error('[GRANT ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * List all grants
 */
app.get('/grants', (req, res) => {
  const { recipient, grantor, limit } = req.query;
  let results = Array.from(grants.values());

  if (recipient) {
    results = results.filter(g => g.recipient === recipient.toLowerCase());
  }
  if (grantor) {
    results = results.filter(g => g.grantor === grantor.toLowerCase());
  }

  results.sort((a, b) => b.createdAt - a.createdAt);

  if (limit) {
    results = results.slice(0, parseInt(limit));
  }

  res.json({
    grants: results,
    total: results.length
  });
});

/**
 * Get grant by ID
 */
app.get('/grants/:id', (req, res) => {
  const grant = grants.get(req.params.id);
  if (!grant) {
    return res.status(404).json({ error: 'Grant not found' });
  }
  res.json(grant);
});

/**
 * Get grantor stats
 */
app.get('/grantors/:address', (req, res) => {
  const { address } = req.params;
  if (!ethers.isAddress(address)) {
    return res.status(400).json({ error: 'Invalid address' });
  }

  const stats = grantors.get(address.toLowerCase());
  if (!stats) {
    return res.json({ address: address.toLowerCase(), totalGrants: 0, totalAmount: '0', totalAmountFormatted: '0 ETH' });
  }

  const grantorGrants = Array.from(grants.values())
    .filter(g => g.grantor === address.toLowerCase())
    .sort((a, b) => b.createdAt - a.createdAt);

  res.json({
    address: address.toLowerCase(),
    totalGrants: stats.totalGrants,
    totalAmount: stats.totalAmount.toString(),
    totalAmountFormatted: formatETH(stats.totalAmount),
    recentGrants: grantorGrants.slice(0, 10)
  });
});

// ============================================================================
// E2E TEST
// ============================================================================

/**
 * E2E Test endpoint - full grant in one request
 */
app.post('/test/e2e', async (req, res) => {
  const { txHash, recipient } = req.body;

  if (!txHash) {
    return res.status(400).json({
      error: 'txHash required',
      instructions: {
        step1: `Send ETH to treasury: ${TREASURY_ADDRESS}`,
        step2: 'POST /test/e2e with { txHash, recipient }'
      }
    });
  }

  const targetRecipient = recipient || TREASURY_ADDRESS;
  const steps = [];

  try {
    // Verify tx
    steps.push({ step: 1, action: 'Verifying transaction...' });
    const tx = await getProvider().getTransaction(txHash);
    if (!tx) {
      return res.status(400).json({ error: 'Transaction not found', steps });
    }

    const receipt = await getProvider().getTransactionReceipt(txHash);
    if (!receipt || receipt.status !== 1) {
      return res.status(400).json({ error: 'Transaction failed or pending', steps });
    }

    if (tx.to?.toLowerCase() !== TREASURY_ADDRESS.toLowerCase()) {
      return res.status(400).json({ error: 'Not sent to treasury', steps });
    }

    const fundingAmount = tx.value;
    steps.push({ step: 1, status: 'verified', from: tx.from, amount: formatETH(fundingAmount) });

    // Calculate fee and send
    const fee = (fundingAmount * FEE_PERCENT) / 100n;
    const netAmount = fundingAmount - fee;

    steps.push({ step: 2, action: 'Sending grant...' });
    const w = getWallet();
    if (!w) {
      return res.status(500).json({ error: 'Wallet not configured', steps });
    }

    const distributeTx = await w.sendTransaction({
      to: targetRecipient,
      value: netAmount
    });

    const grant = {
      id: uuidv4(),
      recipient: targetRecipient.toLowerCase(),
      grantor: tx.from.toLowerCase(),
      reason: 'E2E Test Grant',
      grossAmount: fundingAmount.toString(),
      grossAmountFormatted: formatETH(fundingAmount),
      fee: fee.toString(),
      feeFormatted: formatETH(fee),
      netAmount: netAmount.toString(),
      netAmountFormatted: formatETH(netAmount),
      fundingTxHash: txHash,
      distributionTxHash: distributeTx.hash,
      status: 'completed',
      createdAt: Date.now()
    };

    grants.set(grant.id, grant);

    steps.push({
      step: 2,
      status: 'sent',
      txHash: distributeTx.hash,
      recipient: targetRecipient,
      netAmount: formatETH(netAmount)
    });

    res.json({
      success: true,
      message: 'E2E test completed!',
      grant,
      steps,
      summary: {
        funded: formatETH(fundingAmount),
        fee: formatETH(fee) + ' (5%)',
        sent: formatETH(netAmount),
        recipient: targetRecipient,
        txHash: distributeTx.hash,
        basescanUrl: `https://basescan.org/tx/${distributeTx.hash}`
      }
    });

  } catch (err) {
    res.status(500).json({ error: err.message, steps });
  }
});

// ============================================================================
// UTILITY
// ============================================================================

app.get('/stats', (req, res) => {
  const allGrants = Array.from(grants.values());
  const totalGranted = allGrants.reduce((sum, g) => sum + BigInt(g.netAmount), 0n);
  const totalFees = allGrants.reduce((sum, g) => sum + BigInt(g.fee), 0n);

  res.json({
    totalGrants: allGrants.length,
    totalGranted: formatETH(totalGranted),
    totalFees: formatETH(totalFees),
    uniqueRecipients: new Set(allGrants.map(g => g.recipient)).size,
    uniqueGrantors: grantors.size
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    platform: 'Direct Grants',
    network: 'Base',
    treasury: TREASURY_ADDRESS,
    payoutsEnabled: !!TREASURY_PRIVATE_KEY,
    feePercent: 5
  });
});

/**
 * Agent documentation endpoint
 * GET /agent
 */
app.get('/agent', (req, res) => {
  res.json({
    name: "Direct Grants",
    description: "Simplest funding mechanism. Send ETH to treasury, specify recipient - funds forwarded instantly. Perfect for AI agents funding work quickly.",
    network: "Base (chainId 8453)",
    treasury_fee: "5%",
    endpoints: [
      {
        method: "POST",
        path: "/grants",
        description: "Create and fund a direct grant (send ETH to treasury first)",
        body: { recipient: "string - required, payout address", reason: "string - description of grant", txHash: "string - required, your tx sending ETH to treasury", grantor: "string - optional, defaults to tx sender" },
        returns: { grant: "object", basescanUrl: "string - link to distribution tx" }
      },
      {
        method: "GET",
        path: "/grants",
        description: "List all grants, optionally filter by recipient or grantor",
        query: { recipient: "string - filter by recipient address", grantor: "string - filter by grantor address", limit: "number" },
        returns: { grants: "array of grant objects", total: "number" }
      },
      {
        method: "GET",
        path: "/grants/:id",
        description: "Get grant details by ID",
        returns: { id: "string", recipient: "string", grantor: "string", netAmount: "string", reason: "string", distributionTxHash: "string" }
      },
      {
        method: "GET",
        path: "/grantors/:address",
        description: "Get grantor stats and recent grants",
        returns: { totalGrants: "number", totalAmount: "string", recentGrants: "array" }
      },
      {
        method: "GET",
        path: "/stats",
        description: "Platform statistics",
        returns: { totalGrants: "number", totalGranted: "string", uniqueRecipients: "number", uniqueGrantors: "number" }
      }
    ],
    example_flow: [
      "1. Send ETH to treasury: 0xccD7200024A8B5708d381168ec2dB0DC587af83F",
      "2. POST /grants with { recipient, reason, txHash }",
      "3. Recipient receives 95% instantly (5% fee)"
    ],
    x402_enabled: false
  });
});

// ============================================================================
// LANDING PAGE
// ============================================================================

app.get('/', (req, res) => {
  const allGrants = Array.from(grants.values());
  const totalGranted = allGrants.reduce((sum, g) => sum + BigInt(g.netAmount), 0n);

  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Direct Grants | Simple ETH Grants</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0d1117;
      color: #e6edf3;
      min-height: 100vh;
    }
    .container { max-width: 900px; margin: 0 auto; padding: 2rem; }
    
    .hero {
      text-align: center;
      padding: 4rem 2rem;
      background: linear-gradient(180deg, rgba(63,185,80,0.15) 0%, transparent 100%);
      border-radius: 16px;
      margin-bottom: 3rem;
    }
    .hero h1 {
      font-size: 2.5rem;
      margin-bottom: 1rem;
      background: linear-gradient(90deg, #3fb950, #58a6ff);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .hero p { color: #8b949e; max-width: 600px; margin: 0 auto 2rem; }
    
    .badge {
      display: inline-block;
      background: #238636;
      color: white;
      padding: 0.25rem 0.75rem;
      border-radius: 20px;
      font-size: 0.8rem;
      margin-bottom: 1rem;
    }
    
    .stats {
      display: flex;
      justify-content: center;
      gap: 3rem;
      margin: 2rem 0;
      flex-wrap: wrap;
    }
    .stat { text-align: center; }
    .stat-value { font-size: 2rem; font-weight: bold; color: #3fb950; }
    .stat-label { color: #8b949e; font-size: 0.85rem; }
    
    .how-it-works {
      background: rgba(63,185,80,0.1);
      border: 1px solid rgba(63,185,80,0.3);
      border-radius: 12px;
      padding: 2rem;
      margin-bottom: 3rem;
    }
    .how-it-works h2 { margin-bottom: 1.5rem; color: #3fb950; }
    .steps {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1.5rem;
    }
    .step {
      text-align: center;
      padding: 1rem;
    }
    .step-num {
      width: 40px;
      height: 40px;
      background: linear-gradient(135deg, #3fb950, #58a6ff);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: bold;
      margin: 0 auto 0.75rem;
    }
    .step h4 { margin-bottom: 0.5rem; }
    .step p { font-size: 0.85rem; color: #8b949e; }
    
    .api-section {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 12px;
      padding: 1.5rem;
      margin-bottom: 2rem;
    }
    .endpoint {
      display: flex;
      gap: 1rem;
      padding: 0.75rem 0;
      border-bottom: 1px solid #30363d;
      font-family: monospace;
      font-size: 0.85rem;
      align-items: center;
    }
    .endpoint:last-child { border-bottom: none; }
    .method { 
      width: 60px; 
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      text-align: center;
      font-weight: bold;
    }
    .method.get { background: rgba(88,166,255,0.2); color: #58a6ff; }
    .method.post { background: rgba(63,185,80,0.2); color: #3fb950; }
    .endpoint-desc { margin-left: auto; color: #8b949e; }
    
    .example {
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 1rem;
      margin-top: 1rem;
      overflow-x: auto;
    }
    pre { font-size: 0.8rem; color: #8b949e; white-space: pre-wrap; }
    
    footer {
      text-align: center;
      padding: 2rem;
      color: #8b949e;
      border-top: 1px solid #30363d;
    }
    footer a { color: #58a6ff; text-decoration: none; }
  </style>
</head>
<body>
  <div class="container">
    <div class="hero">
      <div class="badge">🟢 LIVE ON BASE</div>
      <h1>💸 Direct Grants</h1>
      <p>The simplest funding mechanism. Send ETH directly to worthy recipients. No voting, no complex processes—just fund good work.</p>
      
      <div class="stats">
        <div class="stat">
          <div class="stat-value">${allGrants.length}</div>
          <div class="stat-label">Grants Made</div>
        </div>
        <div class="stat">
          <div class="stat-value">${formatETH(totalGranted)}</div>
          <div class="stat-label">Total Granted</div>
        </div>
        <div class="stat">
          <div class="stat-value">${new Set(allGrants.map(g => g.recipient)).size}</div>
          <div class="stat-label">Recipients</div>
        </div>
      </div>
    </div>

    <div class="how-it-works">
      <h2>How It Works</h2>
      <div class="steps">
        <div class="step">
          <div class="step-num">1</div>
          <h4>Send ETH to Treasury</h4>
          <p>Transfer ETH to ${TREASURY_ADDRESS.slice(0, 6)}...${TREASURY_ADDRESS.slice(-4)}</p>
        </div>
        <div class="step">
          <div class="step-num">2</div>
          <h4>POST /grants</h4>
          <p>Include txHash, recipient, and reason</p>
        </div>
        <div class="step">
          <div class="step-num">3</div>
          <h4>Recipient Gets ETH</h4>
          <p>95% sent instantly (5% fee)</p>
        </div>
      </div>
    </div>

    <div class="api-section">
      <h2 style="margin-bottom: 1rem;">🔌 API Endpoints</h2>
      <div class="endpoint">
        <span class="method post">POST</span>
        <span>/grants</span>
        <span class="endpoint-desc">Create & fund a grant</span>
      </div>
      <div class="endpoint">
        <span class="method get">GET</span>
        <span>/grants</span>
        <span class="endpoint-desc">List all grants</span>
      </div>
      <div class="endpoint">
        <span class="method get">GET</span>
        <span>/grants/:id</span>
        <span class="endpoint-desc">Get grant details</span>
      </div>
      <div class="endpoint">
        <span class="method get">GET</span>
        <span>/grantors/:address</span>
        <span class="endpoint-desc">Grantor stats</span>
      </div>
      <div class="endpoint">
        <span class="method post">POST</span>
        <span>/test/e2e</span>
        <span class="endpoint-desc">E2E test</span>
      </div>
      <div class="endpoint">
        <span class="method get">GET</span>
        <span>/health</span>
        <span class="endpoint-desc">Health check</span>
      </div>
      
      <div class="example">
        <strong>Example: Create Grant</strong>
        <pre>
POST /grants
{
  "recipient": "0x1234...abcd",
  "reason": "Great documentation work",
  "txHash": "0xabc123..."  // Your tx sending ETH to treasury
}</pre>
      </div>
    </div>
  </div>

  <footer>
    <p>
      Built by <a href="https://x.com/owockibot">@owockibot</a> | 
      5% platform fee |
      Treasury: <a href="https://basescan.org/address/${TREASURY_ADDRESS}">${TREASURY_ADDRESS.slice(0, 6)}...${TREASURY_ADDRESS.slice(-4)}</a>
    </p>
  </footer>
</body>
</html>
  `);
});

// ============================================================================
// START
// ============================================================================

const PORT = process.env.PORT || 3010;
app.listen(PORT, () => console.log(`Direct Grants running on :${PORT}`));
module.exports = app;
