// src/jd-analyzer.js — JD analysis + message generation
const { callGemini, batchCallGemini } = require('./gemini');
const { logger } = require('./logger');

/**
 * 0. keywordFallbackScreen — No-AI fallback when Gemini is rate-limited
 *    Uses keyword matching to give a basic score
 */
function keywordFallbackScreen(jdText, profile, job = null) {
    const text = (jdText || '').toLowerCase();
    let score = 40; // Base score

    // Positive role keywords (including AI ones)
    const roleKeywords = ['operations', 'director', 'head of', 'vp ', 'vice president', 'general manager',
        'chief', 'leader', 'strategy', 'transformation', 'program management', 'business operations',
        'senior manager', 'associate director', 'global', 'enterprise',
        'artificial intelligence', 'ai', 'machine learning', 'llm', 'generative ai'];

    for (const kw of roleKeywords) if (text.includes(kw)) score += 5;

    // Skill keywords from profile
    const skillKeywords = (profile.skills || []).map(s => s.toLowerCase());
    let skillHits = 0;
    for (const skill of skillKeywords) if (text.includes(skill)) skillHits++;
    score += Math.min(skillHits * 3, 20);

    // Location match
    const locations = (profile.targetLocations || []).map(l => l.toLowerCase());
    for (const loc of locations) if (text.includes(loc)) { score += 5; break; }

    // Experience range check
    if (text.includes('10+') || text.includes('10-') || text.includes('12+') || text.includes('15+') ||
        text.includes('8+') || text.includes('8-15') || text.includes('10-20')) score += 5;

    // Negative signals
    const negatives = ['intern', 'fresher', 'entry level', '0-2 years', '1-3 years', '2-4 years', 'junior'];
    for (const neg of negatives) if (text.includes(neg)) score -= 15;

    // Freshness Override (1 Day)
    if (job && job.postedDate) {
        const pd = job.postedDate.toLowerCase();
        if (pd.includes('just now') || pd.includes('few hours ago') ||
            pd.includes('today') || pd.includes('1 day ago') || pd.includes('1 day')) {
            logger.info(`🔥 Freshness Boost: Job posted ${job.postedDate} - forcing high score`);
            score += 100; // Guarantee apply
        }
    }

    score = Math.max(0, Math.min(100, score));
    const worthAnalyzing = score >= 50;

    logger.info(`Keyword fallback screen: score=${score} worthAnalyzing=${worthAnalyzing}`);
    return { worthAnalyzing, quickScore: score, reason: 'keyword-fallback (Gemini unavailable)' };
}

/**
 * 0b. keywordFallbackAnalyze — No-AI fallback for full analysis
 */
function keywordFallbackAnalyze(jdText, job, profile) {
    const screen = keywordFallbackScreen(jdText, profile);
    return {
        matchScore: screen.quickScore,
        requiredSkills: [],
        missingSkills: [],
        salary: job.salary || null,
        seniorityMatch: screen.quickScore >= 60,
        locationMatch: true,
        summary: `${job.title} at ${job.company} — keyword-matched (AI unavailable)`,
        recommendation: screen.quickScore >= 75 ? 'apply' : screen.quickScore >= 60 ? 'borderline' : 'skip',
        topGap: 'Could not analyze — Gemini unavailable',
        topStrength: 'Profile keywords match JD',
    };
}

/**
 * 1. screenJD — Quick cheap pass: is this worth full analysis?
 *    Falls back to keyword matching if Gemini is unavailable
 */
async function screenJD(jdText, profile) {
    const prompt = `You are a job match screener for ${profile.name}, a ${profile.totalExperience} experienced professional.
Current role: Global Operations & Biz-Tech Leader at BUSINESSNEXT.
Target: ${profile.targetRoles.join(', ')}.
Key skills: ${profile.skills.slice(0, 15).join(', ')}.
Expected salary: ${profile.expectedSalaryLPA} LPA+.
Location: ${profile.targetLocations.join(', ')}.

Quickly evaluate this JD:
"""
${jdText.slice(0, 2000)}
"""

Return ONLY valid JSON (no markdown fences):
{"worthAnalyzing": true/false, "quickScore": 0-100, "reason": "one line explanation"}

Rules:
- Score 50+ and worthAnalyzing=true if the role is senior operations/leadership/strategy
- Score <50 if clearly junior, unrelated domain, or wrong geography without remote option
- Be generous — borderline cases should be worthAnalyzing=true`;

    const result = await callGemini(prompt, 'jd_screening', { json: true });

    // Fallback to keyword screening if Gemini fails
    if (!result) {
        logger.info('Gemini unavailable for screening — using keyword fallback');
        return keywordFallbackScreen(jdText, profile);
    }
    return result;
}

