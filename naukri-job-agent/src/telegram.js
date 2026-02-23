// src/telegram.js — Telegraf bot + formatters + command handlers
const { Telegraf, Markup } = require('telegraf');
const config = require('./config');
const { logger } = require('./logger');
const memory = require('./memory');
const { budgetGuardian } = require('./gemini');
const { getModelStats } = require('./model-router');

const bot = new Telegraf(config.telegramBotToken);
const CHAT_ID = config.telegramUserId;

// Module-level reference to orchestrator (set after import to avoid circular deps)
let _orchestrator = null;
function setOrchestrator(orch) { _orchestrator = orch; }

// ─── Core send functions ───
async function sendMessage(text) {
    try {
        await bot.telegram.sendMessage(CHAT_ID, text, { parse_mode: 'Markdown' });
    } catch (err) {
        logger.error(`Telegram sendMessage failed: ${err.message}`);
        // Retry without markdown on parse failure
        if (err.description && err.description.includes("can't parse")) {
            try {
                await bot.telegram.sendMessage(CHAT_ID, text.replace(/[*_`\[\]]/g, ''));
            } catch { }
        }
    }
}

async function sendAlert(title, body) {
    await sendMessage(`🚨 *${title}*\n${body}`);
}

async function sendInlineKeyboard(text, buttons) {
    try {
        await bot.telegram.sendMessage(CHAT_ID, text, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons },
        });
    } catch (err) {
        logger.error(`Telegram sendInlineKeyboard failed: ${err.message}`);
    }
}

// ─── 5-Minute Status Report ───
async function hourlyReport(stats) {
    const now = new Date();
    const time = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
    const date = now.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

    const budget = budgetGuardian.getBudgetStatus();
    const state = _orchestrator ? _orchestrator.getState() : {};

    // Get all applied jobs for today's list
    const allApplied = memory.getAppliedJobs();
    const today = now.toISOString().slice(0, 10);
    const appliedToday = allApplied.filter(j => j.appliedAt && j.appliedAt.startsWith(today));

    // Build applied jobs list
    let appliedList = '';
    if (appliedToday.length > 0) {
        appliedList = '\n📋 *JOBS APPLIED TODAY*\n';
        for (const job of appliedToday.slice(-15)) { // Last 15 to avoid message length issues
            const score = job.matchScore ? ` (${job.matchScore}%)` : '';
            const status = job.status === 'applied' ? '✅' : job.status === 'viewed' ? '👀' : '📤';
            appliedList += `${status} ${job.company} — ${job.title}${score}\n`;
        }
        if (appliedToday.length > 15) {
            appliedList += `   ...+${appliedToday.length - 15} more\n`;
        }
    } else {
        appliedList = '\n📋 *JOBS APPLIED TODAY*\n— None yet —\n';
    }

    // Top match
    const topMatch = stats.topMatchThisHour;
    const topMatchStr = topMatch
        ? `🏢 ${topMatch.company} — ${topMatch.title}\n💰 ${topMatch.salary || 'Not disclosed'} | Match: ${topMatch.matchScore}%`
        : '— None yet —';

    // Agent status
    const statusEmoji = state.emergencyStop ? '🛑 STOPPED' : state.isPaused ? '⏸ PAUSED' : state.isRunning ? '🔄 RUNNING' : '✅ READY';

    const msg = `🤖 *Naukri Agent — ${statusEmoji}*
🕒 ${time} | ${date}

📊 *STATS*
✅ Applied today: ${stats.appliedToday || 0}
💬 Messages sent: ${stats.messagesToday || 0}
📩 Replies: ${stats.repliesToday || 0}
🟡 Borderline: ${stats.borderlineCount || 0}
🔗 External queue: ${stats.externalQueueCount || 0}
${appliedList}
🏆 *TOP MATCH*
${topMatchStr}

💰 Today: $${budget.todayUSD.toFixed(2)} | Month: $${budget.monthUSD.toFixed(2)}/$${budget.hardStopUSD.toFixed(2)}`;

    await sendMessage(msg);
}

// ─── Bot Commands ───
function registerCommands() {
    bot.command('pause', async (ctx) => {
        if (String(ctx.from.id) !== CHAT_ID) return;
        if (_orchestrator) _orchestrator.setPaused(true);
        await ctx.reply('⏸ Agent paused. Send /resume to restart.');
        logger.info('Agent paused via /pause');
    });

    bot.command('resume', async (ctx) => {
        if (String(ctx.from.id) !== CHAT_ID) return;
        if (_orchestrator) _orchestrator.setPaused(false);
        await ctx.reply('▶️ Agent resumed.');
        logger.info('Agent resumed via /resume');
    });

    bot.command('status', async (ctx) => {
        if (String(ctx.from.id) !== CHAT_ID) return;
        const stats = memory.getHourlyStats();
        await hourlyReport(stats);
    });

    bot.command('budget', async (ctx) => {
        if (String(ctx.from.id) !== CHAT_ID) return;
        const budget = budgetGuardian.getBudgetStatus();
        const log = memory.getBudgetLog();
        const modelStats = getModelStats(log);

        const msg = `💰 *Budget Status*
Today: $${budget.todayUSD.toFixed(2)} | Month: $${budget.monthUSD.toFixed(2)}/$${budget.hardStopUSD.toFixed(2)}
Calls today — Free: ${budget.callsByModel.FREE || 0} | Cheap: ${budget.callsByModel.CHEAP || 0} | Balanced: ${budget.callsByModel.BALANCED || 0}
Total calls today: ${budget.totalCallsToday || 0}
Paused: ${budget.paused ? `Yes (until ${budget.pausedUntil})` : 'No'}`;

        await ctx.reply(msg, { parse_mode: 'Markdown' });
    });

    bot.command('queue', async (ctx) => {
        if (String(ctx.from.id) !== CHAT_ID) return;
        const queue = memory.getExternalQueue().filter(q => !q.isBorderline);
        if (queue.length === 0) {
            await ctx.reply('📋 External queue is empty. All caught up!');
            return;
        }
        let msg = '📋 *External Apply Queue*\n\n';
        for (const job of queue.slice(0, 10)) {
            msg += `🏢 *${job.company}* — ${job.title}\n💯 Match: ${job.matchScore}% | 💰 ${job.salary || 'N/A'}\n🔗 ${job.url}\n\n`;
        }
        if (queue.length > 10) msg += `...and ${queue.length - 10} more`;
        await ctx.reply(msg, { parse_mode: 'Markdown' });
    });

    bot.command('borderline', async (ctx) => {
        if (String(ctx.from.id) !== CHAT_ID) return;
        const queue = memory.getExternalQueue().filter(q => q.isBorderline);
        if (queue.length === 0) {
            await ctx.reply('🟢 No borderline jobs pending. All clear!');
            return;
        }
        for (const job of queue.slice(0, 5)) {
            await sendInlineKeyboard(
                `🟡 *Borderline Match (${job.matchScore}%)*\n🏢 ${job.company} — ${job.title}\n💰 ${job.salary || 'N/A'}\n📝 ${job.jdSummary || 'No summary'}\n🔗 ${job.url}`,
                [
                    [
                        { text: '✅ Apply', callback_data: `apply_${job.jobId}` },
                        { text: '❌ Skip', callback_data: `skip_${job.jobId}` },
                    ],
                ]
            );
        }
    });

    bot.command('blocklist', async (ctx) => {
        if (String(ctx.from.id) !== CHAT_ID) return;
        const company = ctx.message.text.replace('/blocklist', '').trim();
        if (!company) {
            await ctx.reply('Usage: /blocklist CompanyName');
            return;
        }
        memory.addToBlocklist(company);
        await ctx.reply(`🚫 "${company}" added to blocklist. Will skip this company in future.`);
        logger.info(`Blocklisted: ${company}`);
    });

    bot.command('battlecard', async (ctx) => {
        if (String(ctx.from.id) !== CHAT_ID) return;
        const input = ctx.message.text.replace('/battlecard', '').trim();
        if (!input) {
            await ctx.reply('Usage: /battlecard CompanyName');
            return;
        }
        await ctx.reply(`Generating battle card for "${input}"...`);
        try {
            const { generateBattleCard } = require('./interview-prep');
            // Try to find a matching applied job for more context
            const allApplied = memory.getAppliedJobs();
            const match = allApplied.find(j =>
                j.company && j.company.toLowerCase().includes(input.toLowerCase())
            );
            const jobTitle = match ? match.title : '';
            const jdText = match ? (match.jdSummary || '') : '';
            const card = await generateBattleCard(input, jobTitle, jdText);
            if (card) {
                // Split long messages (Telegram limit is 4096 chars)
                if (card.length > 4000) {
                    const chunks = card.match(/.{1,4000}/gs) || [card];
                    for (const chunk of chunks) {
                        await sendMessage(chunk);
                    }
                } else {
                    await sendMessage(card);
                }
            } else {
                await ctx.reply('Failed to generate battle card. Try again later.');
            }
        } catch (err) {
            logger.error(`Battle card command error: ${err.message}`);
            await ctx.reply('Error generating battle card.');
        }
    });

    bot.command('stop', async (ctx) => {
        if (String(ctx.from.id) !== CHAT_ID) return;
        if (_orchestrator) _orchestrator.setEmergencyStop();
        await ctx.reply('Emergency stop activated. Restart container to resume.');
        logger.warn('Emergency stop via /stop');
    });

    // ─── Callback Queries (inline button clicks) ───
    bot.on('callback_query', async (ctx) => {
        const data = ctx.callbackQuery.data;
        if (!data) return;

        if (data.startsWith('apply_')) {
            const jobId = data.replace('apply_', '');
            await ctx.answerCbQuery('Applying...');
            // Find job in queue
            const queue = memory.getExternalQueue();
            const job = queue.find(q => q.jobId === jobId);
            if (job) {
                memory.removeFromExternalQueue(jobId);
                memory.logApplication({
                    jobId: job.jobId, company: job.company, title: job.title, url: job.url,
                    matchScore: job.matchScore, salary: job.salary || '',
                    recruiterName: '', recruiterMessageSent: false,
                    status: 'applied', jdSummary: job.jdSummary || '',
                    topGap: '', topStrength: '',
                });
                await ctx.editMessageText(`✅ Applied to *${job.company}* — ${job.title}`, { parse_mode: 'Markdown' });
            } else {
                await ctx.editMessageText('Job not found in queue.');
            }
        }

        if (data.startsWith('skip_')) {
            const jobId = data.replace('skip_', '');
            await ctx.answerCbQuery('Skipped.');
            memory.removeFromExternalQueue(jobId);
            memory.logApplication({
                jobId, company: '', title: '', url: '',
                matchScore: 0, salary: '', recruiterName: '',
                recruiterMessageSent: false, status: 'skipped',
                jdSummary: '', topGap: '', topStrength: '',
            });
            await ctx.editMessageText('❌ Skipped.');
        }
    });
}

// ─── Start Bot ───
async function startBot() {
    registerCommands();
    // Wire budget alerts to Telegram
    budgetGuardian.onAlert((title, body) => {
        sendAlert(title, body).catch(() => { });
    });
    bot.launch();
    logger.info('Telegram bot launched');
}

module.exports = {
    bot,
    sendMessage,
    sendAlert,
    sendInlineKeyboard,
    hourlyReport,
    startBot,
    setOrchestrator,
};
