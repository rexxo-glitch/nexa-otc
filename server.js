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
function saveOrders(orders) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}
function loadCustomRates() {
  try { return JSON.parse(fs.readFileSync(RATES_FILE, 'utf8')); }
  catch { return null; }
}
function saveCustomRates(rates) {
  fs.writeFileSync(RATES_FILE, JSON.stringify(rates, null, 2));
}

function sendTelegramMessage(text) {
  return new Promise((resolve, reject) => {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return resolve({ ok: false });
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
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ ok: false }); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function adminAuth(req, res, next) {
  const pw = req.headers['x-admin-password'] || req.query.pw;
  if (pw !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
}

// ── PRICE FETCHING (using Binance public API — no key needed, never blocked) ──
let priceCache = null;
let priceCacheTime = 0;
const CACHE_TTL = 30 * 1000;

function fetchJSON(hostname, path) {
  return new Promise((resolve, reject) => {
    const options = { hostname, path, method: 'GET', headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Parse error')); } });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

async function fetchLivePrices() {
  // Binance public API — free, reliable, no API key needed
  const symbols = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'];
  const results = await Promise.all(
    symbols.map(s => fetchJSON('api.binance.com', `/api/v3/ticker/24hr?symbol=${s}`))
  );
  return {
    btc: { price: parseFloat(results[0].lastPrice), change: parseFloat(results[0].priceChangePercent) },
    eth: { price: parseFloat(results[1].lastPrice), change: parseFloat(results[1].priceChangePercent) },
    bnb: { price: parseFloat(results[2].lastPrice), change: parseFloat(results[2].priceChangePercent) },
  };
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
      usdt: { buy: parseFloat(usdtBuy.toFixed(2)),  sell: parseFloat(usdtSell.toFixed(2)), change: 0, unit: 'ETB' },
      btc:  { buy: parseFloat((live.btc.price * (1 + SPREAD)).toFixed(2)), sell: parseFloat((live.btc.price * (1 - SPREAD)).toFixed(2)), change: live.btc.change, unit: 'USD' },
      eth:  { buy: parseFloat((live.eth.price * (1 + SPREAD)).toFixed(2)), sell: parseFloat((live.eth.price * (1 - SPREAD)).toFixed(2)), change: live.eth.change, unit: 'USD' },
      bnb:  { buy: parseFloat((live.bnb.price * (1 + SPREAD)).toFixed(2)), sell: parseFloat((live.bnb.price * (1 - SPREAD)).toFixed(2)), change: live.bnb.change, unit: 'USD' },
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
  const order = { id: 'ORD-' + Date.now(), name: name.trim(), phone: phone.trim(), asset: asset.toUpperCase(), type: type.toLowerCase(), amount: parseFloat(amount), rate: parseFloat(rate) || 0, total: parseFloat(total) || 0, unit: unit || 'ETB', notes: (notes || '').trim(), status: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  orders.unshift(order);
  saveOrders(orders);
  const emoji = order.type === 'buy' ? '🟢' : '🔴';
  const tgText = `${emoji} <b>NEW ${order.type.toUpperCase()} ORDER — NEXA OTC</b>\n\n🪪 <b>Order ID:</b> ${order.id}\n👤 <b>Name:</b> ${order.name}\n📱 <b>Phone:</b> ${order.phone}\n💱 <b>Asset:</b> ${order.asset}\n📊 <b>Amount:</b> ${order.amount} ${order.asset}\n💰 <b>Rate:</b> ${order.rate} ${order.unit}\n🧾 <b>Total:</b> ${order.total.toLocaleString()} ${order.unit}\n${order.notes ? `📝 <b>Notes:</b> ${order.notes}\n` : ''}\n⏰ ${new Date(order.createdAt).toLocaleString('en-ET', { timeZone: 'Africa/Addis_Ababa' })}\n📋 <b>Status:</b> PENDING`;
  try { await sendTelegramMessage(tgText); } catch {}
  res.json({ ok: true, order });
});

app.get('/api/admin/orders', adminAuth, (req, res) => {
  res.json({ ok: true, orders: loadOrders() });
});

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

app.get('/api/admin/rates', adminAuth, (req, res) => {
  res.json({ ok: true, rates: loadCustomRates() });
});

app.post('/api/admin/rates', adminAuth, (req, res) => {
  const { usdtBuy, usdtSell, useCustom } = req.body;
  const rates = { usdtBuy: parseFloat(usdtBuy), usdtSell: parseFloat(usdtSell), useCustom: !!useCustom, updatedAt: new Date().toISOString() };
  saveCustomRates(rates); priceCache = null;
  res.json({ ok: true, rates });
});

app.get('/api/health', (req, res) => res.json({ ok: true, server: 'NEXA OTC Backend', time: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`\n🚀 NEXA OTC Backend running on http://localhost:${PORT}`);
  console.log(`📡 Telegram: ${TG_BOT_TOKEN ? '✅' : '⚠ Not set'}\n`);
});
