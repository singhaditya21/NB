// src/interview-prep.js — Interview brief generator
const { logger } = require('./logger');
const memory = require('./memory');
const { generateInterviewPrepBrief } = require('./jd-analyzer');
const { sendMessage } = require('./telegram');

/**
 * 1. detectUpcomingInterviews — Get jobs with status='interview'
 */
function detectUpcomingInterviews() {
    const jobs = memory.getAppliedJobs();
    return jobs.filter(j => j.status === 'interview');
}

/**
 * 2. generateAndSendBrief — Generate and send interview prep to Telegram
 */
async function generateAndSendBrief(job) {
    const profile = memory.loadProfile();

    try {
        const brief = await generateInterviewPrepBrief(job, profile);
        if (!brief) {
            logger.warn(`Failed to generate interview brief for ${job.company}`);
            return;
        }

        // Format questions
        const questionsStr = (brief.likelyQuestions || [])
            .map((q, i) => `${i + 1}. *${q.question}*\n   → ${q.suggestedAnswer}`)
            .join('\n\n');

        // Format company research
        const researchStr = (brief.companyResearch || [])
            .map(p => `• ${p}`)
            .join('\n');

        // Format strengths
        const strengthsStr = (brief.keyStrengths || [])
            .map(s => `• ${s}`)
            .join('\n');

        // Format gaps
        const gapsStr = (brief.anticipatedGaps || [])
            .map(g => `• ${g.gap} → ${g.howToAddress}`)
            .join('\n');

        // Format questions to ask
        const askStr = (brief.questionsToAsk || [])
            .map((q, i) => `${i + 1}. ${q}`)
            .join('\n');

        const msg = `🎯 *INTERVIEW PREP BRIEF*
🏢 ${job.company} — ${job.title}

❓ *LIKELY QUESTIONS*
${questionsStr || 'None generated'}

🔍 *RESEARCH BEFORE INTERVIEW*
${researchStr || 'No research points'}

💪 *YOUR KEY STRENGTHS FOR THIS ROLE*
${strengthsStr || 'No strengths listed'}

⚠️ *ANTICIPATE THESE GAPS*
${gapsStr || 'No gaps identified'}

🤔 *ASK THE INTERVIEWER*
${askStr || 'No questions generated'}`;

        await sendMessage(msg);
        logger.info(`Interview prep brief sent for ${job.company} — ${job.title}`);
    } catch (err) {
        logger.error(`Interview prep error: ${err.message}`);
    }
}

module.exports = {
    detectUpcomingInterviews,
    generateAndSendBrief,
};
