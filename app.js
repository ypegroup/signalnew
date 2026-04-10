/* ========================================
   CRYPE - Lógica principal de la aplicación
   Análisis de criptomonedas en tiempo real
   ======================================== */

// ==================== CONFIGURACIÓN ====================
const CONFIG = {
    pairs: [
        { symbol: 'BTCUSDT', name: 'Bitcoin', short: 'BTC', emoji: '₿' },
        { symbol: 'ETHUSDT', name: 'Ethereum', short: 'ETH', emoji: '⟠' },
        { symbol: 'SOLUSDT', name: 'Solana', short: 'SOL', emoji: '◎' },
        { symbol: 'BNBUSDT', name: 'BNB', short: 'BNB', emoji: '🔶' }
    ],
    baseUrl: 'https://api.binance.com/api/v3',
    updateInterval: 30, // segundos
    emaShort: 50,
    emaLong: 200,
    rsiPeriod: 14,
    rsiBuyThreshold: 35,
    rsiSellThreshold: 65,
    rsiNoTradeLow: 45,
    rsiNoTradeHigh: 55,
    srPeriod: 20,
    tpPercent: 0.01,      // 1%
    slPercent: 0.005,      // 0.5%
    volatilityLow: 1.5,    // % std dev
    volatilityHigh: 3.5
};

// ==================== ESTADO GLOBAL ====================
let state = {
    signals: [],
    lastUpdate: null,
    isAnalyzing: false,
    countdown: CONFIG.updateInterval,
    countdownInterval: null,
    globalVolatility: null,
    globalTimeframe: null
};

// ==================== FUNCIONES API ====================

async function fetchKlines(symbol, interval, limit = 200) {
    try {
        const url = `${CONFIG.baseUrl}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        return data.map(k => ({
            openTime: k[0],
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5]),
            closeTime: k[6]
        }));
    } catch (error) {
        console.error(`Error fetching klines ${symbol} ${interval}:`, error);
        return null;
    }
}

async function fetch24hrTicker(symbol) {
    try {
        const url = `${CONFIG.baseUrl}/ticker/24hr?symbol=${symbol}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } catch (error) {
        console.error(`Error fetching ticker ${symbol}:`, error);
        return null;
    }
}

// ==================== CÁLCULOS TÉCNICOS ====================

function calculateEMA(closes, period) {
    if (closes.length < period) return null;

    // SMA inicial
    let ema = 0;
    for (let i = 0; i < period; i++) {
        ema += closes[i];
    }
    ema = ema / period;

    const multiplier = 2 / (period + 1);

    for (let i = period; i < closes.length; i++) {
        ema = (closes[i] - ema) * multiplier + ema;
    }

    return ema;
}

