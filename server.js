// ═══════════════════════════════════════════════════════════════
//  NEXA OTC — Backend Server
//  Node.js + Express
//  Features: Live prices proxy, Order storage, Telegram alerts,
//            Admin panel API
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const fs       = require('fs');
const path     = require('path');
const https    = require('https');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── CONFIG ─────────────────────────────────────────────────────
const PORT           = process.env.PORT || 3000;
const TG_BOT_TOKEN   = process.env.TG_BOT_TOKEN   || '';   // Set in .env
const TG_CHAT_ID     = process.env.TG_CHAT_ID     || '';   // Set in .env
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'nexa2024admin'; // Change in .env
const ORDERS_FILE    = path.join(__dirname, 'data', 'orders.json');

// ── DATA STORAGE ────────────────────────────────────────────────
// Ensures data directory and orders file exist
function ensureDataDir() {
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, '[]');
}
ensureDataDir();

function loadOrders() {
  try { return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8')); }
  catch { return []; }
}

function saveOrders(orders) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

// ── TELEGRAM SENDER ─────────────────────────────────────────────
function sendTelegramMessage(text) {
  return new Promise((resolve, reject) => {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
      console.warn('⚠  Telegram not configured — skipping notification.');
      return resolve({ ok: false, reason: 'not_configured' });
    }
    const body = JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML' });
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${TG_BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ ok: false }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── CUSTOM RATES STORAGE ────────────────────────────────────────
const RATES_FILE = path.join(__dirname, 'data', 'rates.json');

function loadCustomRates() {
  try { return JSON.parse(fs.readFileSync(RATES_FILE, 'utf8')); }
  catch { return null; }
}

function saveCustomRates(rates) {
  fs.writeFileSync(RATES_FILE, JSON.stringify(rates, null, 2));
}

// GET /api/admin/rates — Get custom rates
app.get('/api/admin/rates', adminAuth, (req, res) => {
  const rates = loadCustomRates();
  res.json({ ok: true, rates });
});

// POST /api/admin/rates — Save custom rates
app.post('/api/admin/rates', adminAuth, (req, res) => {
  const { usdtBuy, usdtSell, useCustom } = req.body;
  const rates = { usdtBuy: parseFloat(usdtBuy), usdtSell: parseFloat(usdtSell), useCustom: !!useCustom, updatedAt: new Date().toISOString() };
  saveCustomRates(rates);
  priceCache = null; // clear cache so next fetch uses new rates
  res.json({ ok: true, rates });
});

// ── PRICE CACHE ─────────────────────────────────────────────────
let priceCache = null;
let priceCacheTime = 0;
const CACHE_TTL = 30 * 1000; // 30 seconds

async function fetchLivePrices() {
  return new Promise((resolve, reject) => {
    const url = '/api/v3/simple/price?ids=bitcoin,ethereum,binancecoin,tether&vs_currencies=usd,etb&include_24hr_change=true';
    const options = { hostname: 'api.coingecko.com', path: url, method: 'GET',
      headers: { 'Accept': 'application/json', 'User-Agent': 'NEXA-OTC/1.0' } };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Parse error')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ── API ROUTES ──────────────────────────────────────────────────

// GET /api/prices — Returns live prices (cached 30s)
app.get('/api/prices', async (req, res) => {
  const now = Date.now();
  if (priceCache && (now - priceCacheTime) < CACHE_TTL) {
    return res.json({ ok: true, cached: true, data: priceCache });
  }
  try {
    const raw = await fetchLivePrices();
    const SPREAD = 0.005;
    const etbRate = raw.tether?.etb ?? 125;
    // Check if admin has set custom rates
    const customRates = loadCustomRates();
    const useCustom = customRates && customRates.useCustom;
    const usdtBuy  = useCustom ? customRates.usdtBuy  : parseFloat((etbRate * (1 + SPREAD)).toFixed(2));
    const usdtSell = useCustom ? customRates.usdtSell : parseFloat((etbRate * (1 - SPREAD)).toFixed(2));

    priceCache = {
      usdt: {
        buy:  usdtBuy,
        sell: usdtSell,
        change: raw.tether?.usd_24h_change ?? 0,
        unit: 'ETB'
      },
      btc: {
        buy:  parseFloat((raw.bitcoin?.usd * (1 + SPREAD)).toFixed(2)),
        sell: parseFloat((raw.bitcoin?.usd * (1 - SPREAD)).toFixed(2)),
        change: raw.bitcoin?.usd_24h_change ?? 0,
        unit: 'USD'
      },
      eth: {
        buy:  parseFloat((raw.ethereum?.usd * (1 + SPREAD)).toFixed(2)),
        sell: parseFloat((raw.ethereum?.usd * (1 - SPREAD)).toFixed(2)),
        change: raw.ethereum?.usd_24h_change ?? 0,
        unit: 'USD'
      },
      bnb: {
        buy:  parseFloat((raw.binancecoin?.usd * (1 + SPREAD)).toFixed(2)),
        sell: parseFloat((raw.binancecoin?.usd * (1 - SPREAD)).toFixed(2)),
        change: raw.binancecoin?.usd_24h_change ?? 0,
        unit: 'USD'
      },
      etbRate,
      fetchedAt: new Date().toISOString()
    };
    priceCacheTime = now;
    res.json({ ok: true, cached: false, data: priceCache });
  } catch (err) {
    console.error('Price fetch error:', err.message);
    if (priceCache) return res.json({ ok: true, cached: true, stale: true, data: priceCache });
    res.status(503).json({ ok: false, error: 'Price service unavailable' });
  }
});

// POST /api/orders — Submit a new trade order
app.post('/api/orders', async (req, res) => {
  const { name, phone, asset, type, amount, rate, total, unit, notes } = req.body;

  if (!name || !phone || !asset || !type || !amount) {
    return res.status(400).json({ ok: false, error: 'Missing required fields' });
  }

  const orders = loadOrders();
  const order = {
    id:        'ORD-' + Date.now(),
    name:      name.trim(),
    phone:     phone.trim(),
    asset:     asset.toUpperCase(),
    type:      type.toLowerCase(), // 'buy' | 'sell'
    amount:    parseFloat(amount),
    rate:      parseFloat(rate) || 0,
    total:     parseFloat(total) || 0,
    unit:      unit || 'ETB',
    notes:     (notes || '').trim(),
    status:    'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  orders.unshift(order);
  saveOrders(orders);

  // ── Build Telegram notification ──
  const emoji = order.type === 'buy' ? '🟢' : '🔴';
  const typeLabel = order.type === 'buy' ? 'BUY' : 'SELL';
  const tgText =
`${emoji} <b>NEW ${typeLabel} ORDER — NEXA OTC</b>

🪪 <b>Order ID:</b> ${order.id}
👤 <b>Name:</b> ${order.name}
📱 <b>Phone:</b> ${order.phone}
💱 <b>Asset:</b> ${order.asset}
📊 <b>Amount:</b> ${order.amount} ${order.asset}
💰 <b>Rate:</b> ${order.rate} ${order.unit}/${order.asset}
🧾 <b>Total:</b> ${order.total.toLocaleString()} ${order.unit}
${order.notes ? `📝 <b>Notes:</b> ${order.notes}` : ''}

⏰ ${new Date(order.createdAt).toLocaleString('en-ET', { timeZone: 'Africa/Addis_Ababa' })}
📋 <b>Status:</b> PENDING — Please respond on Telegram.`;

  try {
    await sendTelegramMessage(tgText);
  } catch (tgErr) {
    console.error('Telegram send error:', tgErr.message);
  }

  res.json({ ok: true, order });
});

// ── ADMIN ROUTES (protected by password) ────────────────────────

function adminAuth(req, res, next) {
  const pw = req.headers['x-admin-password'] || req.query.pw;
  if (pw !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
}

// GET /api/admin/orders — List all orders
app.get('/api/admin/orders', adminAuth, (req, res) => {
  const orders = loadOrders();
  res.json({ ok: true, count: orders.length, orders });
});

// PATCH /api/admin/orders/:id — Update order status
app.patch('/api/admin/orders/:id', adminAuth, (req, res) => {
  const { id } = req.params;
  const { status, adminNote } = req.body;
  const validStatuses = ['pending', 'confirmed', 'completed', 'cancelled'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ ok: false, error: 'Invalid status' });
  }
  const orders = loadOrders();
  const idx = orders.findIndex(o => o.id === id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Order not found' });

  orders[idx].status    = status;
  orders[idx].updatedAt = new Date().toISOString();
  if (adminNote) orders[idx].adminNote = adminNote;
  saveOrders(orders);

  // Notify admin on Telegram about status change
  const o = orders[idx];
  const statusEmoji = { pending:'⏳', confirmed:'✅', completed:'🏆', cancelled:'❌' }[status] || '🔄';
  sendTelegramMessage(
    `${statusEmoji} <b>Order Updated</b>\n\n` +
    `ID: ${o.id}\nName: ${o.name}\nAsset: ${o.asset}\nType: ${o.type.toUpperCase()}\n` +
    `Amount: ${o.amount} ${o.asset}\n\n<b>New Status: ${status.toUpperCase()}</b>`
  ).catch(() => {});

  res.json({ ok: true, order: orders[idx] });
});

// DELETE /api/admin/orders/:id — Delete an order
app.delete('/api/admin/orders/:id', adminAuth, (req, res) => {
  let orders = loadOrders();
  const idx = orders.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Not found' });
  const deleted = orders[idx];
  orders.splice(idx, 1);
  saveOrders(orders);
  res.json({ ok: true, deleted });
});

// GET /api/admin/stats — Dashboard stats
app.get('/api/admin/stats', adminAuth, (req, res) => {
  const orders = loadOrders();
  const stats = {
    total:     orders.length,
    pending:   orders.filter(o => o.status === 'pending').length,
    confirmed: orders.filter(o => o.status === 'confirmed').length,
    completed: orders.filter(o => o.status === 'completed').length,
    cancelled: orders.filter(o => o.status === 'cancelled').length,
    buyCount:  orders.filter(o => o.type === 'buy').length,
    sellCount: orders.filter(o => o.type === 'sell').length,
    recentOrders: orders.slice(0, 5)
  };
  res.json({ ok: true, stats });
});

// ── HEALTH CHECK ─────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, server: 'NEXA OTC Backend', time: new Date().toISOString() });
});

// ── START ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 NEXA OTC Backend running on http://localhost:${PORT}`);
  console.log(`📋 Admin panel:  http://localhost:${PORT}/admin.html`);
  console.log(`🔑 Admin pass:   ${ADMIN_PASSWORD}`);
  console.log(`📡 Telegram bot: ${TG_BOT_TOKEN ? '✅ Configured' : '⚠ Not set — edit .env'}\n`);
});
