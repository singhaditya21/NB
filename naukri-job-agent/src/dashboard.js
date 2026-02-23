// src/dashboard.js — Live tracking dashboard on port 4001
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const WebSocket = require('ws');
const { logger, logEmitter } = require('./logger');
const memory = require('./memory');

const DASHBOARD_PORT = 4001;
const CONTACTS_PATH = path.resolve('memory/contacts.json');
const BUDGET_PATH = path.resolve('memory/budget-log.json');
const LEARNING_PATH = path.resolve('memory/learning-log.json');

function readJSON(filePath, fallback = []) {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch { return fallback; }
}

function filterByDate(jobs, range) {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    if (range === 'today') {
        return jobs.filter(j => j.appliedAt && j.appliedAt.startsWith(today));
    }
    if (range === 'week') {
        const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10);
        return jobs.filter(j => j.appliedAt && j.appliedAt >= weekAgo);
    }
    return jobs; // 'all'
}

function startDashboard() {
    const server = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        const parsed = url.parse(req.url, true);
        const pathname = parsed.pathname;
        const range = parsed.query.range || 'today';

        if (pathname === '/' || pathname === '/index.html') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8'));
            return;
        }

        if (pathname === '/api/stats') {
            const allApplied = memory.getAppliedJobs();
            const filtered = filterByDate(allApplied, range);
            const contacts = readJSON(CONTACTS_PATH);
            const budget = readJSON(BUDGET_PATH, {});
            const stats = memory.getHourlyStats();
            const profile = memory.loadProfile();

            // Score distribution
            const scoreDist = { '40-49': 0, '50-59': 0, '60-69': 0, '70-79': 0, '80+': 0 };
            filtered.forEach(j => {
                const s = j.matchScore || 0;
                if (s >= 80) scoreDist['80+']++;
                else if (s >= 70) scoreDist['70-79']++;
                else if (s >= 60) scoreDist['60-69']++;
                else if (s >= 50) scoreDist['50-59']++;
                else if (s >= 40) scoreDist['40-49']++;
            });

            // Application volume by hour (for today) or by day
            const volumeMap = {};
            filtered.forEach(j => {
                if (!j.appliedAt) return;
                let key;
                if (range === 'today') {
                    const d = new Date(j.appliedAt);
                    key = d.getHours().toString().padStart(2, '0') + ':00';
                } else {
                    key = j.appliedAt.slice(0, 10);
                }
                volumeMap[key] = (volumeMap[key] || 0) + 1;
            });

            // Pipeline counts
            const pipeline = { applied: 0, messaged: 0, interview: 0, offer: 0 };
            filtered.forEach(j => {
                pipeline.applied++;
                if (j.recruiterMessageSent) pipeline.messaged++;
                if (j.status === 'interview') pipeline.interview++;
                if (j.status === 'offer') pipeline.offer++;
            });

            // Avg score
            const scores = filtered.map(j => j.matchScore || 0).filter(s => s > 0);
            const avgScore = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;

            // Top companies
            const companyCount = {};
            filtered.forEach(j => {
                if (j.company) companyCount[j.company] = (companyCount[j.company] || 0) + 1;
            });
            const topCompanies = Object.entries(companyCount)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([name, count]) => ({ name, count }));

            // Role breakdown
            const roleCount = {};
            filtered.forEach(j => {
                const role = j.title ? j.title.split(' ').slice(0, 3).join(' ') : 'Unknown';
                roleCount[role] = (roleCount[role] || 0) + 1;
            });
            const topRoles = Object.entries(roleCount)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([name, count]) => ({ name, count }));

            // Gemini budget — try rate limiter counter first, then budget-log
            let geminiUsed = 0;
            try {
                const gemMod = require('./gemini');
                if (gemMod.rateLimiter && gemMod.rateLimiter.todayCalls !== undefined) {
                    geminiUsed = gemMod.rateLimiter.todayCalls;
                }
            } catch { /* ignore */ }
            if (geminiUsed === 0) {
                const todayLog = budget[new Date().toISOString().slice(0, 10)] || {};
                geminiUsed = (todayLog.callsByModel?.FREE || 0) + (todayLog.callsByModel?.CHEAP || 0) + (todayLog.callsByModel?.BALANCED || 0);
            }

            // Learning
            const learning = readJSON(LEARNING_PATH, {});

            // Max score in range
            const maxScore = scores.length > 0 ? Math.max(...scores) : 0;

            // Last applied timing
            const lastJob = filtered.length > 0 ? filtered[filtered.length - 1] : null;
            const lastApplyAgo = lastJob?.appliedAt
                ? Math.round((Date.now() - new Date(lastJob.appliedAt).getTime()) / 60000)
                : null;

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                appliedInRange: filtered.length,
                appliedTotal: allApplied.length,
                contactsFound: contacts.length,
                messagesSent: stats.messagesToday || 0,
                coverLetters: filtered.filter(j => j.matchScore >= 55).length,
                avgScore,
                maxScore,
                scoreDist,
                volumeMap,
                pipeline,
                topCompanies,
                topRoles,
                geminiUsed,
                geminiLimit: 1400,
                uptime: process.uptime(),
                profileSkills: (profile.skills || []).length,
                targetRoles: profile.targetRoles || [],
                skillsLearned: learning.skillsAdded || [],
                range,
                // Live-updating metrics
                appliedThisHour: stats.appliedThisHour || 0,
                borderlineCount: stats.borderlineCount || 0,
                lastInsight: stats.lastInsight || '',
                lastUpdated: stats.lastUpdated || null,
                lastApplyAgo,
            }));
            return;
        }

        if (pathname === '/api/jobs') {
            const allApplied = memory.getAppliedJobs();
            const filtered = filterByDate(allApplied, range).reverse();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(filtered.slice(0, 100)));
            return;
        }

        if (pathname === '/api/contacts') {
            const contacts = readJSON(CONTACTS_PATH);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(contacts.slice(-50).reverse()));
            return;
        }

        if (pathname === '/api/control') {
            // POST-style control via query params
            const action = parsed.query.action;
            if (action === 'pause' || action === 'resume' || action === 'stop') {
                try {
                    const orchestrator = require('./orchestrator');
                    if (action === 'pause') orchestrator.setPaused(true);
                    if (action === 'resume') orchestrator.setPaused(false);
                    if (action === 'stop') orchestrator.setEmergencyStop();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, action }));
                } catch (e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: e.message }));
                }
                return;
            }
        }

        res.writeHead(404);
        res.end('Not Found');
    });

    const wss = new WebSocket.Server({ server });
    wss.on('connection', (ws) => {
        ws.send(JSON.stringify({ type: 'info', msg: 'Connected to Naukri Agent Dashboard' }));
    });

    logEmitter.on('log', (entry) => {
        const msg = JSON.stringify({ type: 'log', ...entry });
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) client.send(msg);
        });
    });

    server.listen(DASHBOARD_PORT, () => {
        logger.info(`Dashboard live at http://localhost:${DASHBOARD_PORT}`);
    });
}

module.exports = { startDashboard };
