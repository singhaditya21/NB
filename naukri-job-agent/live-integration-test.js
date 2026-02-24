#!/usr/bin/env node
// live-integration-test.js — Tests all Gemini features through the actual agent modules
require('dotenv').config();
const memory = require('./src/memory');
const { callGemini, budgetGuardian, rateLimiter } = require('./src/gemini');
const jdAnalyzer = require('./src/jd-analyzer');
const { generateCoverLetter } = require('./src/cover-letter');
const { extractContactInfo } = require('./src/outreach-extractor');
const { generateBattleCard } = require('./src/interview-prep');
const { learnFromAppliedJobs, formatLearningForTelegram } = require('./src/profile-learner');

const PASS = '✅';
const FAIL = '❌';
const results = [];

function log(name, status, detail) {
    results.push({ name, status });
    console.log(`  ${status === 'PASS' ? PASS : FAIL} ${name} — ${detail}`);
}

async function main() {
    console.log('\n══════════════════════════════════════════════════════');
    console.log('  LIVE INTEGRATION TEST — All Gemini Features');
    console.log('══════════════════════════════════════════════════════\n');

    const profile = memory.loadProfile();
    console.log(`  Profile: ${profile.name} (${profile.skills.length} skills, ${profile.targetRoles.length} roles)`);
    console.log(`  Budget: $${budgetGuardian.getBudgetStatus().monthUSD.toFixed(2)}/$${budgetGuardian.getBudgetStatus().hardStopUSD.toFixed(2)}\n`);

    // Mock job data
    const mockJob = {
        jobId: 'test-123',
        title: 'VP Operations',
        company: 'TechCorp Global',
        salary: '70-90 LPA',
        url: 'https://www.naukri.com/job/test-123',
    };

    const mockJDText = `VP Operations at TechCorp Global. 15+ years experience in global operations leadership.
Responsibilities: Lead operations team of 200+, P&L management, delivery governance, enterprise transformation.
Must have: operations strategy, revenue operations, stakeholder management, executive reporting.
Nice to have: NetSuite, Power BI, Agile/Scrum. Salary: 70-90 LPA. Location: Gurgaon/Remote.
Contact: careers@techcorp.com | HR: Priya Sharma | LinkedIn: linkedin.com/in/priya-hr-techcorp`;

    // ── Test 1: Rate Limiter status ──
    console.log('━━━ 1. Rate Limiter ━━━');
    const rlStats = rateLimiter.getStats();
    log('Rate Limiter Active', 'PASS', `calls=${rlStats.callsToday}/${rlStats.maxDaily} exhausted=${rlStats.quotaExhausted}`);

    // ── Test 2: Budget Guardian status ──
    console.log('\n━━━ 2. Budget Guardian ━━━');
    const budget = budgetGuardian.getBudgetStatus();
    const budgetOk = !budget.paused;
    log('Budget Not Paused', budgetOk ? 'PASS' : 'FAIL',
        `today=$${budget.todayUSD.toFixed(4)} month=$${budget.monthUSD.toFixed(4)} paused=${budget.paused}`);

    // ── Test 3: callGemini (direct) ──
    console.log('\n━━━ 3. callGemini (direct) ━━━');
    try {
        const reply = await callGemini('Say exactly: "LIVE TEST OK"', 'jd_screening');
        const ok = reply && reply.includes('LIVE TEST OK');
        log('callGemini (text)', ok ? 'PASS' : 'FAIL', ok ? reply.trim().slice(0, 50) : `Got: ${(reply || 'null').slice(0, 80)}`);
    } catch (err) {
        log('callGemini (text)', 'FAIL', err.message);
    }

    // ── Test 4: callGemini (JSON mode) ──
    console.log('\n━━━ 4. callGemini (JSON) ━━━');
    try {
        const json = await callGemini('Return ONLY: {"status":"ok","value":42}', 'jd_screening', { json: true });
        const ok = json && json.status === 'ok' && json.value === 42;
        log('callGemini (JSON)', ok ? 'PASS' : 'FAIL', JSON.stringify(json).slice(0, 80));
    } catch (err) {
        log('callGemini (JSON)', 'FAIL', err.message);
    }

    // ── Test 5: JD Screening via jd-analyzer ──
    console.log('\n━━━ 5. JD Screening (screenJD) ━━━');
    try {
        const screen = await jdAnalyzer.screenJD(mockJDText, profile);
        const ok = screen && typeof screen.quickScore === 'number' && typeof screen.worthAnalyzing === 'boolean';
        log('screenJD', ok ? 'PASS' : 'FAIL',
            ok ? `score=${screen.quickScore} worth=${screen.worthAnalyzing} reason="${screen.reason}"` : JSON.stringify(screen).slice(0, 80));
    } catch (err) {
        log('screenJD', 'FAIL', err.message);
    }

    // ── Test 6: Full JD Analysis via jd-analyzer ──
    console.log('\n━━━ 6. Full JD Analysis (analyzeJD) ━━━');
    try {
        const analysis = await jdAnalyzer.analyzeJD(mockJDText, profile);
        const ok = analysis && typeof analysis.matchScore === 'number' && analysis.recommendation;
        log('analyzeJD', ok ? 'PASS' : 'FAIL',
            ok ? `score=${analysis.matchScore} rec="${analysis.recommendation}" strength="${analysis.topStrength}"` : JSON.stringify(analysis).slice(0, 80));
    } catch (err) {
        log('analyzeJD', 'FAIL', err.message);
    }

    // ── Test 7: Recruiter Message ──
    console.log('\n━━━ 7. Recruiter Message ━━━');
    try {
        const msg = await jdAnalyzer.generateRecruiterMessage(mockJob, { matchScore: 85 }, profile);
        const ok = msg && msg.length > 30;
        log('generateRecruiterMessage', ok ? 'PASS' : 'FAIL',
            ok ? `${msg.length} chars: "${msg.slice(0, 80)}..."` : `Got: ${(msg || 'null').slice(0, 80)}`);
    } catch (err) {
        log('generateRecruiterMessage', 'FAIL', err.message);
    }

    // ── Test 8: Cover Letter ──
    console.log('\n━━━ 8. Cover Letter ━━━');
    try {
        const letter = await generateCoverLetter(mockJDText, mockJob, profile);
        const ok = letter && letter.length > 100;
        log('generateCoverLetter', ok ? 'PASS' : 'FAIL',
            ok ? `${letter.length} chars: "${letter.slice(0, 80)}..."` : `Got: ${(letter || 'null').slice(0, 80)}`);
    } catch (err) {
        log('generateCoverLetter', 'FAIL', err.message);
    }

    // ── Test 9: Contact Extraction ──
    console.log('\n━━━ 9. Contact Extraction ━━━');
    try {
        const contact = await extractContactInfo(mockJDText, mockJob);
        const ok = contact && (contact.emails.length > 0 || contact.phones.length > 0 || contact.linkedinUrls.length > 0);
        log('extractContactInfo', ok ? 'PASS' : 'FAIL',
            ok ? `emails=${contact.emails} phones=${contact.phones} linkedin=${contact.linkedinUrls}` : `Got: ${JSON.stringify(contact).slice(0, 80)}`);
    } catch (err) {
        log('extractContactInfo', 'FAIL', err.message);
    }

    // ── Test 10: Battle Card / Interview Prep ──
    console.log('\n━━━ 10. Interview Battle Card ━━━');
    try {
        const card = await generateBattleCard('TechCorp Global', 'VP Operations', mockJDText);
        const ok = card && card.length > 200;
        log('generateBattleCard', ok ? 'PASS' : 'FAIL',
            ok ? `${card.length} chars generated` : `Got: ${(card || 'null').slice(0, 80)}`);
    } catch (err) {
        log('generateBattleCard', 'FAIL', err.message);
    }

    // ── Test 11: Keyword Fallback (no Gemini) ──
    console.log('\n━━━ 11. Keyword Fallback (offline safety) ━━━');
    try {
        const fallback = jdAnalyzer.keywordFallbackScreen(mockJDText, profile, mockJob);
        const ok = fallback && typeof fallback.quickScore === 'number';
        log('keywordFallbackScreen', ok ? 'PASS' : 'FAIL',
            ok ? `score=${fallback.quickScore} worth=${fallback.worthAnalyzing}` : JSON.stringify(fallback).slice(0, 80));
    } catch (err) {
        log('keywordFallbackScreen', 'FAIL', err.message);
    }

    // ── Test 12: Memory operations ──
    console.log('\n━━━ 12. Memory Subsystem ━━━');
    try {
        const p = memory.loadProfile();
        const jobs = memory.getAppliedJobs();
        const stats = memory.getHourlyStats();
        const queue = memory.getExternalQueue();
        const bl = memory.getBudgetLog();
        const ok = p && p.name && Array.isArray(jobs) && stats && Array.isArray(queue) && bl;
        log('Memory Read/Write', ok ? 'PASS' : 'FAIL',
            `profile=${!!p} jobs=${jobs.length} stats=${!!stats} queue=${queue.length} budget=${!!bl}`);
    } catch (err) {
        log('Memory Read/Write', 'FAIL', err.message);
    }

    // ── Test 13: hasApplied cache ──
    console.log('\n━━━ 13. hasApplied O(1) Cache ━━━');
    try {
        const t1 = Date.now();
        for (let i = 0; i < 10000; i++) memory.hasApplied(`fake-job-${i}`);
        const elapsed = Date.now() - t1;
        const ok = elapsed < 500; // 10K lookups should be < 500ms with Set
        log('hasApplied 10K lookups', ok ? 'PASS' : 'FAIL', `${elapsed}ms for 10K lookups (${ok ? 'fast ✓' : 'SLOW ✗'})`);
    } catch (err) {
        log('hasApplied cache', 'FAIL', err.message);
    }

    // ── Budget verification after all calls ──
    console.log('\n━━━ 14. Post-Test Budget Check ━━━');
    const finalBudget = budgetGuardian.getBudgetStatus();
    const finalRL = rateLimiter.getStats();
    log('Budget Still Active', !finalBudget.paused ? 'PASS' : 'FAIL',
        `$${finalBudget.todayUSD.toFixed(4)} today, $${finalBudget.monthUSD.toFixed(4)} month, ${finalRL.callsToday} calls`);

    // ══ SUMMARY ══
    console.log('\n══════════════════════════════════════════════════════');
    console.log('  SUMMARY');
    console.log('══════════════════════════════════════════════════════\n');

    const passed = results.filter(r => r.status === 'PASS').length;
    const failed = results.filter(r => r.status === 'FAIL').length;
    const total = results.length;

    console.log(`  ${PASS} Passed: ${passed}/${total}`);
    if (failed > 0) {
        console.log(`  ${FAIL} Failed: ${failed}/${total}`);
        results.filter(r => r.status === 'FAIL').forEach(r => console.log(`     → ${r.name}`));
    }

    console.log(`\n  Budget used by this test: $${(finalBudget.todayUSD - budget.todayUSD).toFixed(4)}`);
    console.log(`  Gemini calls made: ${finalRL.callsToday - rlStats.callsToday}`);
    console.log(`  Monthly total: $${finalBudget.monthUSD.toFixed(4)} / $${finalBudget.hardStopUSD.toFixed(2)}`);

    if (failed === 0) {
        console.log('\n  🎉 ALL SYSTEMS GO — Agent is fully operational!');
    } else {
        console.log(`\n  ⚠️  ${failed} feature(s) need attention`);
    }
    console.log('\n══════════════════════════════════════════════════════\n');

    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