function calculateRSI(closes, period = 14) {
    if (closes.length < period + 1) return null;

    let gains = 0;
    let losses = 0;

    // Primer promedio
    for (let i = 1; i <= period; i++) {
        const change = closes[i] - closes[i - 1];
        if (change > 0) {
            gains += change;
        } else {
            losses += Math.abs(change);
        }
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    // Promedios posteriores
    for (let i = period + 1; i < closes.length; i++) {
        const change = closes[i] - closes[i - 1];
        if (change > 0) {
            avgGain = (avgGain * (period - 1) + change) / period;
            avgLoss = (avgLoss * (period - 1)) / period;
        } else {
            avgGain = (avgGain * (period - 1)) / period;
            avgLoss = (avgLoss * (period - 1) + Math.abs(change)) / period;
        }
    }

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

function calculateSupportResistance(klines, period = 20) {
    const recent = klines.slice(-period);
    const support = Math.min(...recent.map(k => k.low));
    const resistance = Math.max(...recent.map(k => k.high));
    return { support, resistance };
}

function calculateVolatility(klines) {
    if (!klines || klines.length < 2) return null;

    const closes = klines.map(k => k.close);
    const returns = [];

    for (let i = 1; i < closes.length; i++) {
        returns.push((closes[i] - closes[i - 1]) / closes[i - 1] * 100);
    }

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / returns.length;
    return Math.sqrt(variance);
}

// ==================== DETERMINAR TEMPORALIDAD ====================

function determineTimeframes(volatility) {
    if (volatility < CONFIG.volatilityLow) {
        return {
            trendInterval: '1D',
            entryInterval: '1H',
            trendLabel: 'Diario',
            entryLabel: 'Cada hora',
            level: 'Tranquilo',
            description: 'El mercado se mueve despacio'
        };
    } else if (volatility < CONFIG.volatilityHigh) {
        return {
            trendInterval: '4H',
            entryInterval: '15m',
            trendLabel: 'Cada 4 horas',
            entryLabel: 'Cada 15 minutos',
            level: 'Moderado',
            description: 'El mercado tiene movimiento normal'
        };
    } else {
        return {
            trendInterval: '1H',
            entryInterval: '5m',
            trendLabel: 'Cada hora',
            entryLabel: 'Cada 5 minutos',
            level: 'Activo',
            description: 'El mercado se mueve mucho'
        };
    }
}

// ==================== GENERADOR DE SEÑALES ====================

function generateSignal(pairConfig, trendKlines, entryKlines, tickerData) {
    const result = {
        pair: pairConfig,
        price: 0,
        change24h: 0,
        signal: 'wait',
        signalLabel: 'Esperar',
        confidence: 'low',
        confidenceLabel: 'Baja',
        entry: 0,
        takeProfit: 0,
        stopLoss: 0,
        riskReward: 0,
        explanation: 'Sin datos suficientes',
        ema50: null,
        ema200: null,
        rsi: null,
        support: null,
        resistance: null,
        trend: null,
        timeframe: null
    };

    // Datos del ticker
    if (tickerData) {
        result.price = parseFloat(tickerData.lastPrice);
        result.change24h = parseFloat(tickerData.priceChangePercent);
    }

    if (!trendKlines || !entryKlines || !tickerData) {
        result.explanation = 'No pudimos obtener datos ahora. Intenta en unos segundos.';
        return result;
    }

    const trendCloses = trendKlines.map(k => k.close);
    const entryCloses = entryKlines.map(k => k.close);

    // Calcular indicadores
    const ema50 = calculateEMA(trendCloses, CONFIG.emaShort);
    const ema200 = calculateEMA(trendCloses, CONFIG.emaLong);
    const rsi = calculateRSI(entryCloses, CONFIG.rsiPeriod);
    const { support, resistance } = calculateSupportResistance(entryKlines, CONFIG.srPeriod);
    const volatility = calculateVolatility(entryKlines);

    result.ema50 = ema50;
    result.ema200 = ema200;
    result.rsi = rsi;
    result.support = support;
    result.resistance = resistance;

    // Determinar temporalidad
    const timeframe = volatility !== null ? determineTimeframes(volatility) : determineTimeframes(2);
    result.timeframe = timeframe;

    // Determinar tendencia
    if (ema50 === null || ema200 === null) {
        result.explanation = 'No hay suficientes datos para analizar la tendencia.';
        return result;
    }

    const trendUp = ema50 > ema200;
    result.trend = trendUp ? 'up' : 'down';

    // Verificar mercado lateral (rango estrecho)
    const priceRange = resistance - support;
    const rangePercent = (priceRange / result.price) * 100;

    if (rangePercent < 0.3 && rsi !== null && rsi > CONFIG.rsiNoTradeLow && rsi < CONFIG.rsiNoTradeHigh) {
        result.signal = 'wait';
        result.signalLabel = 'Esperar';
        result.confidence = 'low';
        result.confidenceLabel = 'Baja';
        result.explanation = 'El mercado está muy estable sin dirección clara. Mejor espera a que se defina un movimiento.';
        result.entry = result.price;
        result.takeProfit = result.price;
        result.stopLoss = result.price;
        result.riskReward = 0;
        return result;
    }

    // RSI en zona neutral
    if (rsi !== null && rsi >= CONFIG.rsiNoTradeLow && rsi <= CONFIG.rsiNoTradeHigh) {
        result.signal = 'wait';
        result.signalLabel = 'Esperar';
        result.confidence = 'low';
        result.confidenceLabel = 'Baja';
        result.explanation = trendUp
            ? 'Aunque el mercado sube, ahora mismo no hay una señal clara. Espera un poco.'
            : 'Aunque el mercado baja, ahora mismo no hay una señal clara. Espera un poco.';
        result.entry = result.price;
        result.takeProfit = result.price;
        result.stopLoss = result.price;
        result.riskReward = 0;
        return result;
    }

    // === LÓGICA DE SEÑALES ===

    if (trendUp) {
        // Tendencia alcista → buscar compras
        if (rsi < CONFIG.rsiBuyThreshold) {
            // RSI bajo en tendencia alcista = fuerte compra
            result.signal = 'buy';
            result.signalLabel = 'Comprar';
            result.confidence = 'high';
            result.confidenceLabel = 'Alta';
            const nearSupport = (result.price - support) / support < 0.02;
            result.explanation = nearSupport
                ? `Buen momento para comprar ${pairConfig.short}. El mercado está subiendo, el precio está cerca de su punto más bajo reciente y tiene espacio para crecer.`
                : `Buen momento para comprar ${pairConfig.short}. El mercado está subiendo y el precio está en un nivel bajo que podría subir pronto.`;
        } else if (rsi < CONFIG.rsiNoTradeLow) {
            // RSI medio-bajo en tendencia alcista
            result.signal = 'buy';
            result.signalLabel = 'Comprar';
            result.confidence = 'medium';
            result.confidenceLabel = 'Media';
            result.explanation = `El mercado de ${pairConfig.short} está subiendo. Podría ser buen momento para comprar, pero con precaución.`;
        } else if (rsi > CONFIG.rsiSellThreshold) {
            // RSI alto en tendencia alcista → cuidado, posible corrección
            result.signal = 'sell';
            result.signalLabel = 'Vender';
            result.confidence = 'medium';
            result.confidenceLabel = 'Media';
            result.explanation = `Aunque ${pairConfig.short} está subiendo, el precio está muy alto y podría bajar pronto. Considera vender para asegurar ganancias.`;
        } else {
            result.signal = 'wait';
            result.signalLabel = 'Esperar';
            result.confidence = 'low';
            result.confidenceLabel = 'Baja';
            result.explanation = `${pairConfig.short} está subiendo pero no hay un momento claro ahora. Espera una mejor señal.`;
        }
    } else {
        // Tendencia bajista → buscar ventas
        if (rsi > CONFIG.rsiSellThreshold) {
            // RSI alto en tendencia bajista = fuerte venta
            result.signal = 'sell';
            result.signalLabel = 'Vender';
            result.confidence = 'high';
            result.confidenceLabel = 'Alta';
            const nearResistance = (resistance - result.price) / resistance < 0.02;
            result.explanation = nearResistance
                ? `Buen momento para vender ${pairConfig.short}. El mercado está bajando y el precio está cerca de su punto más alto reciente. Podría seguir bajando.`
                : `Buen momento para vender ${pairConfig.short}. El mercado está bajando y el precio está alto, probablemente siga bajando.`;
        } else if (rsi > CONFIG.rsiNoTradeHigh) {
            // RSI medio-alto en tendencia bajista
            result.signal = 'sell';
            result.signalLabel = 'Vender';
            result.confidence = 'medium';
            result.confidenceLabel = 'Media';
            result.explanation = `${pairConfig.short} está bajando. Si tienes, considera vender antes de que baje más.`;
        } else if (rsi < CONFIG.rsiBuyThreshold) {
            // RSI bajo en tendencia bajista → posible rebote
            result.signal = 'wait';
            result.signalLabel = 'Esperar';
            result.confidence = 'medium';
            result.confidenceLabel = 'Media';
            result.explanation = `${pairConfig.short} está muy barato, pero el mercado sigue bajando. Espera a confirmar que empiece a subir antes de comprar.`;
        } else {
            result.signal = 'wait';
            result.signalLabel = 'Esperar';
            result.confidence = 'low';
            result.confidenceLabel = 'Baja';
            result.explanation = `${pairConfig.short} está bajando pero no hay señal clara ahora. Mejor espera.`;
        }
    }

    // Calcular precios
    result.entry = result.price;

    if (result.signal === 'buy') {
        result.takeProfit = result.entry * (1 + CONFIG.tpPercent);
        result.stopLoss = result.entry * (1 - CONFIG.slPercent);
    } else if (result.signal === 'sell') {
        result.takeProfit = result.entry * (1 - CONFIG.tpPercent);
        result.stopLoss = result.entry * (1 + CONFIG.slPercent);
    } else {
        result.takeProfit = result.entry;
        result.stopLoss = result.entry;
    }

    // Risk/Reward
    const potentialGain = Math.abs(result.takeProfit - result.entry);
    const potentialLoss = Math.abs(result.stopLoss - result.entry);
    result.riskReward = potentialLoss > 0 ? (potentialGain / potentialLoss).toFixed(2) : 0;

    return result;
}

// ==================== RENDERIZADO UI ====================

function renderCards(signals) {
    const container = document.getElementById('crypto-cards');

    const html = signals.map((s, i) => {
        const changeClass = s.change24h >= 0 ? 'positive' : 'negative';
        const changeSign = s.change24h >= 0 ? '+' : '';
        const signalClass = s.signal;
        const cardClass = `signal-${s.signal}`;
        const signalIcon = s.signal === 'buy' ? '📈' : s.signal === 'sell' ? '📉' : '⏸️';

        return `
            <div class="crypto-card ${cardClass} animate-in" style="animation-delay: ${i * 0.08}s">
                <div class="card-header">
                    <div class="card-coin">
                        <span class="card-emoji">${s.pair.emoji}</span>
                        <div>
                            <div class="card-name">${s.pair.short}</div>
                            <div class="card-pair">${s.pair.name}/USDT</div>
                        </div>
                    </div>
                    <span class="card-change ${changeClass}">${changeSign}${s.change24h.toFixed(2)}%</span>
                </div>
                <div class="card-price">$${formatPrice(s.price)}</div>
                <div class="card-price-label">Precio actual</div>
                <div style="display:flex;align-items:center;flex-wrap:wrap;gap:4px;">
                    <span class="card-signal ${signalClass}">${signalIcon} ${s.signalLabel}</span>
                    <span class="card-confidence">${s.confidenceLabel}</span>
                </div>
            </div>
        `;
    }).join('');

    container.innerHTML = html;
}

function renderRanking(signals) {
    const section = document.getElementById('ranking-section');
    const container = document.getElementById('ranking-cards');

    // Filtrar y rankear: solo BUY con alta/media confianza, luego SELL
    const ranked = [...signals]
        .filter(s => s.signal !== 'wait')
        .sort((a, b) => {
            // Prioridad: señal > confianza
            const signalScore = { buy: 3, sell: 2, wait: 0 };
            const confScore = { high: 3, medium: 2, low: 1 };
            const aScore = (signalScore[a.signal] || 0) * 10 + (confScore[a.confidence] || 0);
            const bScore = (signalScore[b.signal] || 0) * 10 + (confScore[b.confidence] || 0);
            return bScore - aScore;
        })
        .slice(0, 3);

    if (ranked.length === 0) {
        section.style.display = 'none';
        return;
    }

    section.style.display = 'block';
    const medals = ['🥇', '🥈', '🥉'];

    container.innerHTML = ranked.map((s, i) => `
        <div class="ranking-card animate-in" style="animation-delay: ${i * 0.1}s">
            <div class="ranking-medal">${medals[i]}</div>
            <div class="ranking-info">
                <div class="ranking-name">${s.pair.emoji} ${s.pair.short} — $${formatPrice(s.price)}</div>
                <div class="ranking-reason">${s.explanation.substring(0, 80)}...</div>
            </div>
            <span class="ranking-badge ${s.signal}">${s.signalLabel}</span>
        </div>
    `).join('');
}

function renderTable(signals) {
    const tbody = document.getElementById('signals-body');

    tbody.innerHTML = signals.map((s, i) => {
        const signalClass = s.signal;
        const signalIcon = s.signal === 'buy' ? '📈' : s.signal === 'sell' ? '📉' : '⏸️';
        const confClass = s.confidence;
        const confIcon = s.confidence === 'high' ? '⭐' : s.confidence === 'medium' ? '✨' : '○';
        const tpClass = s.signal === 'buy' ? 'green' : (s.signal === 'sell' ? 'red' : '');
        const slClass = s.signal === 'buy' ? 'red' : (s.signal === 'sell' ? 'green' : '');
        const timeframeText = s.timeframe
            ? `${s.timeframe.trendLabel} / ${s.timeframe.entryLabel}`
            : '--';

        return `
            <tr class="animate-in" style="animation-delay: ${i * 0.06}s">
                <td>
                    <div class="table-coin">
                        <span class="table-emoji">${s.pair.emoji}</span>
                        <div>
                            <div>${s.pair.short}</div>
                            <div style="font-size:0.7rem;color:var(--text-muted);font-weight:400">${s.pair.name}</div>
                        </div>
                    </div>
                </td>
                <td><span class="table-price">$${formatPrice(s.price)}</span></td>
                <td><span class="table-signal ${signalClass}">${signalIcon} ${s.signalLabel}</span></td>
                <td><span class="table-confidence ${confClass}">${confIcon} ${s.confidenceLabel}</span></td>
                <td><span class="table-number">$${formatPrice(s.entry)}</span></td>
                <td><span class="table-number ${tpClass}">$${formatPrice(s.takeProfit)}</span></td>
                <td><span class="table-number ${slClass}">$${formatPrice(s.stopLoss)}</span></td>
                <td><span class="table-number" style="color:${parseFloat(s.riskReward) >= 2 ? 'var(--green)' : parseFloat(s.riskReward) >= 1 ? 'var(--amber)' : 'var(--text-muted)'}">${s.riskReward}:1</span></td>
                <td><div class="table-explanation">${s.explanation}</div></td>
            </tr>
        `;
    }).join('');
}

function renderVolatilityBanner(volatility, timeframe) {
    const banner = document.getElementById('volatility-banner');
    const levelEl = document.getElementById('volatility-level');
    const tfEl = document.getElementById('timeframe-display');

    if (!timeframe) return;

    banner.style.display = 'block';
    levelEl.textContent = `${timeframe.level} — ${timeframe.description}`;
    tfEl.textContent = `Tendencia: ${timeframe.trendLabel} · Entrada: ${timeframe.entryLabel}`;
}

function updateStatus(type, text) {
    const indicator = document.getElementById('status-indicator');
    const statusText = document.getElementById('status-text');
    const lastUpdate = document.getElementById('last-update');

    indicator.className = `status-indicator ${type}`;
    statusText.textContent = text;

    if (type === 'connected') {
        const now = new Date();
        lastUpdate.textContent = `Actualizado: ${now.toLocaleTimeString('es-ES')}`;
    }
}

// ==================== UTILIDADES ====================

function formatPrice(price) {
    if (!price || price === 0) return '--';
    if (price >= 1000) return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (price >= 1) return price.toFixed(2);
    if (price >= 0.01) return price.toFixed(4);
    return price.toFixed(6);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ==================== CUENTA REGRESIVA ====================

function startCountdown() {
    if (state.countdownInterval) clearInterval(state.countdownInterval);

    state.countdown = CONFIG.updateInterval;
    const bar = document.getElementById('countdown-bar');
    const timer = document.getElementById('countdown-timer');
    const fill = document.getElementById('countdown-fill');

    bar.style.display = 'block';
    fill.style.width = '100%';

    state.countdownInterval = setInterval(() => {
        state.countdown--;
        timer.textContent = state.countdown;
        fill.style.width = `${(state.countdown / CONFIG.updateInterval) * 100}%`;

        if (state.countdown <= 0) {
            clearInterval(state.countdownInterval);
            analyze();
        }
    }, 1000);
}

// ==================== ANÁLISIS PRINCIPAL ====================

async function analyze() {
    if (state.isAnalyzing) return;
    state.isAnalyzing = true;

    updateStatus('loading', 'Analizando mercado...');

    const signals = [];
    let volatilitySum = 0;
    let volatilityCount = 0;

    try {
        // Procesar cada par
        for (const pair of CONFIG.pairs) {
            try {
                // Fetch datos en paralelo para este par
                const [tickerData, trendData, entryData] = await Promise.all([
                    fetch24hrTicker(pair.symbol),
                    fetchKlines(pair.symbol, '4h', 200),
                    fetchKlines(pair.symbol, '1h', 100)
                ]);

                const signal = generateSignal(pair, trendData, entryData, tickerData);
                signals.push(signal);

                if (signal.timeframe) {
                    const vol = calculateVolatility(entryData);
                    if (vol !== null) {
                        volatilitySum += vol;
                        volatilityCount++;
                    }
                }

                // Pequeña pausa entre pares para no saturar la API
                await sleep(200);

            } catch (err) {
                console.error(`Error procesando ${pair.symbol}:`, err);
                signals.push({
                    pair,
                    price: 0,
                    change24h: 0,
                    signal: 'wait',
                    signalLabel: 'Esperar',
                    confidence: 'low',
                    confidenceLabel: 'Baja',
                    entry: 0,
                    takeProfit: 0,
                    stopLoss: 0,
                    riskReward: 0,
                    explanation: 'No pudimos conectar con el mercado ahora.',
                    timeframe: null
                });
            }
        }

        // Calcular volatilidad global
        const avgVolatility = volatilityCount > 0 ? volatilitySum / volatilityCount : 2;
        const globalTimeframe = determineTimeframes(avgVolatility);

        state.signals = signals;
        state.globalVolatility = avgVolatility;
        state.globalTimeframe = globalTimeframe;

        // Renderizar todo
        renderCards(signals);
        renderRanking(signals);
        renderTable(signals);
        renderVolatilityBanner(avgVolatility, globalTimeframe);

        updateStatus('connected', 'Mercado actualizado');

    } catch (error) {
        console.error('Error en análisis:', error);
        updateStatus('error', 'Error de conexión');
    }

    state.isAnalyzing = false;
    startCountdown();
}

// ==================== INICIALIZACIÓN ====================

document.addEventListener('DOMContentLoaded', () => {
    analyze();
});
