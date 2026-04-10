const pairs = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];

async function fetchPrice(symbol) {
  const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
  const data = await res.json();
  return parseFloat(data.price);
}

function analyze(price) {
  const random = Math.random();

  if (random > 0.6) return "BUY";
  if (random < 0.4) return "SELL";
  return "WAIT";
}

function calculateTrade(price, signal) {
  let entry = price;
  let tp, sl;

  if (signal === "BUY") {
    tp = price * 1.02;
    sl = price * 0.99;
  } else if (signal === "SELL") {
    tp = price * 0.98;
    sl = price * 1.01;
  }

  let rr = tp && sl ? ((Math.abs(tp - entry) / Math.abs(entry - sl))).toFixed(2) : "-";

  return { entry, tp, sl, rr };
}

async function updateSignals() {
  const table = document.getElementById("signals");
  table.innerHTML = "";

  for (let pair of pairs) {
    const price = await fetchPrice(pair);
    const signal = analyze(price);
    const trade = calculateTrade(price, signal);

    const row = `
      <tr>
        <td>${pair}</td>
        <td>${price.toFixed(2)}</td>
        <td class="${signal.toLowerCase()}">${signal}</td>
        <td>${trade.entry?.toFixed(2) || "-"}</td>
        <td>${trade.tp?.toFixed(2) || "-"}</td>
        <td>${trade.sl?.toFixed(2) || "-"}</td>
        <td>${trade.rr}</td>
      </tr>
    `;

    table.innerHTML += row;
  }

  document.getElementById("status").innerText = "🟢 Mercado actualizado";
}

setInterval(updateSignals, 20000);
updateSignals();
