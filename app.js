const pairs = ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT"];

async function fetchKlines(symbol, interval="15m") {
  const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=100`);
  const data = await res.json();
  return data.map(c => parseFloat(c[4]));
}

function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function calculateRSI(prices, period=14) {
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

function getSupportResistance(prices) {
  return {
    support: Math.min(...prices.slice(-20)),
    resistance: Math.max(...prices.slice(-20))
  };
}

function calculateVolatility(prices) {
  let changes = [];
  for (let i = 1; i < prices.length; i++) {
    let change = Math.abs((prices[i] - prices[i - 1]) / prices[i - 1]) * 100;
    changes.push(change);
  }
  return changes.reduce((a, b) => a + b, 0) / changes.length;
}

function getBestTimeframe(volatility) {
  if (volatility < 0.5) return {trendTF:"1D", entryTF:"1H"};
  if (volatility < 1.5) return {trendTF:"4H", entryTF:"15m"};
  return {trendTF:"1H", entryTF:"5m"};
}

function getSignal({trend, rsi, price, support, resistance}) {
  if (rsi > 45 && rsi < 55) return { signal: "WAIT" };
  if (trend==="UP" && rsi < 35 && price <= support*1.01) return { signal:"BUY" };
  if (trend==="DOWN" && rsi > 65 && price >= resistance*0.99) return { signal:"SELL" };
  return { signal:"WAIT" };
}

function calculateTrade(price, signal) {
  let entry = price, tp=null, sl=null;
  if (signal==="BUY") { tp = price*1.01; sl = price*0.995; }
  if (signal==="SELL") { tp = price*0.99; sl = price*1.005; }
  let rr = (tp && sl) ? (Math.abs(tp-entry)/Math.abs(entry-sl)).toFixed(2) : "-";
  return {entry,tp,sl,rr};
}

function explain(signal) {
  if (signal==="BUY") return "Compra segura basada en tendencia + soporte + RSI bajo";
  if (signal==="SELL") return "Venta segura basada en tendencia + resistencia + RSI alto";
  return "No operar: mercado sin claridad";
}

async function analyze(symbol) {
  const prices15 = await fetchKlines(symbol,"15m");
  const prices4h = await fetchKlines(symbol,"4h");

  const price = prices15[prices15.length-1];
  const ema50 = calculateEMA(prices4h,50);
  const ema200 = calculateEMA(prices4h,200);
  const rsi = calculateRSI(prices15);

  const trend = ema50 > ema200 ? "UP" : "DOWN";
  const {support,resistance} = getSupportResistance(prices15);

  const volatility = calculateVolatility(prices15);
  const tf = getBestTimeframe(volatility);

  const signalObj = getSignal({trend,rsi,price,support,resistance});

  return {price, signal: signalObj.signal, trend, rsi, tf};
}

async function updateSignals() {
  const table = document.getElementById("signals");
  table.innerHTML="";

  for (let pair of pairs) {
    const result = await analyze(pair);
    const trade = calculateTrade(result.price, result.signal);
    const exp = explain(result.signal);

    const row = `
    <tr>
      <td>${pair}</td>
      <td>${result.price.toFixed(2)}</td>
      <td class="${result.signal.toLowerCase()}">${result.signal}</td>
      <td>${result.tf.trendTF}</td>
      <td>${result.tf.entryTF}</td>
      <td>${trade.entry?.toFixed(2)||"-"}</td>
      <td>${trade.tp?.toFixed(2)||"-"}</td>
      <td>${trade.sl?.toFixed(2)||"-"}</td>
      <td>${trade.rr}</td>
      <td>${exp}</td>
    </tr>`;

    table.innerHTML += row;
  }

  document.getElementById("status").innerText="🟢 Mercado actualizado";
}

setInterval(updateSignals,30000);
updateSignals();
