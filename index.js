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
  console.log('📥 Received alert:', JSON.stringify(alert));

  if (!alert.pair || !alert.signal || !alert.bias || alert.rsi === undefined || !alert.close) {
    console.error('❌ Invalid alert payload. Received:', JSON.stringify(alert));
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

// Dashboard HTML
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MACROBIAS Entry Bot Dashboard</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            background: linear-gradient(135deg, #0f0f1e 0%, #1a1a2e 100%);
            color: #e0e0e0;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            padding: 20px;
            min-height: 100vh;
        }

        .container {
            max-width: 1400px;
            margin: 0 auto;
        }

        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 30px;
            padding-bottom: 20px;
            border-bottom: 2px solid #00d4ff;
        }

        h1 {
            font-size: 2.5em;
            background: linear-gradient(135deg, #00d4ff, #0099cc);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }

        .status-indicator {
            display: flex;
            align-items: center;
            gap: 10px;
            font-size: 0.9em;
        }

        .status-dot {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            background-color: #00ff00;
            animation: pulse 2s infinite;
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-bottom: 30px;
        }

        .stat-card {
            background: rgba(0, 212, 255, 0.1);
            border: 1px solid #00d4ff;
            border-radius: 8px;
            padding: 20px;
            text-align: center;
        }

        .stat-value {
            font-size: 2.5em;
            font-weight: bold;
            color: #00ff88;
            margin-bottom: 5px;
        }

        .stat-label {
            font-size: 0.85em;
            color: #00d4ff;
            text-transform: uppercase;
        }

        .controls {
            margin-bottom: 20px;
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
        }

        button {
            background: linear-gradient(135deg, #00d4ff, #0099cc);
            border: none;
            color: #000;
            padding: 10px 20px;
            border-radius: 5px;
            cursor: pointer;
            font-weight: bold;
            transition: transform 0.2s;
        }

        button:hover {
            transform: scale(1.05);
        }

        .filter-group {
            display: flex;
            gap: 10px;
            align-items: center;
        }

        select {
            background: rgba(0, 212, 255, 0.1);
            border: 1px solid #00d4ff;
            color: #e0e0e0;
            padding: 8px 12px;
            border-radius: 5px;
            cursor: pointer;
        }

        .entries-table {
            width: 100%;
            border-collapse: collapse;
            background: rgba(0, 0, 0, 0.3);
            border-radius: 8px;
            overflow: hidden;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3);
        }

        thead {
            background: rgba(0, 212, 255, 0.15);
            border-bottom: 2px solid #00d4ff;
        }

        th {
            padding: 15px;
            text-align: left;
            font-weight: bold;
            color: #00d4ff;
            text-transform: uppercase;
            font-size: 0.85em;
        }

        td {
            padding: 12px 15px;
            border-bottom: 1px solid rgba(0, 212, 255, 0.2);
        }

        tbody tr {
            transition: background-color 0.3s;
        }

        tbody tr:hover {
            background-color: rgba(0, 212, 255, 0.1);
        }

        .top5-bullish {
            background: rgba(0, 255, 0, 0.15);
            border-left: 4px solid #00ff00;
        }

        .top5-bearish {
            background: rgba(255, 0, 0, 0.15);
            border-left: 4px solid #ff0000;
        }

        .standard-long {
            background: rgba(100, 200, 100, 0.1);
            border-left: 4px solid #64c864;
        }

        .standard-short {
            background: rgba(200, 100, 100, 0.1);
            border-left: 4px solid #c86464;
        }

        .below-minimum {
            background: rgba(128, 128, 128, 0.1);
            border-left: 4px solid #808080;
        }

        .badge {
            display: inline-block;
            padding: 4px 10px;
            border-radius: 12px;
            font-size: 0.75em;
            font-weight: bold;
            text-transform: uppercase;
        }

        .badge-top5 {
            background: #00ff00;
            color: #000;
        }

        .badge-long {
            background: #00aa44;
            color: #fff;
        }

        .badge-short {
            background: #cc3333;
            color: #fff;
        }

        .badge-ok {
            background: #00ff88;
            color: #000;
        }

        .badge-fail {
            background: #ff4444;
            color: #fff;
        }

        .ratio-highlight {
            font-weight: bold;
            color: #00ff88;
        }

        .pair-name {
            font-weight: bold;
            color: #00d4ff;
            font-size: 1.1em;
        }

        .empty-state {
            text-align: center;
            padding: 40px;
            color: #666;
        }

        .refresh-timer {
            font-size: 0.85em;
            color: #999;
            margin-top: 15px;
        }

        .last-updated {
            text-align: right;
            font-size: 0.85em;
            color: #00d4ff;
            margin-top: 10px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div>
                <h1>🤖 MACROBIAS Entry Bot</h1>
                <p style="color: #999; margin-top: 5px;">Real-time Alert Monitor & Risk/Reward Filter</p>
            </div>
            <div class="status-indicator">
                <div class="status-dot"></div>
                <span>Live Monitoring</span>
            </div>
        </div>

        <div class="stats-grid" id="statsGrid">
            <div class="stat-card">
                <div class="stat-value" id="totalAlerts">0</div>
                <div class="stat-label">Total Alerts</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" id="meetsMinimum">0</div>
                <div class="stat-label">Meets Min RR</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" id="top5Count">0</div>
                <div class="stat-label">Top 5 Priority</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" id="minRR">2.00</div>
                <div class="stat-label">Minimum Ratio</div>
            </div>
        </div>

        <div class="controls">
            <button onclick="refreshData()">🔄 Refresh Now</button>
            <div class="filter-group">
                <label for="filterSignal">Filter:</label>
                <select id="filterSignal" onchange="filterTable()">
                    <option value="">All Signals</option>
                    <option value="LONG">LONG Only</option>
                    <option value="SHORT">SHORT Only</option>
                </select>
                <select id="filterStatus" onchange="filterTable()">
                    <option value="">All Status</option>
                    <option value="YES">Meets Minimum Only</option>
                    <option value="NO">Below Minimum Only</option>
                </select>
            </div>
        </div>

        <table class="entries-table">
            <thead>
                <tr>
                    <th>Timestamp</th>
                    <th>Pair</th>
                    <th>Signal</th>
                    <th>Bias</th>
                    <th>Entry</th>
                    <th>SL</th>
                    <th>TP</th>
                    <th>Ratio</th>
                    <th>Status</th>
                    <th>Priority</th>
                </tr>
            </thead>
            <tbody id="tableBody">
                <tr><td colspan="11" style="text-align: center; padding: 40px; color: #666;">Loading...</td></tr>
            </tbody>
        </table>

        <div class="refresh-timer">
            ⏱️ Auto-refreshing every 5 seconds | Last updated: <span id="lastUpdate">--:--:--</span>
        </div>
        <div class="last-updated" id="totalEntries"></div>
    </div>

    <script>
        const TOP_5_BULLISH = ['USD/CAD', 'USD/CHF', 'CAD/CHF', 'AUD/CHF', 'GBP/CHF'];
        const TOP_5_BEARISH = ['GBP/JPY', 'AUD/JPY', 'NZD/JPY', 'EUR/USD', 'GBP/USD'];

        let allData = [];

        async function refreshData() {
            try {
                const response = await fetch('/api/alerts');
                if (response.ok) {
                    allData = await response.json();
                    updateStats();
                    renderTable();
                    updateTimestamp();
                }
            } catch (error) {
                console.error('Failed to fetch data:', error);
                loadLocalData();
            }
        }

        function loadLocalData() {
            allData = [];
            updateStats();
            renderTable();
            updateTimestamp();
        }

        function updateStats() {
            document.getElementById('totalAlerts').textContent = allData.length;
            document.getElementById('meetsMinimum').textContent = allData.filter(d => d.meets_minimum === 'YES').length;

            let top5Count = 0;
            allData.forEach(d => {
                const isTop5 = (d.signal === 'LONG' && TOP_5_BULLISH.includes(d.pair)) ||
                               (d.signal === 'SHORT' && TOP_5_BEARISH.includes(d.pair));
                if (isTop5 && d.meets_minimum === 'YES') top5Count++;
            });
            document.getElementById('top5Count').textContent = top5Count;
        }

        function renderTable() {
            const tbody = document.getElementById('tableBody');

            if (allData.length === 0) {
                tbody.innerHTML = '<tr><td colspan="11" style="text-align: center; padding: 40px; color: #666;">No alerts yet. Waiting for TradingView signals...</td></tr>';
                return;
            }

            tbody.innerHTML = allData.map((row, idx) => {
                const isTop5 = (row.signal === 'LONG' && TOP_5_BULLISH.includes(row.pair)) ||
                               (row.signal === 'SHORT' && TOP_5_BEARISH.includes(row.pair));

                let rowClass = 'below-minimum';
                if (row.meets_minimum === 'YES') {
                    if (row.signal === 'LONG') {
                        rowClass = isTop5 ? 'top5-bullish' : 'standard-long';
                    } else {
                        rowClass = isTop5 ? 'top5-bearish' : 'standard-short';
                    }
                }

                const signalBadge = row.signal === 'LONG'
                    ? '<span class="badge badge-long">LONG</span>'
                    : '<span class="badge badge-short">SHORT</span>';

                const statusBadge = row.meets_minimum === 'YES'
                    ? '<span class="badge badge-ok">✓ OK</span>'
                    : '<span class="badge badge-fail">✗ FAIL</span>';

                const priorityBadge = isTop5 && row.meets_minimum === 'YES'
                    ? '<span class="badge badge-top5">⭐ TOP 5</span>'
                    : '-';

                const timestamp = new Date(row.timestamp).toLocaleTimeString('en-GB', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit'
                });

                const entryPrice = parseFloat(row.entry_price || row.close_price).toFixed(5);
                const slPrice = row.stop_loss ? parseFloat(row.stop_loss).toFixed(5) : '-';
                const tpPrice = row.take_profit ? parseFloat(row.take_profit).toFixed(5) : '-';

                return \`
                    <tr class="\${rowClass}">
                        <td>\${timestamp}</td>
                        <td><span class="pair-name">\${row.pair}</span></td>
                        <td>\${signalBadge}</td>
                        <td>\${row.bias}</td>
                        <td>\${entryPrice}</td>
                        <td>\${slPrice}</td>
                        <td>\${tpPrice}</td>
                        <td><span class="ratio-highlight">\${parseFloat(row.ratio).toFixed(2)}:1</span></td>
                        <td>\${statusBadge}</td>
                        <td>\${priorityBadge}</td>
                    </tr>
                \`;
            }).join('');
        }

        function filterTable() {
            const signalFilter = document.getElementById('filterSignal').value;
            const statusFilter = document.getElementById('filterStatus').value;

            const tbody = document.getElementById('tableBody');
            const rows = tbody.querySelectorAll('tr');

            rows.forEach(row => {
                let show = true;

                if (signalFilter) {
                    const signal = row.textContent.includes('LONG') ? 'LONG' : 'SHORT';
                    if (signal !== signalFilter) show = false;
                }

                if (statusFilter) {
                    const status = row.textContent.includes('OK') ? 'YES' : 'NO';
                    if (status !== statusFilter) show = false;
                }

                row.style.display = show ? '' : 'none';
            });
        }

        function updateTimestamp() {
            const now = new Date();
            const timeString = now.toLocaleTimeString('en-GB');
            document.getElementById('lastUpdate').textContent = timeString;

            if (allData.length > 0) {
                document.getElementById('totalEntries').textContent = \`\${allData.length} total alerts logged\`;
            }
        }

        // Initialize
        refreshData();
        setInterval(refreshData, 5000);
    </script>
</body>
</html>`;

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

  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(DASHBOARD_HTML);
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
