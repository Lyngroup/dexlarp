// Signal bot: DexScreener'dan yangi tokenlarni topadi, filtrdan o'tganini Telegram'ga yuboradi.
// FAQAT O'QIYDI. Hech qanday savdo qilmaydi, hech qanday hamyonga ulanmaydi.

const fs = require('fs');
const path = require('path');

// ---------- config.env o'qish (qo'shimcha paket kerak emas) ----------
function loadEnv(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return env;
}

const env = loadEnv(path.join(__dirname, 'config.env'));
// GitHub Actions kabi joylarda sozlamalar config.env o'rniga muhit o'zgaruvchilaridan olinadi
const ENV_KEYS = [
  'BOT_TOKEN', 'CHAT_ID', 'CHAINS', 'POLL_SECONDS', 'MIN_LIQUIDITY_USD',
  'MIN_VOLUME_24H_USD', 'MIN_TXNS_1H', 'MIN_BUY_RATIO', 'MIN_AGE_MINUTES',
  'MAX_AGE_HOURS', 'MAX_PER_CYCLE', 'RUGCHECK_ENABLED', 'RUGCHECK_BLOCK_DANGER',
];
for (const k of ENV_KEYS) {
  if (process.env[k]) env[k] = process.env[k];
}
const num = (key, def) => {
  const v = parseFloat(env[key]);
  return Number.isFinite(v) ? v : def;
};

const BOT_TOKEN = env.BOT_TOKEN || '';
const CHAT_ID = env.CHAT_ID || '';
const CHAINS = (env.CHAINS || 'solana')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const CFG = {
  pollSeconds: Math.max(30, num('POLL_SECONDS', 120)),
  minLiquidityUsd: num('MIN_LIQUIDITY_USD', 10000),
  minVolume24hUsd: num('MIN_VOLUME_24H_USD', 20000),
  minTxns1h: num('MIN_TXNS_1H', 20),
  minBuyRatio: num('MIN_BUY_RATIO', 0.4),
  minAgeMinutes: num('MIN_AGE_MINUTES', 30),
  maxAgeHours: num('MAX_AGE_HOURS', 72),
  maxPerCycle: Math.max(1, num('MAX_PER_CYCLE', 5)),
};

const telegramReady =
  BOT_TOKEN !== '' &&
  CHAT_ID !== '' &&
  !BOT_TOKEN.includes('BU_YERGA') &&
  !CHAT_ID.includes('BU_YERGA');

// ---------- yordamchi funksiyalar ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toLocaleTimeString('en-GB');
const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function fmtUsd(n) {
  if (n == null || !Number.isFinite(n)) return '?';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(0);
}

function fmtPct(n) {
  if (n == null || !Number.isFinite(n)) return '?';
  return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
}

function fmtAge(hours) {
  if (hours == null) return "noma'lum";
  if (hours < 1) return Math.round(hours * 60) + ' daqiqa';
  if (hours < 48) return hours.toFixed(1) + ' soat';
  return (hours / 24).toFixed(1) + ' kun';
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} (${url})`);
  return res.json();
}

// ---------- DexScreener ----------
async function fetchProfiles() {
  const data = await getJson('https://api.dexscreener.com/token-profiles/latest/v1');
  return Array.isArray(data) ? data : [];
}

async function fetchPairs(chain, addresses) {
  const pairs = [];
  for (let i = 0; i < addresses.length; i += 30) {
    const chunk = addresses.slice(i, i + 30);
    const data = await getJson(
      `https://api.dexscreener.com/tokens/v1/${chain}/${chunk.join(',')}`
    );
    if (Array.isArray(data)) pairs.push(...data);
  }
  return pairs;
}

