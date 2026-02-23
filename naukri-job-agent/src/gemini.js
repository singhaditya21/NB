// src/gemini.js — Gemini client + BudgetGuardian
const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('./config');
const { logger } = require('./logger');
const { getModel, setForceCheap, MODEL_REGISTRY, getFallback } = require('./model-router');
const memory = require('./memory');

const genAI = new GoogleGenerativeAI(config.geminiApiKey);

// ─── BudgetGuardian ───
class BudgetGuardian {
    constructor() {
        this._alertCallbacks = []; // array of (title, body) => void
    }

    onAlert(cb) {
        this._alertCallbacks.push(cb);
    }

    _sendAlert(title, body) {
        logger.warn(`BUDGET ALERT: ${title} — ${body}`);
        for (const cb of this._alertCallbacks) {
            try { cb(title, body); } catch { }
        }
    }

    _load() {
        return memory.getBudgetLog();
    }

    _save(log) {
        memory.saveBudgetLog(log);
    }

    _ensureTodayLog() {
        const log = this._load();
        const today = new Date().toISOString().slice(0, 10);
        if (log.date !== today) {
            // New day — carry month total, reset daily
            log.date = today;
            log.callsByModel = { FREE: 0, CHEAP: 0, BALANCED: 0 };
            log.estimatedCostToday = 0.00;
            log.totalCallsToday = 0;
            this._save(log);
        }
        return log;
    }

    _ensureMonthLog(log) {
        const thisMonth = new Date().toISOString().slice(0, 7);
        if (!log.monthlyHistory) log.monthlyHistory = [];
        const entry = log.monthlyHistory.find(h => h.month === thisMonth);
        if (!entry) {
            log.monthlyHistory.push({ month: thisMonth, cost: 0.00 });
        }
    }

    checkBudget(modelKey) {
        const log = this._ensureTodayLog();
        const limits = MODEL_REGISTRY.dailyCallLimits;
        const budget = config.budget;

        // Check if paused
        if (log.paused) {
            return { allowed: false, reason: `Agent paused until ${log.pausedUntil}` };
        }

        // Hard stop at $5.00/month
        if (log.estimatedCostMonth >= budget.monthlyHardStopUSD) {
            const nextMonth = new Date();
            nextMonth.setMonth(nextMonth.getMonth() + 1, 1);
            nextMonth.setHours(0, 0, 0, 0);
            log.paused = true;
            log.pausedUntil = nextMonth.toISOString().slice(0, 10);
            this._save(log);
            this._sendAlert(
                '🛑 Monthly Budget Reached',
                `Monthly budget reached ($${log.estimatedCostMonth.toFixed(2)}). Agent paused until ${log.pausedUntil}. Zero applications will be made. Resumes automatically.`
            );
            return { allowed: false, reason: 'Monthly budget hard stop reached' };
        }

        // Pause threshold at $4.00 — switch to CHEAP
        if (log.estimatedCostMonth >= budget.monthlyPauseUSD) {
            setForceCheap(true);
            if (!log._pauseAlerted) {
                this._sendAlert(
                    '🟡 Budget at 80%',
                    `Budget at 80% ($${log.estimatedCostMonth.toFixed(2)}/$${budget.monthlyHardStopUSD.toFixed(2)}). Switching all tasks to Flash-Lite only.`
                );
                log._pauseAlerted = true;
                this._save(log);
            }
        }

        // Warning at $3.00
        if (log.estimatedCostMonth >= budget.monthlyWarningUSD && !log._warnAlerted) {
            this._sendAlert(
                '⚠️ Budget Warning',
                `$${log.estimatedCostMonth.toFixed(2)}/$${budget.monthlyHardStopUSD.toFixed(2)} used this month. Agent running normally.`
            );
            log._warnAlerted = true;
            this._save(log);
        }

        // Daily per-model limit
        const modelCalls = (log.callsByModel && log.callsByModel[modelKey]) || 0;
        const modelLimit = limits[modelKey] || limits.TOTAL;
        if (modelCalls >= modelLimit) {
            return { allowed: false, reason: `Daily ${modelKey} call limit (${modelLimit}) reached` };
        }

        // Daily total limit
        if ((log.totalCallsToday || 0) >= limits.TOTAL) {
            return { allowed: false, reason: `Daily total call limit (${limits.TOTAL}) reached` };
        }

        return { allowed: true, reason: 'ok' };
    }