/**
 * 2. analyzeJD — Full analysis for screened-in jobs
 */
async function analyzeJD(jdText, profile) {
    const prompt = `You are a senior career advisor analyzing a job for ${profile.name}.

CANDIDATE PROFILE:
- Experience: ${profile.totalExperience}
- Current: Global Operations & Biz-Tech Leader at BUSINESSNEXT (9+ years)
- Education: ${profile.education}
- Certifications: ${profile.certifications.join(', ')}
- Current CTC: ${profile.currentSalaryLPA} LPA | Expected: ${profile.expectedSalaryLPA} LPA+
- Location: ${profile.location} (open to: ${profile.targetLocations.join(', ')})
- Target roles: ${profile.targetRoles.join(', ')}

KEY ACHIEVEMENTS:
${profile.resumeBullets.slice(0, 8).map(b => '• ' + b).join('\n')}

KEY SKILLS:
${profile.skills.join(', ')}

JOB DESCRIPTION:
"""
${jdText.slice(0, 4000)}
"""

Analyze deeply and return ONLY valid JSON (no markdown fences):
{
  "matchScore": 0-100,
  "requiredSkills": ["skill1", "skill2"],
  "missingSkills": ["skill1"],
  "salary": "extracted salary string or null",
  "seniorityMatch": true/false,
  "locationMatch": true/false,
  "summary": "2 sentence JD summary",
  "recommendation": "apply|borderline|external|skip",
  "topGap": "single most critical missing requirement",
  "topStrength": "best matching aspect of candidate"
}

Scoring rules:
- 75+ = strong match, recommend "apply" (or "external" if requires manual apply)
- 60-74 = borderline, recommend "borderline"
- <60 = poor match, recommend "skip"
- Weigh operations/leadership experience heavily
- Penalize only for hard requirements the candidate clearly lacks
- Missing "nice to have" skills should not reduce score much`;

    const result = await callGemini(prompt, 'jd_analysis_full', { json: true });

    // Fallback to keyword analysis if Gemini fails
    if (!result) {
        logger.info('Gemini unavailable for full analysis — using keyword fallback');
        return keywordFallbackAnalyze(jdText, { title: 'Unknown', company: 'Unknown', salary: '' }, profile);
    }
    return result;
}

/**
 * 3. batchScreenJDs — Groups 5 jobs per call
 */
async function batchScreenJDs(jobsArray, profile) {
    const promptBuilder = (job) => {
        return `Job: ${job.title} at ${job.company}
Salary: ${job.salary || 'Not specified'}
JD excerpt: ${(job.jdSnippet || job.title || '').slice(0, 500)}`;
    };

    const batchPromptPrefix = `You are a job match screener for ${profile.name}, ${profile.totalExperience} experience.
Target roles: ${profile.targetRoles.join(', ')}.
Key skills: ${profile.skills.slice(0, 10).join(', ')}.
Expected salary: ${profile.expectedSalaryLPA} LPA+.

For each item, return: {"worthAnalyzing": true/false, "quickScore": 0-100, "reason": "one line"}
Score 50+ if senior operations/leadership, <50 if junior or unrelated.
Return ONLY a JSON array with one object per item, in the same order.

`;

    const results = [];
    const batchSize = 5;

    for (let i = 0; i < jobsArray.length; i += batchSize) {
        const batch = jobsArray.slice(i, i + batchSize);
        const itemsText = batch.map((job, idx) =>
            `--- ITEM ${idx + 1} ---\n${promptBuilder(job)}`
        ).join('\n\n');

        const fullPrompt = batchPromptPrefix + itemsText;
        const result = await callGemini(fullPrompt, 'jd_screening', { json: true });

        if (Array.isArray(result)) {
            batch.forEach((job, idx) => {
                results.push({
                    jobId: job.jobId || job.url,
                    ...(result[idx] || { worthAnalyzing: false, quickScore: 0, reason: 'batch parse error' }),
                });
            });
        } else {
            // Gemini failed — use keyword fallback for each job
            logger.info('Batch screening failed — using keyword fallback for this batch');
            batch.forEach(job => {
                const fallback = keywordFallbackScreen(
                    `${job.title} ${job.company} ${job.salary || ''} ${job.jdSnippet || ''}`,
                    profile
                );
                results.push({
                    jobId: job.jobId || job.url,
                    ...fallback,
                });
            });
        }
    }

    return results;
}