// Har bir token uchun eng katta likvidlikli juftlikni tanlaydi
function bestPairPerToken(pairs) {
  const best = new Map();
  for (const p of pairs) {
    const addr = p.baseToken?.address;
    if (!addr || !p.chainId) continue;
    const key = `${p.chainId}:${addr}`;
    const liq = p.liquidity?.usd ?? 0;
    const cur = best.get(key);
    if (!cur || liq > (cur.liquidity?.usd ?? 0)) best.set(key, p);
  }
  return best;
}

// ---------- RugCheck (faqat Solana) ----------
// Eslatma: bu endpoint rasmiy hujjatdan emas, uchinchi tomon kutubxonasi hujjatidan olingan.
// Javob formati o'zgargan bo'lsa, bot yiqilmaydi, faqat ogohlantirish qo'shadi.
const RUGCHECK = {
  enabled: (env.RUGCHECK_ENABLED || 'true').toLowerCase() !== 'false',
  blockDanger: (env.RUGCHECK_BLOCK_DANGER || 'true').toLowerCase() !== 'false',
};

async function fetchRugcheck(mint) {
  return getJson(
    `https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(mint)}/report/summary`
  );
}

function analyzeRugcheck(data) {
  if (!data || !Array.isArray(data.risks)) return { unknown: true };
  const level = (r) => String(r?.level || '').toLowerCase();
  const label = (r) => String(r?.name || r?.description || '?').slice(0, 60);
  const danger = data.risks.filter((r) => ['danger', 'critical', 'error'].includes(level(r)));
  const warn = data.risks.filter((r) => ['warn', 'warning'].includes(level(r)));
  return {
    unknown: false,
    danger: danger.map(label),
    warn: warn.map(label),
    lpLockedPct: typeof data.lpLockedPct === 'number' ? data.lpLockedPct : null,
  };
}

function rugcheckLines(rc) {
  const lines = [''];
  if (rc.danger.length) {
    lines.push('🚨 RugCheck xavfli deb belgilagan: ' + esc(rc.danger.slice(0, 4).join(', ')));
  }
  if (rc.warn.length) {
    lines.push('⚠️ RugCheck ogohlantirishlari: ' + esc(rc.warn.slice(0, 4).join(', ')));
  }
  if (!rc.danger.length && !rc.warn.length) {
    lines.push('🛡 RugCheck xavfli belgi topmadi (bu xavfsizlik kafolati emas)');
  }
  if (rc.lpLockedPct != null) {
    lines.push(`🔒 Likvidlik qulflangan ulushi: ${rc.lpLockedPct.toFixed(0)}%`);
  }
  return lines;
}

// ---------- filtr ----------
function evaluate(p, now = Date.now()) {
  const liq = p.liquidity?.usd ?? 0;
  const vol24 = p.volume?.h24 ?? 0;
  const buys = p.txns?.h1?.buys ?? 0;
  const sells = p.txns?.h1?.sells ?? 0;
  const tx1h = buys + sells;
  const buyRatio = tx1h > 0 ? buys / tx1h : 0;
  const ageH = p.pairCreatedAt ? (now - p.pairCreatedAt) / 3.6e6 : null;

  const reasons = [];
  if (liq < CFG.minLiquidityUsd) reasons.push('likvidlik past');
  if (vol24 < CFG.minVolume24hUsd) reasons.push('hajm past');
  if (tx1h < CFG.minTxns1h) reasons.push('1 soatlik tranzaksiya kam');
  if (tx1h >= CFG.minTxns1h && buyRatio < CFG.minBuyRatio) reasons.push('sotuvchilar ko‘p');
  if (ageH != null && ageH * 60 < CFG.minAgeMinutes) reasons.push('juda yangi');
  if (ageH != null && ageH > CFG.maxAgeHours) reasons.push('eski');

  const warnings = [];
  if (ageH != null && ageH < 2) warnings.push('Juda yangi token, xavf yuqori.');
  if (tx1h >= CFG.minTxns1h && (sells === 0 || buyRatio > 0.92))
    warnings.push('Deyarli hech kim sotmayapti. Bu honeypot belgisi bo‘lishi mumkin.');
  const fdv = p.fdv ?? p.marketCap;
  if (fdv && liq / fdv < 0.02) warnings.push('Likvidlik narxga nisbatan juda past.');
  const hasSocial = (p.info?.socials?.length ?? 0) + (p.info?.websites?.length ?? 0) > 0;
  if (!hasSocial) warnings.push('Sayt yoki ijtimoiy tarmoq ko‘rsatilmagan.');

  return {
    pass: reasons.length === 0,
    reasons,
    warnings,
    metrics: { liq, vol24, buys, sells, tx1h, buyRatio, ageH, fdv },
  };
}

