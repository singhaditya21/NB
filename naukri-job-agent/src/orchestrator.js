// src/orchestrator.js — Main cycle coordinator
const { logger } = require('./logger');
const memory = require('./memory');
const { callGemini, budgetGuardian, randomDelay } = require('./gemini');
const { sendMessage, sendAlert, hourlyReport } = require('./telegram');
const naukriAgent = require('./naukri-agent');
const jdAnalyzer = require('./jd-analyzer');
const { generateCoverLetter } = require('./cover-letter');
const { extractContactInfo, formatContactForTelegram } = require('./outreach-extractor');

// ─── Module-level state ───
let isPaused = false;
let isRunning = false;
let emergencyStop = false;

function setPaused(val) {
    isPaused = val;
    logger.info(`Orchestrator: isPaused=${val}`);
}

function setEmergencyStop() {
    emergencyStop = true;
    isPaused = true;
    isRunning = false;
    naukriAgent.closeBrowser().catch(() => { });
    logger.warn('EMERGENCY STOP activated');
}

function getState() {
    return { isPaused, isRunning, emergencyStop };
}

// ─── 1. runNaukriCycle — KEYWORD-ONLY (no Gemini in the apply loop) ───
async function runNaukriCycle() {
    if (isPaused || isRunning || emergencyStop) {
        logger.info(`Cycle skipped: paused=${isPaused} running=${isRunning} emergency=${emergencyStop}`);
        return;
    }

    isRunning = true;
    let page;
    let cycleApplied = 0;
    let cycleSkipped = 0;

    try {
        const result = await naukriAgent.createBrowser();
        page = result.page;

        // Only login if not already logged in
        if (!naukriAgent.isLoggedIn()) {
            const loginResult = await naukriAgent.login(page);
            if (!loginResult.success) {
                await sendAlert('Login Failed', `Reason: ${loginResult.reason}. Retrying next cycle.`);
                return;
            }
            naukriAgent.setLoggedIn(true);
        } else {
            logger.info('Using existing login session');
        }

        const profile = memory.loadProfile();

        // Rotate through roles — pick 3 random roles per cycle
        const shuffledRoles = [...profile.targetRoles].sort(() => Math.random() - 0.5);
        const rolesThisCycle = shuffledRoles.slice(0, 3);

        for (const role of rolesThisCycle) {
            if (isPaused || emergencyStop) break;

            logger.info(`Searching for role: ${role}`);

            const jobs = await naukriAgent.searchJobs(page, {
                keywords: role,
                experienceMin: 10,
                experienceMax: 20,
                location: 'Delhi NCR',
                postedWithin: '7',
                maxPages: 1,
            });

            if (jobs.length === 0) {
                logger.info(`No jobs found for: ${role}`);
                continue;
            }

            // Filter already applied + blocklisted
            const newJobs = jobs.filter(j => {
                if (memory.hasApplied(j.jobId)) return false;
                if (memory.isCompanyBlocked(j.company)) return false;
                return true;
            });

            logger.info(`${newJobs.length} new jobs for: ${role}`);
            if (newJobs.length === 0) continue;

            const keywordScreen = jdAnalyzer.keywordFallbackScreen;
            for (const job of newJobs) {
                if (isPaused || emergencyStop) break;

                const score = keywordScreen(
                    `${job.title} ${job.company} ${job.salary || ''} ${job.jdSnippet || ''}`,
                    profile,
                    job
                );

                if (score.quickScore < 45) {
                    cycleSkipped++;
                    continue;
                }

                if (job.isEasyApply) {
                    try {
                        const applyResult = await naukriAgent.applyEasyApply(page, job.url, profile);

                        // If logged out, re-login and retry once
                        if (!applyResult.success && applyResult.reason === 'not_logged_in') {
                            logger.info('Session expired — re-logging in...');
                            const loginResult = await naukriAgent.login(page);
                            if (loginResult.success) {
                                naukriAgent.setLoggedIn(true);
                                // Retry apply
                                const retry = await naukriAgent.applyEasyApply(page, job.url, profile);
                                if (retry.success) {
                                    cycleApplied++;
                                    logSuccessfulApply(job, score);
                                    queueJDForFeedback(job);
                                }
                            }
                            continue;
                        }

                        if (applyResult.success) {
                            cycleApplied++;
                            logSuccessfulApply(job, score);
                            queueJDForFeedback(job);

                            // ─── Premium pipeline for high-score jobs ───
                            if (score.quickScore >= 70) {
                                try {
                                    const jdText = job.jdSnippet || `${job.title} at ${job.company}`;

                                    // Cover letter
                                    const letter = await generateCoverLetter(jdText, job, profile);
                                    if (letter) {
                                        await sendMessage(`-- COVER LETTER --\n${job.title} at ${job.company}\nScore: ${score.quickScore}\n\n${letter}`).catch(() => { });
                                    }

                                    // Contact extraction
                                    const contact = await extractContactInfo(jdText, job);
                                    if (contact) {
                                        await sendMessage(formatContactForTelegram(contact)).catch(() => { });
                                    }
                                } catch (premErr) {
                                    logger.warn(`Premium pipeline error: ${premErr.message}`);
                                }
                            }
                        }
                    } catch (applyErr) {
                        logger.warn(`Apply failed: ${job.title} — ${applyErr.message}`);
                    }
                } else {
                    memory.addToExternalQueue({
                        jobId: job.jobId, company: job.company, title: job.title, url: job.url,
                        matchScore: score.quickScore, salary: job.salary || '',
                        jdSummary: `Keyword match score: ${score.quickScore}`,
                        isBorderline: false,
                    });
                    memory.updateHourlyStats({ externalQueueCount: 1 });
                }

                await randomDelay(3000, 6000);
            }
        }

        logger.info(`Cycle complete: applied=${cycleApplied} skipped=${cycleSkipped}`);

        // ─── Profile Refresh — resume upload + headline edit ───
        try {
            logger.info('Refreshing profile (resume + headline)...');
            const refreshResult = await naukriAgent.refreshProfileTimestamp(page);

            // Send Telegram profile update notification
            const parts = [];
            parts.push('-- Profile Updated --');
            if (refreshResult.resumeUploaded) parts.push('Resume: Uploaded');
            else parts.push('Resume: Skipped');
            if (refreshResult.headlineUpdated) parts.push('Headline: Saved');
            else parts.push('Headline: Skipped');
            parts.push('Time: ' + (refreshResult.time || new Date().toLocaleTimeString('en-IN')));
            parts.push('Applied this cycle: ' + cycleApplied);

            try {
                await sendMessage(parts.join('\n'));
                logger.info('Telegram profile notification sent');
            } catch (tgErr) {
                logger.warn('Telegram profile notification failed: ' + tgErr.message);
            }
        } catch (refreshErr) {
            logger.warn(`Profile refresh failed: ${refreshErr.message}`);
            await sendAlert('⚠️ Profile Refresh Failed', refreshErr.message).catch(() => { });
        }
    } catch (err) {
        logger.error(`Naukri cycle error: ${err.message}`);
        await sendAlert('Cycle Error', err.message).catch(() => { });
    } finally {
        // DO NOT close the browser — keep session alive for next cycle
        isRunning = false;
    }
}

