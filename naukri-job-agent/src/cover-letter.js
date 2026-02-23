// src/cover-letter.js — Auto-drafted cover letters via Gemini Pro
const { logger } = require('./logger');
const { callGemini } = require('./gemini');

/**
 * Generate a concise, punchy cover letter tailored to the JD.
 * Uses the user's CAR metrics and profile data.
 *
 * @param {string} jdText — Full job description text
 * @param {object} job — { title, company, salary, url }
 * @param {object} profile — Profile from memory/profile.json
 * @returns {string|null} Cover letter text or null on failure
 */
async function generateCoverLetter(jdText, job, profile) {
    const prompt = `You are a senior executive career coach. Write a brief, impactful cover letter for the following job.

RULES:
- Exactly 3 paragraphs, max 150 words total.
- Paragraph 1 (Hook): Mention the specific role and company. Show genuine interest.
- Paragraph 2 (Value Prop): Reference 2-3 specific achievements from the candidate's resume that directly map to the JD requirements. Use numbers and metrics.
- Paragraph 3 (CTA): Express enthusiasm and suggest a conversation.
- Tone: Confident, senior-executive level. Not generic.
- Do NOT use placeholders like [Company] — use actual names.
- Sign off with the candidate's name.

Candidate Profile:
- Name: ${profile.name}
- Experience: ${profile.totalExperience}
- Education: ${profile.education}
- Certifications: ${profile.certifications.join(', ')}
- Key Achievements:
${profile.resumeBullets.slice(0, 6).map(b => `  • ${b}`).join('\n')}

Job:
- Title: ${job.title}
- Company: ${job.company}
- Description: ${jdText.substring(0, 2000)}

Write the cover letter now:`;

    try {
        const letter = await callGemini(prompt, 'recruiter_message');
        if (letter && letter.length > 50) {
            logger.info(`Cover letter generated for ${job.title} at ${job.company} (${letter.length} chars)`);
            return letter;
        }
        logger.warn('Cover letter generation returned empty/short result');
        return null;
    } catch (err) {
        logger.warn(`Cover letter generation failed: ${err.message}`);
        return null;
    }
}

module.exports = { generateCoverLetter };
