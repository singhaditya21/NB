// src/interview-prep.js — Interview brief generator + Battle Cards
const { logger } = require('./logger');
const memory = require('./memory');
const { generateInterviewPrepBrief } = require('./jd-analyzer');
const { callGemini } = require('./gemini');
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

        const questionsStr = (brief.likelyQuestions || [])
            .map((q, i) => `${i + 1}. ${q.question}\n   -> ${q.suggestedAnswer}`)
            .join('\n\n');

        const researchStr = (brief.companyResearch || [])
            .map(p => `- ${p}`)
            .join('\n');

        const strengthsStr = (brief.keyStrengths || [])
            .map(s => `- ${s}`)
            .join('\n');

        const gapsStr = (brief.anticipatedGaps || [])
            .map(g => `- ${g.gap} -> ${g.howToAddress}`)
            .join('\n');

        const askStr = (brief.questionsToAsk || [])
            .map((q, i) => `${i + 1}. ${q}`)
            .join('\n');

        const msg = `INTERVIEW PREP BRIEF
${job.company} - ${job.title}

LIKELY QUESTIONS
${questionsStr || 'None generated'}

RESEARCH NOTES
${researchStr || 'No research points'}

YOUR KEY STRENGTHS
${strengthsStr || 'No strengths listed'}

GAPS TO ADDRESS
${gapsStr || 'No gaps identified'}

QUESTIONS TO ASK
${askStr || 'No questions generated'}`;

        await sendMessage(msg);
        logger.info(`Interview prep brief sent for ${job.company} - ${job.title}`);
    } catch (err) {
        logger.error(`Interview prep error: ${err.message}`);
    }
}

/**
 * 3. generateBattleCard — Pre-interview company briefing
 *    Triggered via /battlecard <company> Telegram command
 */
async function generateBattleCard(companyName, jobTitle, jdText) {
    const profile = memory.loadProfile();

    const prompt = `You are a senior executive career coach preparing a candidate for a high-stakes interview.

Generate a comprehensive "Battle Card" for this interview:

Company: ${companyName}
Role: ${jobTitle || 'Senior Leadership'}
${jdText ? `Job Description:\n${jdText.substring(0, 2000)}` : ''}

Candidate Profile:
- Name: ${profile.name}
- Experience: ${profile.totalExperience}
- Key Achievements:
${profile.resumeBullets.slice(0, 5).map(b => `  - ${b}`).join('\n')}

Generate the following sections:

1. COMPANY OVERVIEW: What does this company do? Industry, size, recent news or funding if inferable from context.
2. ROLE ANALYSIS: What are they really looking for? Read between the lines of the JD.
3. YOUR WINNING NARRATIVE: 3 talking points that directly connect the candidate's experience to this role. Use specific metrics.
4. LIKELY QUESTIONS (5): With suggested answers using the candidate's actual achievements.
5. RED FLAG QUESTIONS: 2-3 tricky questions they might ask and how to handle them.
6. QUESTIONS TO ASK (3): Insightful questions that show strategic thinking.
7. OPENING PITCH: A 30-second elevator pitch tailored to this specific role.

Format as plain text with clear section headers. Be specific, not generic.`;

    try {
        const card = await callGemini(prompt, 'interview_prep');
        if (card && card.length > 200) {
            logger.info(`Battle card generated for ${companyName} (${card.length} chars)`);
            return card;
        }
        return null;
    } catch (err) {
        logger.error(`Battle card generation failed: ${err.message}`);
        return null;
    }
}

module.exports = {
    detectUpcomingInterviews,
    generateAndSendBrief,
    generateBattleCard,
};

