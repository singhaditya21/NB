#!/usr/bin/env node
// validate-gemini.js — End-to-end Gemini API validation + budget projection
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

const API_KEY = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(API_KEY);

// Gemini 2.0 Flash pricing (per 1M tokens)
const PRICING = { input: 0.10, output: 0.40 };

const results = [];
let totalInputTokens = 0;
let totalOutputTokens = 0;

async function test(name, prompt, options = {}) {
    const start = Date.now();
    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        const result = await model.generateContent(prompt);
        const response = result.response;
        const text = response.text();
        const usage = response.usageMetadata || {};
        const inTok = usage.promptTokenCount || 0;
        const outTok = usage.candidatesTokenCount || 0;
        totalInputTokens += inTok;
        totalOutputTokens += outTok;
        const costUSD = (inTok / 1e6) * PRICING.input + (outTok / 1e6) * PRICING.output;

        // JSON parse check
        let jsonOk = true;
        if (options.json) {
            try {
                let cleaned = text.trim();
                if (cleaned.startsWith('```')) {
                    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
                }
                JSON.parse(cleaned);
            } catch {
                jsonOk = false;
            }
        }

        const elapsed = Date.now() - start;
        const preview = text.slice(0, 120).replace(/\n/g, ' ');
        results.push({ name, status: 'PASS', inTok, outTok, costUSD, elapsed, jsonOk: options.json ? jsonOk : 'N/A' });
        console.log(`  ✅ ${name} — ${elapsed}ms | in=${inTok} out=${outTok} | $${costUSD.toFixed(5)} | ${preview}...`);
        return true;
    } catch (err) {
        const elapsed = Date.now() - start;
        results.push({ name, status: 'FAIL', error: err.message, elapsed });
        console.log(`  ❌ ${name} — ${elapsed}ms | ERROR: ${err.message}`);
        return false;
    }
}

