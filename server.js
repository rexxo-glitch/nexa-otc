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

const PORT           = process.env.PORT || 3000;
const TG_BOT_TOKEN   = process.env.TG_BOT_TOKEN   || '';
const TG_CHAT_ID     = process.env.TG_CHAT_ID     || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'nexa2024admin';
const ORDERS_FILE    = path.join(__dirname, 'data', 'orders.json');
const RATES_FILE     = path.join(__dirname, 'data', 'rates.json');

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
function saveOrders(o) { fs.writeFileSync(ORDERS_FILE, JSON.stringify(o, null, 2)); }
function loadCustomRates() {
  try { return JSON.parse(fs.readFileSync(RATES_FILE, 'utf8')); }
  catch { return null; }
}
function saveCustomRates(r) { fs.writeFileSync(RATES_FILE, JSON.stringify(r, null, 2)); }

function sendTelegramMessage(text) {
  return new Promise((resolve, reject) => {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return resolve({ ok: false });
    const body = JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML' });
    const options = { hostname: 'api.telegram.org', path: `/bot${TG_BOT_TOKEN}/sendMessage`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ ok: false }); } });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

function adminAuth(req, res, next) {
  const pw = req.headers['x-admin-password'] || req.query.pw;
  if (pw !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
}

// ── PRICE FETCHING ──────────────────────────────────────────────
let priceCache = null;
let priceCacheTime = 0;
const CACHE_TTL = 60 * 1000; // 60 seconds

function fetchJSON(hostname, urlPath, headers) {
  return new Promise((resolve, reject) => {
    const options = { hostname, path: urlPath, method: 'GET', headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', ...(headers || {}) } };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Parse error')); } });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// Try CoinCap API (very reliable, no key needed)
async function fetchFromCoinCap() {
  const ids = ['bitcoin', 'ethereum', 'binance-coin'];
  const results = await Promise.all(ids.map(id => fetchJSON('api.coincap.io', `/v2/assets/${id}`)));
  return {
    btc: { price: parseFloat(results[0].data.priceUsd), change: parseFloat(results[0].data.changePercent24Hr) },
    eth: { price: parseFloat(results[1].data.priceUsd), change: parseFloat(results[1].data.changePercent24Hr) },
    bnb: { price: parseFloat(results[2].data.priceUsd), change: parseFloat(results[2].data.changePercent24Hr) },
  };
}

// Try Kraken as backup
async function fetchFromKraken() {
  const pairs = { btc: 'XBTUSD', eth: 'ETHUSD', bnb: 'BNBUSD' };
  const [btcData, ethData] = await Promise.all([
    fetchJSON('api.kraken.com', '/0/public/Ticker?pair=XBTUSD'),
    fetchJSON('api.kraken.com', '/0/public/Ticker?pair=ETHUSD'),
  ]);
  const btcPrice = parseFloat(Object.values(btcData.result)[0].c[0]);
  const ethPrice = parseFloat(Object.values(ethData.result)[0].c[0]);
  return {
    btc: { price: btcPrice, change: 0 },
    eth: { price: ethPrice, change: 0 },
    bnb: { price: 650, change: 0 }, // fallback for BNB
  };
}

async function fetchLivePrices() {
  try {
    console.log('Trying CoinCap...');
    const data = await fetchFromCoinCap();
    if (data.btc.price > 0) { console.log('CoinCap OK, BTC:', data.btc.price); return data; }
    throw new Error('Invalid data');
  } catch(e) {
    console.log('CoinCap failed:', e.message, '— trying Kraken...');
    try {
      const data = await fetchFromKraken();
      if (data.btc.price > 0) { console.log('Kraken OK, BTC:', data.btc.price); return data; }
      throw new Error('Invalid data');
    } catch(e2) {
      console.log('Kraken failed:', e2.message, '— using fallback prices');
      return { btc: { price: 105000, change: 0 }, eth: { price: 2500, change: 0 }, bnb: { price: 650, change: 0 } };
    }
  }
}