// Helper to log a successful application
function logSuccessfulApply(job, score) {
    memory.logApplication({
        jobId: job.jobId, company: job.company, title: job.title, url: job.url,
        matchScore: score.quickScore, salary: job.salary || '',
        recruiterName: '', recruiterMessageSent: false,
        status: 'applied', jdSummary: '',
        topGap: '', topStrength: '',
    });
    memory.updateHourlyStats({ appliedThisHour: 1, appliedToday: 1 });
    const stats = memory.getHourlyStats();
    if (!stats.topMatchThisHour || score.quickScore > (stats.topMatchThisHour.matchScore || 0)) {
        memory.updateHourlyStats({
            topMatchThisHour: {
                company: job.company, title: job.title,
                salary: job.salary || '', matchScore: score.quickScore,
            },
        });
    }
    logger.info(`✅ Applied: ${job.title} at ${job.company} (keyword score=${score.quickScore})`);
}

// ─── JD Feedback Queue (deferred Gemini calls for resume improvement) ───
const _jdFeedbackQueue = [];

function queueJDForFeedback(job) {
    _jdFeedbackQueue.push({
        jobId: job.jobId, company: job.company, title: job.title, url: job.url,
        jdSnippet: job.jdSnippet || '', queuedAt: new Date().toISOString(),
    });
    // Keep queue manageable
    if (_jdFeedbackQueue.length > 20) _jdFeedbackQueue.shift();
}

// Called once per hour (not every 5 min) to get Gemini resume feedback
async function runResumeFeedback() {
    if (isPaused || emergencyStop || isRunning) return;
    if (_jdFeedbackQueue.length === 0) return;

    const profile = memory.loadProfile();
    const jobs = _jdFeedbackQueue.splice(0, 5); // Process 5 at a time

    const jdSummaries = jobs.map(j => `• ${j.title} at ${j.company}: ${j.jdSnippet.slice(0, 200)}`).join('\n');

    const prompt = `You are a career coach reviewing job applications for ${profile.name}.
${profile.totalExperience} experience, current role: Global Operations & Biz-Tech Leader.
Education: ${profile.education}
Certifications: ${profile.certifications.join(', ')}

Here are JDs the candidate recently applied to:
${jdSummaries}

Based on these roles, provide:
1. Top 3 skills or keywords the candidate should add to their Naukri profile
2. One resume headline improvement suggestion
3. Any gaps you notice between these JDs and the candidate's profile

Return ONLY valid JSON:
{"profileKeywords": ["kw1","kw2","kw3"], "headlineSuggestion": "...", "gapAnalysis": "one sentence"}`;

    const feedback = await callGemini(prompt, 'hourly_insight', { json: true });
    if (feedback) {
        const msg = `📝 *Resume Feedback (based on ${jobs.length} recent JDs)*

🔑 *Add to Profile:* ${(feedback.profileKeywords || []).join(', ')}
📄 *Headline:* ${feedback.headlineSuggestion || 'N/A'}
⚠️ *Gap:* ${feedback.gapAnalysis || 'None identified'}`;

        await sendMessage(msg);
        logger.info('Resume feedback sent via Telegram');
    }
}