    recordCall(modelKey, inputTokens, outputTokens) {
        const log = this._ensureTodayLog();
        this._ensureMonthLog(log);

        // Increment calls
        if (!log.callsByModel) log.callsByModel = { FREE: 0, CHEAP: 0, BALANCED: 0 };
        log.callsByModel[modelKey] = (log.callsByModel[modelKey] || 0) + 1;
        log.totalCallsToday = (log.totalCallsToday || 0) + 1;

        // Calculate cost
        const costs = MODEL_REGISTRY.costs[modelKey];
        if (costs && !costs.has_free_tier) {
            const inputCost = (inputTokens / 1_000_000) * costs.input_batch;
            const outputCost = (outputTokens / 1_000_000) * costs.output_batch;
            const callCost = inputCost + outputCost;
            log.estimatedCostToday = Math.round((log.estimatedCostToday + callCost) * 10000) / 10000;
            log.estimatedCostMonth = Math.round((log.estimatedCostMonth + callCost) * 10000) / 10000;

            // Update monthly history
            const thisMonth = new Date().toISOString().slice(0, 7);
            const entry = log.monthlyHistory.find(h => h.month === thisMonth);
            if (entry) entry.cost = log.estimatedCostMonth;
        }

        this._save(log);
        return log;
    }

    resetDaily() {
        const log = this._load();
        log.date = new Date().toISOString().slice(0, 10);
        log.callsByModel = { FREE: 0, CHEAP: 0, BALANCED: 0 };
        log.estimatedCostToday = 0.00;
        log.totalCallsToday = 0;
        log._warnAlerted = false;
        log._pauseAlerted = false;
        this._save(log);
        logger.info('BudgetGuardian: daily counters reset');
    }

    checkIfShouldResume() {
        const log = this._load();
        if (log.paused && log.pausedUntil) {
            const today = new Date().toISOString().slice(0, 10);
            if (today >= log.pausedUntil) {
                log.paused = false;
                log.pausedUntil = null;
                log.estimatedCostMonth = 0.00;
                log._warnAlerted = false;
                log._pauseAlerted = false;
                setForceCheap(false);
                this._save(log);
                this._sendAlert('▶️ Budget Auto-Resume', 'New month started. Agent resumed. Budget reset to $0.00.');
                logger.info('BudgetGuardian: auto-resumed for new month');
                return true;
            }
        }
        return false;
    }

    isBudgetPaused() {
        const log = this._load();
        return log.paused === true;
    }

    getBudgetStatus() {
        const log = this._ensureTodayLog();
        return {
            todayUSD: log.estimatedCostToday,
            monthUSD: log.estimatedCostMonth,
            hardStopUSD: config.budget.monthlyHardStopUSD,
            callsByModel: log.callsByModel,
            totalCallsToday: log.totalCallsToday,
            paused: log.paused,
            pausedUntil: log.pausedUntil,
        };
    }
}

const budgetGuardian = new BudgetGuardian();