function formatMessage(p, ev) {
  const m = ev.metrics;
  const sym = esc(p.baseToken?.symbol || '?');
  const name = esc(p.baseToken?.name || '');
  const title = name && name !== sym ? `${sym} (${name})` : sym;
  const lines = [
    `🔔 <b>${title}</b> | ${esc(p.chainId)}`,
    `💵 Narx: $${esc(p.priceUsd ?? '?')}  |  FDV: ${fmtUsd(m.fdv)}`,
    `💧 Likvidlik: ${fmtUsd(m.liq)}  |  📊 Hajm 24s: ${fmtUsd(m.vol24)}`,
    `🕒 Yoshi: ${fmtAge(m.ageH)}`,
    `📈 5d: ${fmtPct(p.priceChange?.m5)}  1s: ${fmtPct(p.priceChange?.h1)}  24s: ${fmtPct(p.priceChange?.h24)}`,
    `🔁 1 soat: ${m.buys} xarid / ${m.sells} sotuv (${Math.round(m.buyRatio * 100)}% xarid)`,
  ];
  if (ev.rugcheck) lines.push(...rugcheckLines(ev.rugcheck));
  if (ev.warnings.length) {
    lines.push('', ...ev.warnings.map((w) => '⚠️ ' + esc(w)));
  }
  lines.push(
    '',
    `<code>${esc(p.baseToken?.address || '')}</code>`,
    esc(p.url || ''),
    '',
    'ℹ️ Bu moliyaviy maslahat emas. DexScreener rug-pull tekshirmaydi, tokenni o‘zing ham tekshir.'
  );
  return lines.join('\n');
}

// ---------- Telegram ----------
async function sendTelegram(text) {
  if (!telegramReady) {
    console.log('\n----- (Telegram sozlanmagan, konsolga chiqarildi) -----');
    console.log(text.replace(/<[^>]+>/g, ''));
    console.log('------------------------------------------------------\n');
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram xato ${res.status}: ${body}`);
  }
}

// ---------- ko'rilgan tokenlar ----------
const SEEN_FILE = path.join(__dirname, 'seen.json');
let seen = new Set();
try {
  if (fs.existsSync(SEEN_FILE)) seen = new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')));
} catch {
  seen = new Set();
}
function saveSeen() {
  const arr = [...seen].slice(-5000);
  fs.writeFileSync(SEEN_FILE, JSON.stringify(arr));
}

// ---------- asosiy sikl ----------
async function cycle() {
  const profiles = await fetchProfiles();
  const wanted = {};
  for (const pr of profiles) {
    const chain = String(pr.chainId || '').toLowerCase();
    if (!CHAINS.includes(chain) || !pr.tokenAddress) continue;
    if (seen.has(`${chain}:${pr.tokenAddress}`)) continue;
    (wanted[chain] ||= []).push(pr.tokenAddress);
  }

  let checked = 0;
  let sent = 0;
  let blocked = 0;
  for (const [chain, addresses] of Object.entries(wanted)) {
    const pairs = await fetchPairs(chain, addresses);
    const best = bestPairPerToken(pairs);
    for (const [key, p] of best) {
      checked++;
      if (sent >= CFG.maxPerCycle) break;
      const ev = evaluate(p);
      if (!ev.pass) continue;

      if (RUGCHECK.enabled && chain === 'solana') {
        try {
          const rc = analyzeRugcheck(await fetchRugcheck(p.baseToken.address));
          if (rc.unknown) {
            ev.warnings.push('RugCheck javobi o‘qilmadi, tokenni o‘zing tekshir.');
          } else if (rc.danger.length && RUGCHECK.blockDanger) {
            seen.add(key);
            blocked++;
            console.log(
              `[${ts()}] RugCheck xavfli deb topdi, o'tkazib yuborildi: ${p.baseToken?.symbol} (${rc.danger.join(', ')})`
            );
            continue;
          } else {
            ev.rugcheck = rc;
          }
        } catch (e) {
          console.log(`[${ts()}] RugCheck xato: ${e.message}`);
          ev.warnings.push('RugCheck tekshiruvi ishlamadi, tokenni o‘zing tekshir.');
        }
        await sleep(500);
      }

      await sendTelegram(formatMessage(p, ev));
      seen.add(key);
      sent++;
      await sleep(1000);
    }
  }
  if (sent || blocked) saveSeen();
  console.log(
    `[${ts()}] Tekshirildi: ${checked}, yuborildi: ${sent}` +
      (blocked ? `, RugCheck bloklagan: ${blocked}` : '')
  );
}

