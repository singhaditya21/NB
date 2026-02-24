// src/orchestrator.js — Main cycle coordinator
const { logger } = require('./logger');
const memory = require('./memory');
const { callGemini, budgetGuardian, randomDelay } = require('./gemini');
const { sendMessage, sendAlert, hourlyReport } = require('./telegram');
const naukriAgent = require('./naukri-agent');
const jdAnalyzer = require('./jd-analyzer');
const { generateCoverLetter } = require('./cover-letter');
const { extractContactInfo, formatContactForTelegram } = require('./outreach-extractor');

// Premium pipeline threshold — triggers cover letters, contacts, Gemini pitch
const PREMIUM_THRESHOLD = 55;

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
    const appliedThisCycle = new Set(); // Bug 5: prevent duplicate applies within same cycle

    try {
        const result = await naukriAgent.createBrowser();
        page = result.page;

        // Only login if not already logged in
        if (!naukriAgent.isLoggedIn()) {
            const loginResult = await naukriAgent.login(page);
            if (!loginResult.success) {
                await sendAlert('Login Failed', `Reason: ${loginResult.reason}. Retrying next cycle.`);
                // Bug 4: DON'T return here — fall through to finally so isRunning resets
                isRunning = false;
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
                maxPages: 2,
            });

            if (jobs.length === 0) {
                logger.info(`No jobs found for: ${role}`);
                continue;
            }

            // Filter already applied + blocklisted
            const newJobs = jobs.filter(j => {
                if (memory.hasApplied(j.jobId)) return false;
                if (appliedThisCycle.has(j.jobId)) return false; // Bug 5: skip if applied earlier in this cycle
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
                                    appliedThisCycle.add(job.jobId); // Bug 33: track in retry path too
                                    logSuccessfulApply(job, score);
                                    queueJDForFeedback(job);
                                }
                            }
                            continue;
                        }

                        if (applyResult.success) {
                            cycleApplied++;
                            appliedThisCycle.add(job.jobId); // Bug 5: mark applied in this cycle
                            logSuccessfulApply(job, score);
                            queueJDForFeedback(job);

                            // ─── Use getJDText for full JD extraction (Bug 8) ───
                            let jdText = job.jdSnippet || `${job.title} at ${job.company}`;
                            let recruiterName = '';
                            try {
                                const jdData = await naukriAgent.getJDText(page, job.url);
                                if (jdData && jdData.jdText && jdData.jdText.length > 50) {
                                    jdText = jdData.jdText;
                                    recruiterName = jdData.recruiterName || '';
                                    logger.info(`📄 Full JD extracted: ${jdText.length} chars for ${job.company}`);
                                }
                            } catch (jdErr) {
                                logger.warn(`JD extraction failed: ${jdErr.message}`);
                            }

                            // ─── Contact extraction on ALL applied jobs (uses full JD text) ───
                            try {
                                const contact = await extractContactInfo(jdText, job);
                                if (contact && (contact.emails.length > 0 || contact.phones.length > 0 || contact.linkedinUrls.length > 0)) {
                                    logger.info(`📧 Contact found: ${job.company} — emails=${contact.emails.length} phones=${contact.phones.length} linkedin=${contact.linkedinUrls.length}`);
                                    await sendMessage(formatContactForTelegram(contact)).catch(() => { });
                                }
                            } catch (cErr) {
                                logger.warn(`Contact extraction failed: ${cErr.message}`);
                            }

                            // ─── Premium pipeline for 55+ score jobs ───
                            if (score.quickScore >= PREMIUM_THRESHOLD) {
                                logger.info(`🌟 Premium pipeline triggered: ${job.title} at ${job.company} (score ${score.quickScore})`);
                                try {
                                    // Cover letter via Gemini
                                    const letter = await generateCoverLetter(jdText, job, profile);
                                    if (letter && letter.length > 50) {
                                        logger.info(`📝 Cover letter generated for ${job.company} (${letter.length} chars)`);
                                        memory.updateHourlyStats({ coverLettersToday: 1 });
                                        // Bug 30: send as plain text to avoid garbled escaping
                                        await sendMessage(`📝 Cover Letter — ${job.title} at ${job.company} (Score: ${score.quickScore})\n\n${letter}`).catch(() => { });
                                    } else {
                                        logger.warn(`Cover letter generation returned empty/short result`);
                                    }
                                } catch (premErr) {
                                    logger.warn(`Premium pipeline error: ${premErr.message}`);
                                }
                            }

                            // ─── Auto Recruiter Outreach ───
                            // Bug 31: check if already messaged this company
                            if (memory.hasMessagedRecruiter(job.company)) {
                                logger.info(`Already messaged recruiter at ${job.company} — skipping`);
                            } else {
                                try {
                                    // Generate Gemini-powered pitch (falls back to hardcoded)
                                    let pitch;
                                    try {
                                        pitch = await jdAnalyzer.generateRecruiterMessage(job, { matchScore: score.quickScore }, profile);
                                    } catch {
                                        pitch = `Hi, I'm ${profile.name} with ${profile.totalExperience} experience. I just applied for the ${job.title} role — my background in scaling enterprise operations aligns well. Would love to connect.`;
                                    }

                                    const msgResult = await naukriAgent.sendRecruiterMessage(page, recruiterName, pitch);
                                    if (msgResult.success) {
                                        logger.info(`✉️ Recruiter message sent for ${job.title} at ${job.company}`);
                                        await sendMessage(`✉️ Recruiter Messaged: ${job.title} at ${job.company}`).catch(() => { });
                                        memory.updateHourlyStats({ messagesToday: 1 });
                                        // Bug 11: persist recruiter message
                                        memory.logRecruiterMessage({
                                            company: job.company, title: job.title, jobId: job.jobId,
                                            recruiterName: recruiterName, message: pitch.slice(0, 200),
                                        });
                                    } else {
                                        logger.warn(`Recruiter msg not available: ${msgResult.reason} (${job.company})`);
                                    }
                                } catch (msgErr) {
                                    logger.warn(`Recruiter outreach error: ${msgErr.message}`);
                                }
                            } // end hasMessagedRecruiter check
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
            const ts = refreshResult.time || new Date().toLocaleTimeString('en-IN');
            logger.info(`Profile refresh: resume=${refreshResult.resumeUploaded} headline=${refreshResult.headlineUpdated} at ${ts}`);
        } catch (refreshErr) {
            logger.warn(`Profile refresh failed: ${refreshErr.message}`);
        }

        // ─── Smart Telegram: only send when something changed ───
        if (cycleApplied > 0) {
            try {
                const allApplied = memory.getAppliedJobs();
                const today = new Date().toISOString().slice(0, 10);
                const todayTotal = allApplied.filter(j => j.appliedAt && j.appliedAt.startsWith(today)).length;
                const recentJobs = allApplied
                    .filter(j => j.appliedAt && j.appliedAt.startsWith(today))
                    .slice(-cycleApplied)
                    .map(j => `- ${j.title} at ${j.company}`)
                    .join('\n');

                const msg = `-- ${cycleApplied} New Application${cycleApplied > 1 ? 's' : ''} --\n${recentJobs}\nTotal today: ${todayTotal}`;
                await sendMessage(msg).catch(() => { });
            } catch { }
        }

        // ─── Profile Self-Learning (once per day) ───
        try {
            const { learnFromAppliedJobs, formatLearningForTelegram } = require('./profile-learner');
            const learning = await learnFromAppliedJobs();
            if (learning.learned) {
                const msg = formatLearningForTelegram(learning);
                if (msg) await sendMessage(msg).catch(() => { });
            }
        } catch (learnErr) {
            logger.debug(`Profile learning skipped: ${learnErr.message}`);
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
            if (j.status !== 'applied') return false; // Bug 26: skip already followed_up
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
                await sendMessage(`📬 *Follow-up Ready*\n🏢 ${job.company} — ${job.title}\n\n${followUp}`);
                // Bug 26: mark as followed_up so it's not re-drafted every 3 hours
                memory.updateJobStatus(job.jobId, 'followed_up');
            }
        }
    } catch (err) {
        logger.error(`Follow-up cycle error: ${err.message}`);
    }
}