// ─── Random delay helper ───
function randomDelay(min, max) {
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Free Tier Rate Limiter ───
// Gemini 2.0 Flash free tier: 15 RPM, 1,500 RPD, 1M TPM
// We enforce: 4.5s minimum between calls (≤13 RPM) + 1,400 RPD cap
class FreeRateLimiter {
    constructor() {
        this._lastCallTime = 0;
        this._callsToday = 0;
        this._currentDay = new Date().toISOString().slice(0, 10);
        this.MIN_INTERVAL_MS = 4500; // 4.5s between calls = max ~13 RPM
        this.MAX_DAILY_CALLS = 1400;
    }

    _resetIfNewDay() {
        const today = new Date().toISOString().slice(0, 10);
        if (today !== this._currentDay) {
            this._currentDay = today;
            this._callsToday = 0;
        }
    }

    canCall() {
        this._resetIfNewDay();
        if (this._callsToday >= this.MAX_DAILY_CALLS) {
            return { allowed: false, reason: `Daily call limit reached (${this._callsToday}/${this.MAX_DAILY_CALLS})` };
        }
        return { allowed: true };
    }

    async waitForSlot() {
        const check = this.canCall();
        if (!check.allowed) {
            logger.warn(`Rate limiter: ${check.reason}`);
            return false;
        }

        const now = Date.now();
        const elapsed = now - this._lastCallTime;
        if (elapsed < this.MIN_INTERVAL_MS) {
            const waitMs = this.MIN_INTERVAL_MS - elapsed;
            await new Promise(r => setTimeout(r, waitMs));
        }

        this._lastCallTime = Date.now();
        this._callsToday++;
        return true;
    }

    getStats() {
        this._resetIfNewDay();
        return { callsToday: this._callsToday, maxDaily: this.MAX_DAILY_CALLS, remaining: this.MAX_DAILY_CALLS - this._callsToday };
    }
}

const rateLimiter = new FreeRateLimiter();

// ─── callGemini ───
async function callGemini(prompt, taskType, options = {}) {
    // Rate limit check — wait for a free slot
    const slotAvailable = await rateLimiter.waitForSlot();
    if (!slotAvailable) {
        logger.warn(`Gemini call skipped (rate limited): task=${taskType}`);
        return null;
    }

    const routing = getModel(taskType);
    const { modelId, mode, costTier } = routing;

    // Budget check
    const budgetCheck = budgetGuardian.checkBudget(costTier);
    if (!budgetCheck.allowed) {
        logger.warn(`Budget blocked: task=${taskType} reason=${budgetCheck.reason}`);
        return null;
    }

    // Polite delay for batch mode
    if (mode === 'batch') {
        await randomDelay(1000, 2000);
    }

    let retries = 2;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const model = genAI.getGenerativeModel({ model: modelId });
            const result = await model.generateContent(prompt);
            const response = result.response;
            const text = response.text();

            // Token usage
            const usage = response.usageMetadata || {};
            const inputTokens = usage.promptTokenCount || 0;
            const outputTokens = usage.candidatesTokenCount || 0;

            // Record cost
            budgetGuardian.recordCall(costTier, inputTokens, outputTokens);

            logger.info(`Gemini call: task=${taskType} model=${modelId} mode=${mode} in=${inputTokens} out=${outputTokens}`);

            // JSON parsing
            if (options.json) {
                try {
                    // Strip markdown fences if present
                    let cleaned = text.trim();
                    if (cleaned.startsWith('```')) {
                        cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
                    }
                    return JSON.parse(cleaned);
                } catch (parseErr) {
                    logger.warn(`JSON parse failed for task=${taskType}: ${parseErr.message}`);
                    return null;
                }
            }

            return text;
        } catch (err) {
            // Handle rate limiting (429) — wait longer and retry
            const isRateLimit = err.status === 429 || (err.message && err.message.includes('429'));
            const isTransient = err.status >= 500 || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';

            if (attempt < retries && (isRateLimit || isTransient)) {
                const waitMs = isRateLimit ? 12000 : 3000;
                logger.warn(`Gemini retry ${attempt + 1} (${isRateLimit ? '429 rate limit' : 'transient'}): waiting ${waitMs / 1000}s`);
                await randomDelay(waitMs, waitMs + 3000);
                continue;
            }

            // Try fallback model
            if (attempt === retries) {
                const fallbackKey = getFallback(costTier);
                if (fallbackKey !== costTier) {
                    logger.warn(`Trying fallback model: ${costTier} → ${fallbackKey}`);
                    try {
                        const fbModelId = MODEL_REGISTRY.models[fallbackKey];
                        const fbModel = genAI.getGenerativeModel({ model: fbModelId });
                        const fbResult = await fbModel.generateContent(prompt);
                        const fbResponse = fbResult.response;
                        const fbText = fbResponse.text();
                        const fbUsage = fbResponse.usageMetadata || {};
                        budgetGuardian.recordCall(fallbackKey, fbUsage.promptTokenCount || 0, fbUsage.candidatesTokenCount || 0);

                        if (options.json) {
                            let cleaned = fbText.trim();
                            if (cleaned.startsWith('```')) {
                                cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
                            }
                            return JSON.parse(cleaned);
                        }
                        return fbText;
                    } catch (fbErr) {
                        logger.error(`Fallback also failed: ${fbErr.message}`);
                    }
                }
            }

            logger.error(`Gemini call failed: task=${taskType} error=${err.message}`);
            return null;
        }
    }
    return null;
}

// ─── batchCallGemini ───
async function batchCallGemini(items, taskType, promptBuilder) {
    if (!items || items.length === 0) return [];

    const results = [];
    const batchSize = 5;

    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        const combinedPrompt = batch.map((item, idx) =>
            `--- ITEM ${idx + 1} ---\n${promptBuilder(item)}`
        ).join('\n\n');

        const fullPrompt = `Process each item below independently. Return a JSON array with exactly ${batch.length} results, one per item in the same order.\n\n${combinedPrompt}\n\nReturn ONLY a JSON array, no markdown fences, no explanation.`;

        const result = await callGemini(fullPrompt, taskType, { json: true });

        if (Array.isArray(result)) {
            results.push(...result);
        } else {
            // Fill with nulls if batch failed
            results.push(...batch.map(() => null));
        }
    }

    return results;
}

module.exports = {
    genAI,
    callGemini,
    batchCallGemini,
    budgetGuardian,
    rateLimiter,
    randomDelay,
};