// ─── 2. runFollowUpCycle ───
async function runFollowUpCycle() {
    if (isPaused || emergencyStop) return;
    if (budgetGuardian.isBudgetPaused()) return;

    try {
        const jobs = memory.getAppliedJobs();
        const now = Date.now();
        const threshold = 48 * 60 * 60 * 1000; // 48 hours

        const needsFollowUp = jobs.filter(j => {
            if (j.status !== 'applied') return false;
            if (!j.appliedAt) return false;
            const elapsed = now - new Date(j.appliedAt).getTime();
            return elapsed > threshold;
        });

        if (needsFollowUp.length === 0) return;

        const profile = memory.loadProfile();
        logger.info(`Follow-up candidates: ${needsFollowUp.length}`);

        for (const job of needsFollowUp.slice(0, 5)) {
            if (budgetGuardian.isBudgetPaused()) break;

            const prompt = `Write a polite 2-sentence follow-up message for ${profile.name} who applied to ${job.title} at ${job.company} 2+ days ago. Reference the specific role and express continued interest. Do NOT use generic phrases. Return only the message text.`;

            const followUp = await callGemini(prompt, 'follow_up_draft');
            if (followUp) {
                logger.info(`Follow-up drafted for ${job.company}: ${followUp.slice(0, 50)}...`);
                // Note: Actually sending requires browser session — log for Telegram report
                await sendMessage(`📬 *Follow-up Ready*\n🏢 ${job.company} — ${job.title}\n\n${followUp}`);
            }
        }
    } catch (err) {
        logger.error(`Follow-up cycle error: ${err.message}`);
    }
}

// ─── 3. runStatusCheck ───
async function runStatusCheck() {
    if (isPaused || emergencyStop || isRunning) return;

    let page;
    try {
        const result = await naukriAgent.createBrowser();
        page = result.page;

        const loginResult = await naukriAgent.login(page);
        if (!loginResult.success) return;

        const statuses = await naukriAgent.checkApplicationStatus(page);

        // Update jobs that are now 'viewed'
        const appliedJobs = memory.getAppliedJobs();
        for (const status of statuses) {
            if (status.status.includes('viewed') || status.status.includes('seen')) {
                const job = appliedJobs.find(j =>
                    j.title.toLowerCase().includes(status.title.toLowerCase().slice(0, 20))
                );
                if (job && job.status === 'applied') {
                    memory.updateJobStatus(job.jobId, 'viewed');
                    await sendMessage(`👀 *${job.company}* viewed your application for *${job.title}*!`);
                }
            }
        }
    } catch (err) {
        logger.error(`Status check error: ${err.message}`);
    } finally {
        await naukriAgent.closeBrowser();
    }
}

// ─── 4. runProfileRefresh ───
async function runProfileRefresh() {
    if (isPaused || emergencyStop || isRunning) return;

    let page;
    try {
        const result = await naukriAgent.createBrowser();
        page = result.page;

        const loginResult = await naukriAgent.login(page);
        if (!loginResult.success) return;

        await naukriAgent.refreshProfileTimestamp(page);
        logger.info('Daily profile refresh completed');
    } catch (err) {
        logger.error(`Profile refresh error: ${err.message}`);
    } finally {
        await naukriAgent.closeBrowser();
    }
}

// ─── 5. generateHourlyInsight ───
async function generateHourlyInsight(stats) {
    if (budgetGuardian.isBudgetPaused()) return 'Budget paused — no insight generated.';

    const prompt = `You are an AI job search assistant. Generate exactly ONE sentence insight about today's job application activity.

Stats:
- Applied today: ${stats.appliedToday}
- Applied this hour: ${stats.appliedThisHour}
- Messages sent today: ${stats.messagesToday}
- Recruiter replies: ${stats.repliesToday}
- External queue: ${stats.externalQueueCount}
- Borderline jobs: ${stats.borderlineCount}
- Avg match score: ${stats.avgMatchScore}%

Return ONLY one sentence, no quotes, no prefix. Be specific and actionable.`;

    const insight = await callGemini(prompt, 'hourly_insight');
    return insight ? insight.trim() : 'Agent running smoothly.';
}

// ─── 6. runStatusReport (every 5 min — no AI call to save quota) ───
async function runHourlyReport() {
    if (emergencyStop) return;

    const stats = memory.getHourlyStats();
    stats.externalQueueCount = memory.getExternalQueue().length;

    await hourlyReport(stats);
}

module.exports = {
    runNaukriCycle,
    runFollowUpCycle,
    runStatusCheck,
    runProfileRefresh,
    runResumeFeedback,
    runHourlyReport,
    setPaused,
    setEmergencyStop,
    getState,
};
