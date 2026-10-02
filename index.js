import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSV_PATH = path.join(__dirname, 'entry-log.csv');
const ENV = loadEnv();

// Load environment variables
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  const env = {};

  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    content.split('\n').forEach(line => {
      const [key, value] = line.split('=');
      if (key && value) {
        env[key.trim()] = value.trim();
      }
    });
  }

  return env;
}

// Initialize CSV file with headers if it doesn't exist
function initializeCSV() {
  if (!fs.existsSync(CSV_PATH)) {
    const headers = 'timestamp,pair,signal,bias,rsi,close_price,entry_price,stop_loss,take_profit,risk_pips,profit_pips,ratio,meets_minimum,status\n';
    fs.writeFileSync(CSV_PATH, headers, 'utf-8');
  }
}

// Calculate risk/reward ratio
function calculateRiskReward(entry, stop, tp) {
  const risk = Math.abs(entry - stop);
  const profit = Math.abs(tp - entry);

  if (risk === 0) return 0;
  return profit / risk;
}

// Log entry to CSV
function logToCSV(data) {
  const line = `${data.timestamp},${data.pair},${data.signal},${data.bias},${data.rsi},${data.close_price},${data.entry_price},${data.stop_loss},${data.take_profit},${data.risk_pips},${data.profit_pips},${data.ratio.toFixed(2)},${data.meets_minimum},${data.status}\n`;

  try {
    fs.appendFileSync(CSV_PATH, line, 'utf-8');
  } catch (err) {
    console.error('Error writing to CSV:', err);
  }
}

// Parse top 5 pairs from environment
function parseTop5Pairs() {
  const bullish = (ENV.TOP_5_BULLISH || '').split(',').map(p => p.trim().toUpperCase()).filter(p => p);
  const bearish = (ENV.TOP_5_BEARISH || '').split(',').map(p => p.trim().toUpperCase()).filter(p => p);
  return { bullish, bearish };
}

// Check if pair is in top 5
function isTop5Pair(pair, bias) {
  const { bullish, bearish } = parseTop5Pairs();
  const normalizedPair = pair.toUpperCase().replace(' ', '');

  if (bias === 'BULLISH') {
    return bullish.some(p => p.replace(' ', '') === normalizedPair);
  } else if (bias === 'BEARISH') {
    return bearish.some(p => p.replace(' ', '') === normalizedPair);
  }
  return false;
}

