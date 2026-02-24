// src/profile-learner.js — Learns from applied JDs and improves the profile
const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');
const { callGemini } = require('./gemini');
const memory = require('./memory');

const PROFILE_PATH = path.resolve('memory/profile.json');
const LEARNING_LOG_PATH = path.resolve('memory/learning-log.json');

// Initialize learning log
if (!fs.existsSync(LEARNING_LOG_PATH)) {
    fs.writeFileSync(LEARNING_LOG_PATH, JSON.stringify({ lastLearnedAt: null, skillsAdded: [], rolesAdded: [], totalLearnings: 0 }, null, 2));
}

/**
 * Analyze recent successful applications and extract new skills/keywords
 * that appear frequently in JDs but aren't in the user's profile.
 * Runs once per day maximum.
 */
async function learnFromAppliedJobs() {
    const log = JSON.parse(fs.readFileSync(LEARNING_LOG_PATH, 'utf8'));
    const today = new Date().toISOString().slice(0, 10);

    // Only run once per day
    if (log.lastLearnedAt === today) {
        return { learned: false, reason: 'Already learned today' };
    }

    const profile = memory.loadProfile();
    const applied = memory.getAppliedJobs();

    // Get today's applications with JD snippets
    const todayJobs = applied.filter(j =>
        j.appliedAt && j.appliedAt.startsWith(today) && j.jdSummary
    );

    if (todayJobs.length < 3) {
        return { learned: false, reason: 'Not enough applications today for learning' };
    }

    // Collect all JD text
    const jdTexts = todayJobs
        .map(j => `${j.title} at ${j.company}: ${j.jdSummary}`)
        .slice(0, 15)  // Max 15 to keep token usage low
        .join('\n---\n');

    const prompt = `You are analyzing job descriptions that a senior operations leader was matched with.

Current Profile Skills: ${profile.skills.join(', ')}
Current Target Roles: ${profile.targetRoles.slice(0, 10).join(', ')}

Recent Job Applications (JD snippets):
${jdTexts.substring(0, 2000)}

Based on these JDs, suggest:
1. Up to 5 NEW skills that frequently appear in these JDs but are NOT already in the profile (don't repeat existing ones)
2. Up to 3 NEW role titles that would be worth searching for

Respond as JSON:
{
  "newSkills": ["skill1", "skill2"],
  "newRoles": ["role1", "role2"],
  "insight": "One-sentence insight about market trends from these JDs"
}`;

    try {
        const result = await callGemini(prompt, 'keyword_extraction', { json: true });
        if (!result || !result.newSkills) return { learned: false, reason: 'Gemini returned no data' };

        const changes = { skillsAdded: [], rolesAdded: [], insight: result.insight || '' };

        // Add new skills (deduplicate)
        const existingSkills = new Set(profile.skills.map(s => s.toLowerCase()));
        for (const skill of (result.newSkills || [])) {
            if (!existingSkills.has(skill.toLowerCase())) {
                profile.skills.push(skill);
                changes.skillsAdded.push(skill);
                existingSkills.add(skill.toLowerCase());
            }
        }

        // Add new roles (deduplicate)
        const existingRoles = new Set(profile.targetRoles.map(r => r.toLowerCase()));
        for (const role of (result.newRoles || [])) {
            if (!existingRoles.has(role.toLowerCase())) {
                profile.targetRoles.push(role);
                changes.rolesAdded.push(role);
                existingRoles.add(role.toLowerCase());
            }
        }

        // Save updated profile (cap skills at 50, roles at 15 to prevent unbounded growth)
        if (changes.skillsAdded.length > 0 || changes.rolesAdded.length > 0) {
            if (profile.skills.length > 50) profile.skills = profile.skills.slice(-50);
            if (profile.targetRoles.length > 15) profile.targetRoles = profile.targetRoles.slice(0, 15);
            fs.writeFileSync(PROFILE_PATH, JSON.stringify(profile, null, 2));
            logger.info(`Profile updated: +${changes.skillsAdded.length} skills, +${changes.rolesAdded.length} roles (total: ${profile.skills.length} skills, ${profile.targetRoles.length} roles)`);
        }

        // Update learning log (trim arrays to prevent unbounded growth)
        log.lastLearnedAt = today;
        log.totalLearnings++;
        log.skillsAdded.push(...changes.skillsAdded);
        log.rolesAdded.push(...changes.rolesAdded);
        if (log.skillsAdded.length > 50) log.skillsAdded = log.skillsAdded.slice(-50);
        if (log.rolesAdded.length > 50) log.rolesAdded = log.rolesAdded.slice(-50);
        fs.writeFileSync(LEARNING_LOG_PATH, JSON.stringify(log, null, 2));

        return { learned: true, ...changes };
    } catch (err) {
        logger.warn(`Profile learning failed: ${err.message}`);
        return { learned: false, reason: err.message };
    }
}

/**
 * Format learning results for Telegram notification.
 */
function formatLearningForTelegram(result) {
    if (!result.learned) return null;
    const parts = ['-- Profile Self-Learning --'];
    if (result.skillsAdded.length > 0) parts.push(`New Skills Added: ${result.skillsAdded.join(', ')}`);
    if (result.rolesAdded.length > 0) parts.push(`New Search Roles: ${result.rolesAdded.join(', ')}`);
    if (result.insight) parts.push(`Market Insight: ${result.insight}`);
    return parts.join('\n');
}

module.exports = { learnFromAppliedJobs, formatLearningForTelegram };
