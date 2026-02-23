// src/model-router.js — Single source of truth for all Gemini model names
const { logger } = require('./logger');

const MODEL_REGISTRY = {
    // ─── ALL models route to gemini-2.0-flash (FREE TIER ONLY) ───
    // Free tier: 15 RPM, 1,500 RPD, 1M TPM — $0.00/month
    models: {
        FREE: 'gemini-2.0-flash',
        CHEAP: 'gemini-2.0-flash',
        BALANCED: 'gemini-2.0-flash',  // Was gemini-2.5-flash — changed to stay free
    },

    taskRouting: {
        // All tasks use gemini-2.0-flash via their tier routing
        company_research: { model: 'FREE', mode: 'batch', reason: 'free tier' },
        jd_screening: { model: 'FREE', mode: 'batch', reason: 'free tier' },
        keyword_extraction: { model: 'FREE', mode: 'batch', reason: 'free tier' },
        hourly_insight: { model: 'FREE', mode: 'batch', reason: 'free tier' },
        report_generation: { model: 'FREE', mode: 'batch', reason: 'free tier' },
        follow_up_draft: { model: 'FREE', mode: 'batch', reason: 'free tier' },
        dedup_check: { model: 'FREE', mode: 'batch', reason: 'free tier' },
        jd_analysis_full: { model: 'FREE', mode: 'batch', reason: 'free tier' },
        recruiter_message: { model: 'FREE', mode: 'batch', reason: 'free tier' },
        resume_tailor: { model: 'FREE', mode: 'batch', reason: 'free tier' },
        interview_prep: { model: 'FREE', mode: 'batch', reason: 'free tier' },
        offer_analysis: { model: 'FREE', mode: 'batch', reason: 'free tier' },
    },

    costs: {
        // All $0 — free tier only
        FREE: { input_batch: 0.0, output_batch: 0.0, has_free_tier: true },
        CHEAP: { input_batch: 0.0, output_batch: 0.0, has_free_tier: true },
        BALANCED: { input_batch: 0.0, output_batch: 0.0, has_free_tier: true },
    },

    // Free tier hard limits: 15 RPM, 1,500 RPD
    // We cap at 1,400 to leave buffer
    dailyCallLimits: {
        FREE: 1400,
        CHEAP: 1400,
        BALANCED: 1400,
        TOTAL: 1400,
    },
};

// Budget override flag — set by BudgetGuardian when monthly cost >= $4
let _forceCheap = false;

function setForceCheap(val) {
    _forceCheap = val;
}

/**
 * 1. getModel(taskType) → { modelId, mode, reason, costTier }
 */
function getModel(taskType) {
    const routing = MODEL_REGISTRY.taskRouting[taskType];

    if (!routing) {
        logger.warn(`Unknown task type "${taskType}" — defaulting to CHEAP batch`);
        return {
            modelId: MODEL_REGISTRY.models.CHEAP,
            mode: 'batch',
            reason: `unknown task type "${taskType}" — default CHEAP`,
            costTier: 'CHEAP',
        };
    }

    let costTier = routing.model;
    if (_forceCheap && costTier !== 'FREE') {
        costTier = 'CHEAP';
    }

    const result = {
        modelId: MODEL_REGISTRY.models[costTier],
        mode: routing.mode,
        reason: routing.reason,
        costTier,
    };

    logger.debug(`Model routed: task=${taskType} model=${result.modelId} tier=${costTier} reason=${result.reason}`);
    return result;
}

/**
 * 2. estimateDailyCost() — reads budget-log.json (via callback)
 */
function estimateDailyCost(budgetLog) {
    if (!budgetLog) return { todayUSD: 0, monthUSD: 0, projectedMonthUSD: 0, safeToday: true };

    const today = new Date();
    const dayOfMonth = today.getDate();
    const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    const dailyRate = budgetLog.estimatedCostMonth / Math.max(dayOfMonth, 1);
    const projected = dailyRate * daysInMonth;

    return {
        todayUSD: budgetLog.estimatedCostToday || 0,
        monthUSD: budgetLog.estimatedCostMonth || 0,
        projectedMonthUSD: Math.round(projected * 100) / 100,
        safeToday: (budgetLog.estimatedCostToday || 0) < 0.16,
    };
}

/**
 * 3. validateModels() — minimal test call to each model
 *    Uses delays between calls to respect free-tier rate limits
 */
async function validateModels(geminiClient) {
    const issues = [];
    // Deduplicate — if CHEAP and FREE use the same model ID, only test once
    const tested = new Set();
    const modelKeys = Object.keys(MODEL_REGISTRY.models);

    for (const key of modelKeys) {
        const modelId = MODEL_REGISTRY.models[key];
        if (tested.has(modelId)) {
            logger.info(`Model ${key} (${modelId}): same as previous — skipping duplicate test`);
            continue;
        }
        tested.add(modelId);

        // Wait 3s between calls to respect free-tier rate limits (15 RPM)
        if (tested.size > 1) {
            await new Promise(r => setTimeout(r, 3000));
        }

        try {
            const model = geminiClient.getGenerativeModel({ model: modelId });
            const result = await model.generateContent('Say "ok" in one word.');
            const text = result.response.text();
            if (!text) throw new Error('Empty response');
            logger.info(`Model ${key} (${modelId}): healthy`);
        } catch (err) {
            // On rate limit (429), retry once after waiting
            if (err.status === 429 || (err.message && err.message.includes('429'))) {
                logger.info(`Model ${key}: rate limited, waiting 10s then retrying...`);
                await new Promise(r => setTimeout(r, 10000));
                try {
                    const model = geminiClient.getGenerativeModel({ model: modelId });
                    const result = await model.generateContent('Say "ok" in one word.');
                    const text = result.response.text();
                    if (!text) throw new Error('Empty response');
                    logger.info(`Model ${key} (${modelId}): healthy (after retry)`);
                    continue;
                } catch (retryErr) {
                    // Fall through to log issue
                    err = retryErr;
                }
            }

            const fallbackKey = getFallback(key);
            issues.push({
                model: key,
                modelId,
                error: err.message,
                fallback: fallbackKey,
            });
            logger.warn(`Model ${key} (${modelId}) failed: ${err.message}. Fallback: ${fallbackKey}`);
        }
    }

    return {
        allHealthy: issues.length === 0,
        issues,
    };
}

/**
 * 4. getFallback(modelKey)  FREE → BALANCED → CHEAP (CHEAP never fails)
 */
function getFallback(modelKey) {
    const chain = { FREE: 'BALANCED', BALANCED: 'CHEAP', CHEAP: 'CHEAP' };
    return chain[modelKey] || 'CHEAP';
}

/**
 * 5. getModelStats() — per-model usage and cost breakdown
 */
function getModelStats(budgetLog) {
    if (!budgetLog) {
        return {
            models: {},
            totalToday: 0,
            totalMonth: 0,
        };
    }

    return {
        models: budgetLog.callsByModel || {},
        totalToday: budgetLog.estimatedCostToday || 0,
        totalMonth: budgetLog.estimatedCostMonth || 0,
        totalCallsToday: budgetLog.totalCallsToday || 0,
    };
}

module.exports = {
    MODEL_REGISTRY,
    getModel,
    estimateDailyCost,
    validateModels,
    getFallback,
    getModelStats,
    setForceCheap,
};