app.get('/api/prices', async (req, res) => {
  const now = Date.now();
  if (priceCache && (now - priceCacheTime) < CACHE_TTL) return res.json({ ok: true, cached: true, data: priceCache });
  try {
    const live = await fetchLivePrices();
    const SPREAD = 0.005;
    const customRates = loadCustomRates();
    const useCustom = customRates && customRates.useCustom;
    const defaultEtb = 184;
    const usdtBuy  = useCustom ? customRates.usdtBuy  : defaultEtb * (1 + SPREAD);
    const usdtSell = useCustom ? customRates.usdtSell : defaultEtb * (1 - SPREAD);
    priceCache = {
      usdt: { buy: parseFloat(usdtBuy.toFixed(2)), sell: parseFloat(usdtSell.toFixed(2)), change: 0, unit: 'ETB' },
      btc:  { buy: parseFloat((live.btc.price * (1 + SPREAD)).toFixed(2)), sell: parseFloat((live.btc.price * (1 - SPREAD)).toFixed(2)), change: parseFloat(live.btc.change.toFixed(2)), unit: 'USD' },
      eth:  { buy: parseFloat((live.eth.price * (1 + SPREAD)).toFixed(2)), sell: parseFloat((live.eth.price * (1 - SPREAD)).toFixed(2)), change: parseFloat(live.eth.change.toFixed(2)), unit: 'USD' },
      bnb:  { buy: parseFloat((live.bnb.price * (1 + SPREAD)).toFixed(2)), sell: parseFloat((live.bnb.price * (1 - SPREAD)).toFixed(2)), change: parseFloat(live.bnb.change.toFixed(2)), unit: 'USD' },
      etbRate: useCustom ? customRates.usdtBuy : defaultEtb,
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

app.post('/api/orders', async (req, res) => {
  const { name, phone, asset, type, amount, rate, total, unit, notes } = req.body;
  if (!name || !phone || !asset || !type || !amount) return res.status(400).json({ ok: false, error: 'Missing required fields' });
  const orders = loadOrders();
  const order = { id: 'ORD-' + Date.now(), name: name.trim(), phone: phone.trim(), telegram: (req.body.telegram || '').trim(), asset: asset.toUpperCase(), type: type.toLowerCase(), amount: parseFloat(amount), rate: parseFloat(rate) || 0, total: parseFloat(total) || 0, unit: unit || 'ETB', notes: (notes || '').trim(), status: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  orders.unshift(order); saveOrders(orders);
  const emoji = order.type === 'buy' ? '🟢' : '🔴';
  const tgText = `${emoji} <b>NEW ${order.type.toUpperCase()} ORDER — NEXA OTC</b>\n\n🪪 <b>Order ID:</b> ${order.id}\n👤 <b>Name:</b> ${order.name}\n📱 <b>Phone:</b> ${order.phone}\n✈️ <b>Telegram:</b> @${order.telegram}\n💱 <b>Asset:</b> ${order.asset}\n📊 <b>Amount:</b> ${order.amount} ${order.asset}\n💰 <b>Rate:</b> ${order.rate} ${order.unit}\n🧾 <b>Total:</b> ${order.total.toLocaleString()} ${order.unit}\n${order.notes ? `📝 <b>Notes:</b> ${order.notes}\n` : ''}\n⏰ ${new Date(order.createdAt).toLocaleString('en-ET', { timeZone: 'Africa/Addis_Ababa' })}\n📋 <b>Status:</b> PENDING`;
  try { await sendTelegramMessage(tgText); } catch {}
  res.json({ ok: true, order });
});

app.get('/api/admin/orders', adminAuth, (req, res) => res.json({ ok: true, orders: loadOrders() }));

app.patch('/api/admin/orders/:id', adminAuth, (req, res) => {
  const { status, adminNote } = req.body;
  if (!['pending','confirmed','completed','cancelled'].includes(status)) return res.status(400).json({ ok: false, error: 'Invalid status' });
  const orders = loadOrders();
  const idx = orders.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Not found' });
  orders[idx].status = status; orders[idx].updatedAt = new Date().toISOString();
  if (adminNote) orders[idx].adminNote = adminNote;
  saveOrders(orders);
  res.json({ ok: true, order: orders[idx] });
});

app.delete('/api/admin/orders/:id', adminAuth, (req, res) => {
  let orders = loadOrders();
  const idx = orders.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Not found' });
  orders.splice(idx, 1); saveOrders(orders);
  res.json({ ok: true });
});

app.get('/api/admin/stats', adminAuth, (req, res) => {
  const orders = loadOrders();
  res.json({ ok: true, stats: { total: orders.length, pending: orders.filter(o=>o.status==='pending').length, confirmed: orders.filter(o=>o.status==='confirmed').length, completed: orders.filter(o=>o.status==='completed').length, cancelled: orders.filter(o=>o.status==='cancelled').length } });
});

app.get('/api/admin/rates', adminAuth, (req, res) => res.json({ ok: true, rates: loadCustomRates() }));

app.post('/api/admin/rates', adminAuth, (req, res) => {
  const { usdtBuy, usdtSell, useCustom } = req.body;
  const rates = { usdtBuy: parseFloat(usdtBuy), usdtSell: parseFloat(usdtSell), useCustom: !!useCustom, updatedAt: new Date().toISOString() };
  saveCustomRates(rates); priceCache = null;
  res.json({ ok: true, rates });
});

const LIMITS_FILE = path.join(__dirname, 'data', 'limits.json');
function loadLimits() {
  try { return JSON.parse(fs.readFileSync(LIMITS_FILE, 'utf8')); }
  catch { return { usdt: { min: 10, max: 50000 }, btc: { min: 0.0001, max: 10 }, eth: { min: 0.01, max: 100 }, bnb: { min: 0.1, max: 500 } }; }
}
function saveLimits(l) { fs.writeFileSync(LIMITS_FILE, JSON.stringify(l, null, 2)); }

app.get('/api/limits', (req, res) => res.json({ ok: true, limits: loadLimits() }));

app.post('/api/admin/limits', adminAuth, (req, res) => {
  const limits = req.body;
  saveLimits(limits);
  res.json({ ok: true, limits });
});

app.get('/api/admin/limits', adminAuth, (req, res) => res.json({ ok: true, limits: loadLimits() }));

app.listen(PORT, () => {
  console.log(`\n🚀 NEXA OTC Backend running on http://localhost:${PORT}`);
  console.log(`📡 Telegram: ${TG_BOT_TOKEN ? '✅' : '⚠ Not set'}\n`);
});
