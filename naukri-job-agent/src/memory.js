// src/memory.js — Atomic JSON state management
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { logger } = require('./logger');

const MEM = config.memoryPath;

// ─── Helpers ───
function filePath(name) {
    return path.join(MEM, name);
}

function readJSON(name) {
    try {
        const raw = fs.readFileSync(filePath(name), 'utf-8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function writeJSON(name, data) {
    const fp = filePath(name);
    const tmp = fp + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, fp);
}

function ensureFile(name, defaultData) {
    const fp = filePath(name);
    if (!fs.existsSync(fp)) {
        writeJSON(name, defaultData);
        logger.info(`Created ${name}`);
    }
}

// ─── Default Profile (Section 1 data) ───
const DEFAULT_PROFILE = {
    name: 'Aditya Singh',
    email: 'singhaditya21@gmail.com',
    phone: '+91 9911126150',
    location: 'Ghaziabad / Delhi NCR',
    targetRoles: [
        'Global Operations Leader', 'Head of Operations', 'VP Operations',
        'Director of Operations', 'Business Operations Leader',
        'Global Biz-Tech Operations Head', 'Chief of Staff (Operations)',
    ],
    targetLocations: ['Delhi NCR', 'Remote', 'Hybrid', 'Relocate', 'On-Site'],
    currentSalaryLPA: 45,
    expectedSalaryLPA: 60,
    noticePeriodDays: 90,
    totalExperience: '15+ years',
    education: 'MBA – Marketing & IT, IIT Roorkee (GPA: 9.7); BE – ECE, BIT Bangalore',
    certifications: ['PMP (PMI)', 'CSM', 'CSPO', 'PSM1', 'PSM2', 'PSPO1', 'PSPO2'],
    skills: [
        'Global operations strategy', 'cross-functional governance', 'delivery operations',
        'revenue operations', 'sales operations', 'support operations', 'resource management',
        'NetSuite O2C implementation', 'enterprise systems modernization', 'API integrations',
        'automation workflows', 'PostgreSQL', 'cloud provisioning', 'product-engineering collaboration',
        'Enterprise datamarts', 'MIS automation', 'Power BI', 'Sisense', 'Superset', 'Redash',
        'forecasting analytics', 'operational intelligence', 'time-series analysis',
        'Stakeholder management', 'change management', 'transformation programs',
        'executive reporting', 'delivery governance', 'control towers',
        'Agile / Scrum', 'sprint planning', 'release management', 'test strategy',
        'requirements documentation (SRS, HLD, LLD)',
        'Pre-sales support', 'BFSI demos', 'Gartner/Forrester RFI',
        'WhatsApp Banking', 'enterprise client engagement',
    ],
    resumeBullets: [
        'Architected enterprise-wide operating systems across Sales, Revenue, Delivery, Finance, Support, IT — impacting 1,500+ users across US and international markets.',
        'Designed Resource Management System (RMG) managing 800+ delivery resources, improving utilization visibility by 60% and reducing planning conflicts by 35%.',
        'Implemented NetSuite-based Order-to-Cash, billing, collections, revenue automation — improving revenue accuracy by 25%, cutting reconciliation cycles by 40%.',
        'Established global delivery governance frameworks, time-series datamarts, leadership dashboards — reducing execution blind spots by 70%.',
        'Built central intelligence infrastructure with 200+ dashboards and datamart views, reducing leadership decision latency from days to minutes.',
        'Designed and deployed 50+ enterprise workflows including SDR, MEDDICC, O2C, forecasting, helpdesk — cutting manual overhead by 40–55%.',
        'Unified HR, Legal, IT, Cloud Ops, Support into centralized Biz-Tech ecosystem handling 10,000+ tickets with improved SLA governance.',
        'Led modernization: PostgreSQL migrations, MS Teams rollout, cloud provisioning automation — improving platform stability and uptime by 30%.',
        'Front-ended 100+ strategic enterprise demos (OCP, Bot, BFSI automation, WhatsApp Banking), influencing multi-million-dollar deals.',
        'Served as operational glue between Engineering, Cloud, Product, Finance, Sales, Delivery — driving unified planning and execution alignment globally.',
        'Re-engineered Order-to-Cash at Foodpanda India — 200% increase in revenue collection across national marketplace operations.',
        'Built 20+ Sisense real-time dashboards at Foodpanda covering sales, merchant performance, supply health, CSAT — boosting decision accuracy by 25%.',
        'Orchestrated enterprise-level test strategies at CDAC with 100% on-time delivery across multiple product streams.',
        'Executed end-to-end Agile testing cycles at Infosys for Horizon Healthcare DB — 20% improvement in user satisfaction.',
    ],
    targetCompanies: 'MNCs, SaaS product companies, unicorn startups, Series B and above, global technology and enterprise software firms',
    blockedCompanies: [],
};

// ─── Init ───
function initializeAllFiles() {
    if (!fs.existsSync(MEM)) {
        fs.mkdirSync(MEM, { recursive: true });
        logger.info(`Created memory directory: ${MEM}`);
    }
    ensureFile('profile.json', DEFAULT_PROFILE);
    ensureFile('applied-jobs.json', []);
    ensureFile('recruiter-messages.json', []);
    ensureFile('hourly-stats.json', {
        appliedThisHour: 0, appliedToday: 0,
        messagesThisHour: 0, messagesToday: 0,
        repliesToday: 0, externalQueueCount: 0,
        borderlineCount: 0, avgMatchScore: 0,
        coverLettersToday: 0,
        topMatchThisHour: null, lastInsight: '',
        lastUpdated: new Date().toISOString(),
    });
    ensureFile('budget-log.json', {
        date: new Date().toISOString().slice(0, 10),
        callsByModel: { FREE: 0, CHEAP: 0, BALANCED: 0 },
        estimatedCostToday: 0.00,
        estimatedCostMonth: 0.00,
        totalCallsToday: 0,
        paused: false,
        pausedUntil: null,
        monthlyHistory: [],
    });
    ensureFile('external-queue.json', []);
    logger.info('All memory files initialized.');
}

// ─── Profile ───
function loadProfile() { return readJSON('profile.json') || DEFAULT_PROFILE; }
function saveProfile(data) { writeJSON('profile.json', data); }

// ─── Applied Jobs (with in-memory cache for O(1) lookups) ───
let _appliedCache = null; // Set of jobIds for fast lookup

function _ensureAppliedCache() {
    if (!_appliedCache) {
        const jobs = readJSON('applied-jobs.json') || [];
        _appliedCache = new Set(jobs.map(j => j.jobId));
    }
    return _appliedCache;
}

function getAppliedJobs() { return readJSON('applied-jobs.json') || []; }
function getAppliedToday() {
    const today = new Date().toISOString().slice(0, 10);
    return getAppliedJobs().filter(j => j.appliedAt && j.appliedAt.startsWith(today));
}
function hasApplied(jobId) {
    return _ensureAppliedCache().has(jobId); // Bug 28: O(1) instead of O(n)
}
function logApplication(jobData) {
    const jobs = getAppliedJobs();
    jobs.push({ ...jobData, appliedAt: new Date().toISOString() });
    // Bug 29: cap at 2000 entries, archive the rest
    if (jobs.length > 2000) {
        const archived = jobs.splice(0, jobs.length - 2000);
        try {
            const existing = readJSON('applied-jobs-archive.json') || [];
            existing.push(...archived);
            writeJSON('applied-jobs-archive.json', existing);
            logger.info(`Archived ${archived.length} old applied jobs`);
        } catch (e) {
            logger.warn(`Archive write failed: ${e.message}`);
        }
    }
    writeJSON('applied-jobs.json', jobs);
    // Update in-memory cache
    _ensureAppliedCache().add(jobData.jobId);
}
function updateJobStatus(jobId, status) {
    const jobs = getAppliedJobs();
    const job = jobs.find(j => j.jobId === jobId);
    if (job) { job.status = status; writeJSON('applied-jobs.json', jobs); }
}

// ─── Recruiter Messages ───
function getRecruiterMessages() { return readJSON('recruiter-messages.json') || []; }
function hasMessagedRecruiter(company) {
    return getRecruiterMessages().some(m => m.company.toLowerCase() === company.toLowerCase());
}
function logRecruiterMessage(data) {
    const msgs = getRecruiterMessages();
    msgs.push({ ...data, sentAt: new Date().toISOString(), replied: false, repliedAt: null });
    writeJSON('recruiter-messages.json', msgs);
}

// ─── External Queue ───
function getExternalQueue() { return readJSON('external-queue.json') || []; }
function addToExternalQueue(data) {
    const queue = getExternalQueue();
    if (!queue.some(q => q.jobId === data.jobId)) {
        queue.push({ ...data, addedAt: new Date().toISOString() });
        writeJSON('external-queue.json', queue);
    }
}
function removeFromExternalQueue(jobId) {
    const queue = getExternalQueue().filter(q => q.jobId !== jobId);
    writeJSON('external-queue.json', queue);
}

// ─── Hourly Stats ───
function getHourlyStats() {
    return readJSON('hourly-stats.json') || {
        appliedThisHour: 0, appliedToday: 0,
        messagesThisHour: 0, messagesToday: 0,
        repliesToday: 0, externalQueueCount: 0,
        borderlineCount: 0, avgMatchScore: 0,
        coverLettersToday: 0,
        topMatchThisHour: null, lastInsight: '',
        lastUpdated: new Date().toISOString(),
    };
}
function updateHourlyStats(updates) {
    const stats = getHourlyStats();
    for (const [key, val] of Object.entries(updates)) {
        if (typeof val === 'number' && typeof stats[key] === 'number') {
            stats[key] += val;
        } else {
            stats[key] = val;
        }
    }
    stats.lastUpdated = new Date().toISOString();
    writeJSON('hourly-stats.json', stats);
}
function resetHourlyStats() {
    const stats = getHourlyStats();
    stats.appliedThisHour = 0;
    stats.messagesThisHour = 0;
    stats.topMatchThisHour = null;
    stats.lastInsight = '';
    stats.lastUpdated = new Date().toISOString();
    writeJSON('hourly-stats.json', stats);
}
function resetDailyStats() {
    writeJSON('hourly-stats.json', {
        appliedThisHour: 0, appliedToday: 0,
        messagesThisHour: 0, messagesToday: 0,
        repliesToday: 0, externalQueueCount: 0,
        borderlineCount: 0, avgMatchScore: 0,
        coverLettersToday: 0,
        topMatchThisHour: null, lastInsight: '',
        lastUpdated: new Date().toISOString(),
    });
}

// ─── Budget Log ───
function getBudgetLog() {
    return readJSON('budget-log.json') || {
        date: new Date().toISOString().slice(0, 10),
        callsByModel: { FREE: 0, CHEAP: 0, BALANCED: 0 },
        estimatedCostToday: 0.00,
        estimatedCostMonth: 0.00,
        totalCallsToday: 0,
        paused: false,
        pausedUntil: null,
        monthlyHistory: [],
    };
}
function saveBudgetLog(data) { writeJSON('budget-log.json', data); }

// ─── Blocklist ───
function isCompanyBlocked(company) {
    const profile = loadProfile();
    return (profile.blockedCompanies || []).some(
        b => b.toLowerCase() === company.toLowerCase()
    );
}
function addToBlocklist(company) {
    const profile = loadProfile();
    if (!profile.blockedCompanies) profile.blockedCompanies = [];
    if (!profile.blockedCompanies.some(b => b.toLowerCase() === company.toLowerCase())) {
        profile.blockedCompanies.push(company);
        saveProfile(profile);
    }
}

module.exports = {
    initializeAllFiles,
    loadProfile, saveProfile,
    hasApplied, logApplication, updateJobStatus, getAppliedJobs, getAppliedToday,
    logRecruiterMessage, hasMessagedRecruiter, getRecruiterMessages,
    getExternalQueue, addToExternalQueue, removeFromExternalQueue,
    getHourlyStats, updateHourlyStats, resetHourlyStats, resetDailyStats,
    getBudgetLog, saveBudgetLog,
    isCompanyBlocked, addToBlocklist,
};