// ─── 3. runStatusCheck ───
async function runStatusCheck() {
    if (isPaused || emergencyStop || isRunning) return;

    try {
        const result = await naukriAgent.createBrowser();
        const page = result.page;

        // Reuse existing login — don't re-login (Bug 1: would force new session)
        if (!naukriAgent.isLoggedIn()) {
            const loginResult = await naukriAgent.login(page);
            if (!loginResult.success) return;
            naukriAgent.setLoggedIn(true);
        }

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
    }
    // Bug 1: DO NOT close browser — it's shared with runNaukriCycle
}

// ─── 4. runProfileRefresh ───
async function runProfileRefresh() {
    if (isPaused || emergencyStop || isRunning) return;

    try {
        const result = await naukriAgent.createBrowser();
        const page = result.page;

        // Reuse existing login (Bug 1: don't destroy shared session)
        if (!naukriAgent.isLoggedIn()) {
            const loginResult = await naukriAgent.login(page);
            if (!loginResult.success) return;
            naukriAgent.setLoggedIn(true);
        }

        await naukriAgent.refreshProfileTimestamp(page);
        logger.info('Daily profile refresh completed');
    } catch (err) {
        logger.error(`Profile refresh error: ${err.message}`);
    }
    // Bug 1: DO NOT close browser — it's shared with runNaukriCycle
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