// Send Discord notification
async function sendDiscordNotification(data) {
  const webhook = ENV.DISCORD_WEBHOOK;

  if (!webhook) {
    console.warn('DISCORD_WEBHOOK not configured. Skipping Discord notification.');
    return;
  }

  const url = new URL(webhook);
  const isTop5 = isTop5Pair(data.pair, data.bias);

  // Color coding:
  // Top 5 BULLISH: Bright Green (65280)
  // Top 5 BEARISH: Bright Red (16711680)
  // Regular LONG: Light Green (3066993)
  // Regular SHORT: Light Red (15158332)
  // Below minimum: Gray (9807270)

  let statusColor;
  if (!data.meets_minimum) {
    statusColor = 9807270; // Gray
  } else if (data.signal === 'LONG') {
    statusColor = isTop5 ? 65280 : 3066993; // Bright or light green
  } else {
    statusColor = isTop5 ? 16711680 : 15158332; // Bright or light red
  }

  const statusText = data.meets_minimum ? '✅ MEETS RATIO' : '❌ BELOW MINIMUM';
  const priorityBadge = isTop5 ? '⭐ **TOP 5 PRIORITY**' : '⚪ Standard Entry';

  const embed = {
    title: `${isTop5 ? '⭐ ' : ''}${data.pair} ${data.signal}`,
    description: `**Bias:** ${data.bias}\n**Price:** ${data.close_price}\n**RSI:** ${data.rsi}`,
    fields: [
      {
        name: 'Priority',
        value: priorityBadge,
        inline: false
      },
      {
        name: 'Risk/Reward Ratio',
        value: `${data.ratio.toFixed(2)}:1 (Required: ${ENV.MINIMUM_RR || '2'}:1)`,
        inline: false
      },
      {
        name: 'Risk Pips',
        value: data.risk_pips.toFixed(2),
        inline: true
      },
      {
        name: 'Profit Pips',
        value: data.profit_pips.toFixed(2),
        inline: true
      },
      {
        name: 'Status',
        value: statusText,
        inline: false
      }
    ],
    timestamp: new Date().toISOString(),
    color: statusColor
  };

  const payload = JSON.stringify({ embeds: [embed] });

  const options = {
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`Discord API returned ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Parse TradingView alert payload
function parseAlert(body) {
  try {
    return JSON.parse(body);
  } catch (e) {
    console.error('Failed to parse alert JSON:', e);
    return null;
  }
}

// Handle incoming alert
async function handleAlert(alert) {
  if (!alert.pair || !alert.signal || !alert.bias || alert.rsi === undefined || !alert.close) {
    console.error('Invalid alert payload. Required fields: pair, signal, bias, rsi, close');
    return { success: false, error: 'Invalid payload' };
  }

  // Check if pair is in Top 5 (NEW FILTER)
  if (!isTop5Pair(alert.pair, alert.bias)) {
    console.warn(`⚠️  Alert rejected: ${alert.pair} ${alert.bias} is NOT in current Top 5 list`);
    return { success: false, error: `${alert.pair} not in Top 5 ${alert.bias} pairs` };
  }

  const timestamp = new Date().toISOString();
  const minimumRR = parseFloat(ENV.MINIMUM_RR || '3');

  // Calculate RR based on hardcoded SL/TP logic
  // This is a simplified version - you'll need to pass SL and TP from TradingView
  // Or implement a technical level lookup

  // For now, we'll calculate based on assumptions:
  // - SL typically 50-111 pips from entry depending on pair
  // - TP calculated to achieve target RR

  // NOTE: In production, you should pass stop_loss and take_profit from TradingView Pine Script
  const stop_loss = alert.stop_loss || null;
  const take_profit = alert.take_profit || null;

  let meetsMinimum = false;
  let riskPips = 0;
  let profitPips = 0;
  let ratio = 0;

  if (stop_loss && take_profit) {
    riskPips = Math.abs(alert.close - stop_loss);
    profitPips = Math.abs(take_profit - alert.close);
    ratio = calculateRiskReward(alert.close, stop_loss, take_profit);
    meetsMinimum = ratio >= minimumRR;
  } else {
    // No SL/TP provided - alert gets logged but can't be filtered
    meetsMinimum = true; // Pass through for manual review
    ratio = 0;
  }

  const logEntry = {
    timestamp,
    pair: alert.pair,
    signal: alert.signal,
    bias: alert.bias,
    rsi: alert.rsi,
    close_price: alert.close,
    entry_price: alert.entry || alert.close,
    stop_loss: stop_loss || '',
    take_profit: take_profit || '',
    risk_pips: riskPips,
    profit_pips: profitPips,
    ratio,
    meets_minimum: meetsMinimum ? 'YES' : 'NO',
    status: 'PENDING'
  };

  // Log to CSV
  logToCSV(logEntry);

  // Send Discord notification
  try {
    await sendDiscordNotification(logEntry);
  } catch (err) {
    console.error('Discord notification failed:', err);
  }

  return {
    success: true,
    message: `Alert logged for ${alert.pair}`,
    meetsMinimum,
    ratio: ratio.toFixed(2)
  };
}

// HTTP Server
const PORT = process.env.PORT || ENV.PORT || 3000;
const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/alert') {
    let body = '';

    req.on('data', chunk => {
      body += chunk;
    });

    req.on('end', async () => {
      const alert = parseAlert(body);
      if (!alert) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      const result = await handleAlert(alert);
      res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
  } else if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'running' }));
  } else if (req.url === '/api/alerts') {
    // Read CSV and convert to JSON
    try {
      const content = fs.readFileSync(CSV_PATH, 'utf-8');
      const lines = content.trim().split('\n');
      const headers = lines[0].split(',');

      const alerts = lines.slice(1).map(line => {
        const values = line.split(',');
        const obj = {};
        headers.forEach((header, idx) => {
          obj[header.trim()] = values[idx] ? values[idx].trim() : '';
        });
        return obj;
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(alerts.reverse())); // Most recent first
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to read alerts' }));
    }
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

// Start server
initializeCSV();
server.listen(PORT, () => {
  const { bullish, bearish } = parseTop5Pairs();
  console.log(`✅ Entry Bot running on port ${PORT}`);
  console.log(`📊 CSV log: ${CSV_PATH}`);
  console.log(`🤖 Minimum RR ratio: 1:${ENV.MINIMUM_RR || '2'}`);
  console.log(`💬 Discord webhook: ${ENV.DISCORD_WEBHOOK ? 'configured' : 'NOT configured'}`);
  if (bullish.length > 0 || bearish.length > 0) {
    console.log(`⭐ Top 5 Bullish: ${bullish.length > 0 ? bullish.join(', ') : 'None set'}`);
    console.log(`⭐ Top 5 Bearish: ${bearish.length > 0 ? bearish.join(', ') : 'None set'}`);
  }
  console.log(`\n🔗 Webhook URL for TradingView: http://localhost:${PORT}/alert`);
  console.log(`❤️  Health check: http://localhost:${PORT}/health`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