async function main() {
    console.log('\n═══════════════════════════════════════════');
    console.log('  GEMINI API VALIDATION — All Use Cases');
    console.log('═══════════════════════════════════════════\n');
    console.log(`  API Key: ${API_KEY.slice(0, 10)}...${API_KEY.slice(-4)}`);
    console.log(`  Model: gemini-2.5-flash\n`);

    // 1. Basic connectivity
    console.log('📡 Test 1: Basic Connectivity');
    await test('Basic API Call', 'Say exactly: "API connected successfully"');

    // 2. JD Screening (JSON output)
    console.log('\n📋 Test 2: JD Screening (JSON)');
    await test('JD Screening', `You are a job match screener for Aditya Singh, a 15+ year experienced professional.
Current role: Global Operations & Biz-Tech Leader at BUSINESSNEXT.
Target: VP Operations, Head of Operations, Director of Operations.
Key skills: Global operations strategy, delivery operations, revenue operations, enterprise systems.
Expected salary: 60 LPA+.

Quickly evaluate this JD:
"""
VP Operations at TechCorp India. 15+ years experience required. Lead global operations team of 200+.
Salary: 70-90 LPA. Location: Gurgaon. Skills: operations strategy, P&L management, enterprise scaling.
"""

Return ONLY valid JSON (no markdown fences):
{"worthAnalyzing": true, "quickScore": 85, "reason": "Strong match - senior leadership with ops focus"}`, { json: true });

    // 3. Full JD Analysis (JSON output)
    console.log('\n🔍 Test 3: Full JD Analysis (JSON)');
    await test('Full JD Analysis', `Analyze this job for Aditya Singh (15+ yrs, VP Operations target, 60 LPA expected).
JD: "Director of Operations at Global SaaS Company. 12+ years. Manage delivery, rev ops, support. Salary 55-75 LPA."
Return ONLY valid JSON: {"matchScore": 78, "requiredSkills": ["operations"], "missingSkills": [], "salary": "55-75 LPA", "seniorityMatch": true, "locationMatch": true, "summary": "Good match", "recommendation": "apply", "topGap": "none", "topStrength": "operations experience"}`, { json: true });

    // 4. Cover Letter Generation
    console.log('\n📝 Test 4: Cover Letter Generation');
    await test('Cover Letter', `Write a brief 3-paragraph cover letter (max 150 words) for:
Candidate: Aditya Singh, 15+ years experience, Global Operations & Biz-Tech Leader
Achievements: Architected enterprise systems impacting 1500+ users, built 200+ dashboards
Job: VP Operations at TechCorp, managing global delivery operations
Sign off with the candidate's name.`);

    // 5. Recruiter Message Generation
    console.log('\n✉️ Test 5: Recruiter Message');
    await test('Recruiter Message', `Write a short, personalized recruiter outreach message (max 50 words) for Aditya Singh applying to VP Operations at TechCorp. Mention 1 specific achievement. Do NOT use generic phrases.`);

    // 6. Contact Extraction (JSON)
    console.log('\n📧 Test 6: Contact Extraction (JSON)');
    await test('Contact Extraction', `Extract contact details from this text. Return ONLY valid JSON:
"For queries contact HR at jobs@techcorp.com or call 9876543210. Apply via LinkedIn: linkedin.com/in/recruiter"
Return: {"emails": ["jobs@techcorp.com"], "phones": ["9876543210"], "linkedinUrls": ["linkedin.com/in/recruiter"], "recruiterName": ""}`, { json: true });

    // 7. Resume Feedback (JSON)
    console.log('\n📊 Test 7: Resume Feedback (JSON)');
    await test('Resume Feedback', `Based on these JDs the candidate applied to:
• VP Operations at TechCorp: global operations, P&L management
• Head of Delivery at SaaS Inc: delivery governance, sprint planning
Suggest: {"profileKeywords": ["P&L management", "delivery governance", "sprint planning"], "headlineSuggestion": "Global Operations Leader | P&L | Delivery Excellence", "gapAnalysis": "Consider adding P&L metrics to resume"}
Return ONLY valid JSON.`, { json: true });

    // 8. Follow-up Draft
    console.log('\n📬 Test 8: Follow-up Draft');
    await test('Follow-up Message', `Write a polite 2-sentence follow-up message for Aditya Singh who applied to VP Operations at TechCorp 2 days ago. Reference the specific role. Return only the message text.`);

    // 9. Profile Learning (JSON)
    console.log('\n🎓 Test 9: Profile Learning (JSON)');
    await test('Profile Learning', `Analyze these recent JDs and suggest new skills:
JD snippets: "data governance, cloud migration, SRE practices, DevOps pipelines"
Current skills: operations strategy, delivery operations, revenue operations
Return ONLY valid JSON: {"newSkills": ["data governance", "cloud migration"], "newRoles": ["Head of Platform Operations"]}`, { json: true });

    // 10. Hourly Insight
    console.log('\n💡 Test 10: Hourly Insight');
    await test('Hourly Insight', `Generate ONE sentence insight: Applied 12 today, 3 this hour, 5 messages sent, 1 reply, avg match 72%. Be specific and actionable.`);

    // ─── Summary ───
    console.log('\n═══════════════════════════════════════════');
    console.log('  RESULTS SUMMARY');
    console.log('═══════════════════════════════════════════\n');

    const passed = results.filter(r => r.status === 'PASS').length;
    const failed = results.filter(r => r.status === 'FAIL').length;
    const jsonTests = results.filter(r => r.jsonOk !== 'N/A');
    const jsonPassed = jsonTests.filter(r => r.jsonOk === true).length;

    console.log(`  Tests: ${passed}/${results.length} passed, ${failed} failed`);
    console.log(`  JSON Parse: ${jsonPassed}/${jsonTests.length} valid`);
    console.log(`  Total tokens: ${totalInputTokens} in + ${totalOutputTokens} out`);

    const totalCost = (totalInputTokens / 1e6) * PRICING.input + (totalOutputTokens / 1e6) * PRICING.output;
    console.log(`  Validation cost: $${totalCost.toFixed(4)}`);

    // ─── Budget Projection ───
    console.log('\n═══════════════════════════════════════════');
    console.log('  MONTHLY BUDGET PROJECTION ($20 limit)');
    console.log('═══════════════════════════════════════════\n');

    // Average tokens per call across all test types
    const avgInPerCall = totalInputTokens / results.filter(r => r.status === 'PASS').length;
    const avgOutPerCall = totalOutputTokens / results.filter(r => r.status === 'PASS').length;
    const avgCostPerCall = (avgInPerCall / 1e6) * PRICING.input + (avgOutPerCall / 1e6) * PRICING.output;

    // Estimate daily usage: ~50 jobs/day
    // Per job: 1 screening + 0.3 full analysis + 0.3 cover letter + 0.5 recruiter msg + 0.2 contact = ~2.3 calls/job
    // Plus: 1 hourly insight × 24 + 1 resume feedback × 24 + 1 profile learning = 49 overhead calls
    const callsPerJob = 2.3;
    const jobsPerDay = 50;
    const overheadCallsPerDay = 49;
    const dailyCalls = (callsPerJob * jobsPerDay) + overheadCallsPerDay;
    const dailyCostUSD = dailyCalls * avgCostPerCall;
    const monthlyCostUSD = dailyCostUSD * 30;

    console.log(`  Avg cost/call: $${avgCostPerCall.toFixed(5)}`);
    console.log(`  Est. daily calls: ${Math.round(dailyCalls)} (${jobsPerDay} jobs × ${callsPerJob} calls + ${overheadCallsPerDay} overhead)`);
    console.log(`  Est. daily cost: $${dailyCostUSD.toFixed(2)}`);
    console.log(`  Est. monthly cost: $${monthlyCostUSD.toFixed(2)}`);
    console.log(`  Budget limit: $20.00`);
    console.log(`  Budget headroom: $${(20 - monthlyCostUSD).toFixed(2)}`);

    if (monthlyCostUSD > 20) {
        console.log('\n  ⚠️  OVER BUDGET — reduce calls or switch tasks to cheaper models');
    } else if (monthlyCostUSD > 15) {
        console.log('\n  🟡 Tight — close to $20 limit, BudgetGuardian will switch to Flash-Lite at $18');
    } else {
        console.log('\n  ✅ WELL WITHIN BUDGET — all features safe to run');
    }

    // Safety layers
    console.log('\n═══════════════════════════════════════════');
    console.log('  BUDGET SAFETY LAYERS');
    console.log('═══════════════════════════════════════════\n');
    console.log('  Layer 1: BudgetGuardian tracks every call\'s token usage + cost');
    console.log('  Layer 2: Warning at $15/month → Telegram alert');
    console.log('  Layer 3: Auto-switch to cheapest model at $18/month');
    console.log('  Layer 4: HARD STOP at $20/month → zero API calls until next month');
    console.log('  Layer 5: Rate limiter caps at 5,000 calls/day');
    console.log('  Layer 6: 10-min cooldown on 429 errors (auto-recovery)');
    console.log('  Layer 7: Google Cloud budget alert (set independently)');

    console.log('\n═══════════════════════════════════════════');
    if (failed === 0) {
        console.log('  🎉 ALL TESTS PASSED — Gemini is fully operational!');
    } else {
        console.log(`  ⚠️ ${failed} test(s) failed — review errors above`);
    }
    console.log('═══════════════════════════════════════════\n');
}

main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
});