/**
 * 4. generateRecruiterMessage — 3 sentences, max 120 words
 */
async function generateRecruiterMessage(job, analysis, profile) {
    const prompt = `Write a concise recruiter message (exactly 3 sentences, max 120 words) for ${profile.name} applying to:

Role: ${job.title} at ${job.company}
Top strength match: ${analysis.topStrength}
Key matching skills: ${(analysis.requiredSkills || []).slice(0, 5).join(', ')}

Candidate highlights:
- ${profile.totalExperience} in operations & enterprise technology
- Currently at BUSINESSNEXT: 1,500+ users, global operations
- ${profile.education}
- Certifications: ${profile.certifications.slice(0, 4).join(', ')}

Rules:
- Sentence 1: specific hook referencing the role or something about the company
- Sentence 2: most relevant matching experience from profile
- Sentence 3: professional call to action
- NO generic openers like "I hope this message finds you well"
- NO "Dear Sir/Madam" — keep it conversational and professional
- Return ONLY the message text, nothing else`;

    return await callGemini(prompt, 'recruiter_message');
}

/**
 * 5. tailorResumeBullets — Reorder and rephrase for JD match
 */
async function tailorResumeBullets(analysis, profile) {
    const prompt = `Reorder and lightly rephrase these resume bullets to front-load keywords matching the JD.

JD requires: ${(analysis.requiredSkills || []).join(', ')}
Top strength: ${analysis.topStrength}
Top gap: ${analysis.topGap}

Resume bullets:
${profile.resumeBullets.map((b, i) => `${i + 1}. ${b}`).join('\n')}

Return ONLY a JSON array of the top 5 most relevant bullets (lightly rephrased to emphasize matching keywords).
Return valid JSON array of strings, no markdown fences.`;

    return await callGemini(prompt, 'resume_tailor', { json: true });
}

/**
 * 6. generateInterviewPrepBrief
 */
async function generateInterviewPrepBrief(job, profile) {
    const prompt = `Generate an interview prep brief for ${profile.name} interviewing at:

Company: ${job.company}
Role: ${job.title}
JD Summary: ${job.jdSummary || 'N/A'}

Candidate:
- ${profile.totalExperience} experience
- Current: Global Ops & Biz-Tech Leader at BUSINESSNEXT
- Key achievements: ${profile.resumeBullets.slice(0, 5).map(b => b.slice(0, 100)).join('; ')}
- Certifications: ${profile.certifications.join(', ')}

Return ONLY valid JSON (no markdown fences):
{
  "likelyQuestions": [{"question": "", "suggestedAnswer": ""}],
  "companyResearch": ["point1", "point2", "point3"],
  "questionsToAsk": ["q1", "q2"],
  "keyStrengths": ["s1", "s2", "s3"],
  "anticipatedGaps": [{"gap": "", "howToAddress": ""}]
}

Include exactly 5 likely questions, 3 company research points, 2 questions to ask, 3 key strengths, and 1-2 anticipated gaps.`;

    return await callGemini(prompt, 'interview_prep', { json: true });
}

module.exports = {
    screenJD,
    analyzeJD,
    batchScreenJDs,
    generateRecruiterMessage,
    tailorResumeBullets,
    generateInterviewPrepBrief,
    keywordFallbackScreen,
    keywordFallbackAnalyze,
};
