// src/index.js — Express server + cron + startup
const express = require('express');
const cron = require('node-cron');
const config = require('./config');
const { logger } = require('./logger');
const memory = require('./memory');
const { validateModels } = require('./model-router');
const { genAI, budgetGuardian } = require('./gemini');
const { startBot, sendMessage, setOrchestrator } = require('./telegram');
const orchestrator = require('./orchestrator');
const { detectUpcomingInterviews, generateAndSendBrief } = require('./interview-prep');

const app = express();
const startTime = Date.now();

// ─── Routes ───
app.get('/health', (req, res) => {
    const budget = budgetGuardian.getBudgetStatus();
    const state = orchestrator.getState();
    res.json({
        status: 'ok',
        version: '1.0.0',
        uptime: Math.floor((Date.now() - startTime) / 1000),
        isPaused: state.isPaused,
        isRunning: state.isRunning,
        emergencyStop: state.emergencyStop,
        budgetStatus: {
            todayUSD: budget.todayUSD,
            monthUSD: budget.monthUSD,
            hardStopUSD: budget.hardStopUSD,
            paused: budget.paused,
        },
    });
});

app.get('/stats', (req, res) => {
    const stats = memory.getHourlyStats();
    res.json(stats);
});

// ─── Startup Sequence ───
async function startup() {
    try {
        logger.info('═══ NAUKRI JOB AGENT — STARTING ═══');

        // a. Config already validated by require('./config')
        logger.info('✓ Config validated');

        // b. Initialize memory files
        memory.initializeAllFiles();
        logger.info('✓ Memory initialized');

        // c. Models — all routed to gemini-2.0-flash (free tier)
        // Skipping validation to avoid burning free tier RPM at startup
        logger.info('✓ Models: all routed to gemini-2.0-flash (free tier, $0/month)');

        // d. Budget check
        budgetGuardian.checkIfShouldResume();
        logger.info('✓ Budget checked');

        // e. Start Telegram bot
        setOrchestrator(orchestrator);
        await startBot();
        logger.info('✓ Telegram bot started');

        // f. Start Express
        app.listen(config.port, () => {
            logger.info(`✓ Express listening on port ${config.port}`);
        });

        // g. Start cron jobs
        setupCronJobs();
        logger.info('✓ Cron jobs scheduled');

        // h. Startup Telegram message
        const profile = memory.loadProfile();
        const budget = budgetGuardian.getBudgetStatus();
        await sendMessage(`🚀 *Naukri Job Agent — LIVE*
📍 Running locally
🎯 ${profile.targetRoles.slice(0, 3).join(', ')}
💰 Budget: $${budget.monthUSD.toFixed(2)}/$${budget.hardStopUSD.toFixed(2)} this month
⏰ Cycles: every 5 min | Reports: every 5 min

Commands: /status /pause /resume /budget /queue /borderline`);

        logger.info('═══ NAUKRI JOB AGENT — READY ═══');
    } catch (err) {
        logger.error(`Startup failed: ${err.message}`);
        process.exit(1);
    }
}

// ─── Cron Jobs ───
function setupCronJobs() {
    // Every 5 minutes — main application cycle
    cron.schedule('*/5 * * * *', () => {
        logger.info('CRON: starting Naukri cycle');
        orchestrator.runNaukriCycle().catch(err => {
            logger.error(`CRON Naukri cycle error: ${err.message}`);
        });
    });

    // Every 3 hours — follow-up cycle
    cron.schedule('0 */3 * * *', () => {
        logger.info('CRON: starting follow-up cycle');
        orchestrator.runFollowUpCycle().catch(err => {
            logger.error(`CRON follow-up error: ${err.message}`);
        });
    });

    // Every 30 minutes — status check
    cron.schedule('*/30 * * * *', () => {
        logger.info('CRON: starting status check');
        orchestrator.runStatusCheck().catch(err => {
            logger.error(`CRON status check error: ${err.message}`);
        });
    });

    // Daily 8 AM IST — profile refresh
    cron.schedule('0 8 * * *', () => {
        logger.info('CRON: daily profile refresh');
        orchestrator.runProfileRefresh().catch(err => {
            logger.error(`CRON profile refresh error: ${err.message}`);
        });
    }, { timezone: 'Asia/Kolkata' });

    // Daily 9 AM IST — interview check
    cron.schedule('0 9 * * *', () => {
        logger.info('CRON: checking for upcoming interviews');
        const interviews = detectUpcomingInterviews();
        for (const job of interviews) {
            generateAndSendBrief(job).catch(err => {
                logger.error(`CRON interview prep error: ${err.message}`);
            });
        }
    }, { timezone: 'Asia/Kolkata' });

    // Every 5 minutes — status report to Telegram
    cron.schedule('*/5 * * * *', () => {
        logger.info('CRON: 5-minute status report');
        orchestrator.runHourlyReport().catch(err => {
            logger.error(`CRON status report error: ${err.message}`);
        });
    });

    // Every hour — Gemini resume feedback (the ONLY AI call)
    cron.schedule('0 * * * *', () => {
        logger.info('CRON: resume feedback from Gemini');
        orchestrator.runResumeFeedback().catch(err => {
            logger.error(`CRON resume feedback error: ${err.message}`);
        });
    });

    // Midnight — daily reset
    cron.schedule('0 0 * * *', () => {
        logger.info('CRON: midnight reset');
        budgetGuardian.resetDaily();
        memory.resetDailyStats();
    }, { timezone: 'Asia/Kolkata' });
}

// ─── Graceful Shutdown ───
process.on('SIGTERM', async () => {
    logger.info('SIGTERM received — shutting down gracefully');
    const { closeBrowser } = require('./naukri-agent');
    await closeBrowser();
    process.exit(0);
});

process.on('SIGINT', async () => {
    logger.info('SIGINT received — shutting down');
    const { closeBrowser } = require('./naukri-agent');
    await closeBrowser();
    process.exit(0);
});

process.on('unhandledRejection', (err) => {
    logger.error(`Unhandled rejection: ${err.message || err}`);
});

// ─── Start ───
startup();