// Bir marta tekshirib to'xtaydi (GitHub Actions jadvali uchun)
async function runOnce() {
  try {
    await cycle();
  } catch (e) {
    console.log(`[${ts()}] Xato: ${e.message}`);
  }
  saveSeen(); // seen.json har doim mavjud bo'lsin (keshga saqlash uchun)
}

async function main() {
  if (process.argv[2] === 'once') {
    await runOnce();
    process.exit(0);
  }

  if (process.argv[2] === 'test') {
    try {
      await sendTelegram('✅ Test: bot Telegram bilan ishlayapti.');
      console.log(
        telegramReady
          ? 'Test xabari yuborildi. Telegramni tekshir.'
          : "Telegram sozlanmagan. config.env ichida BOT_TOKEN va CHAT_ID ni to'ldir."
      );
    } catch (e) {
      console.log('Xato: ' + e.message);
    }
    return;
  }

  if (process.argv[2] === 'rugcheck') {
    const mint = process.argv[3];
    if (!mint) {
      console.log('Ishlatish: node bot.js rugcheck TOKEN_MANZILI');
      return;
    }
    try {
      const raw = await fetchRugcheck(mint);
      console.log('Tahlil:', JSON.stringify(analyzeRugcheck(raw), null, 2));
      console.log('\nXom javob (birinchi 1500 belgi):');
      console.log(JSON.stringify(raw, null, 2).slice(0, 1500));
    } catch (e) {
      console.log('Xato: ' + e.message);
    }
    return;
  }

  console.log('Signal bot ishga tushdi.');
  console.log(`Tarmoqlar: ${CHAINS.join(', ')} | har ${CFG.pollSeconds} soniyada tekshiradi`);
  console.log(
    telegramReady
      ? 'Telegram: ulangan'
      : "Telegram: SOZLANMAGAN (signallar shu oynaga chiqadi). config.env ni to'ldir."
  );
  console.log('To‘xtatish uchun: Ctrl+C\n');

  if (telegramReady) {
    await sendTelegram('✅ Signal bot ishga tushdi.').catch((e) => console.log(e.message));
  }

  while (true) {
    try {
      await cycle();
    } catch (e) {
      console.log(`[${ts()}] Xato: ${e.message}`);
      if (/429/.test(e.message)) await sleep(60000);
    }
    await sleep(CFG.pollSeconds * 1000);
  }
}

module.exports = { evaluate, formatMessage, fmtUsd, bestPairPerToken, analyzeRugcheck, cycle, runOnce, CFG };

if (require.main === module) main();
