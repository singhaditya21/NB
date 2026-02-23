// src/dashboard.js — Live tracking dashboard on port 4001
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { logger, logEmitter } = require('./logger');
const memory = require('./memory');
const { getContacts } = require('./outreach-extractor');

const DASHBOARD_PORT = 4001;

function startDashboard() {
    // HTTP Server — serves HTML + REST API
    const server = http.createServer((req, res) => {
        // CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');

        if (req.url === '/' || req.url === '/index.html') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8'));
            return;
        }

        if (req.url === '/api/stats') {
            const stats = memory.getHourlyStats();
            const applied = memory.getAppliedJobs();
            const today = new Date().toISOString().slice(0, 10);
            const todayApplied = applied.filter(j => j.appliedAt && j.appliedAt.startsWith(today));
            let contacts = [];
            try { contacts = getContacts(); } catch { }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                appliedToday: todayApplied.length,
                appliedTotal: applied.length,
                contactsFound: contacts.length,
                messagesSent: stats.messagesToday || 0,
                borderlinesQueue: (memory.getExternalQueue() || []).length,
                uptime: process.uptime(),
            }));
            return;
        }

        if (req.url === '/api/jobs') {
            const applied = memory.getAppliedJobs();
            const today = new Date().toISOString().slice(0, 10);
            const todayApplied = applied
                .filter(j => j.appliedAt && j.appliedAt.startsWith(today))
                .slice(-50)
                .reverse();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(todayApplied));
            return;
        }

        if (req.url === '/api/contacts') {
            let contacts = [];
            try { contacts = getContacts(); } catch { }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(contacts.slice(-30).reverse()));
            return;
        }

        res.writeHead(404);
        res.end('Not Found');
    });

    // WebSocket for real-time logs
    const wss = new WebSocket.Server({ server });

    wss.on('connection', (ws) => {
        ws.send(JSON.stringify({ type: 'info', msg: 'Connected to Naukri Agent Dashboard' }));
    });

    // Broadcast log events to all connected clients
    logEmitter.on('log', (entry) => {
        const msg = JSON.stringify({ type: 'log', ...entry });
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(msg);
            }
        });
    });

    server.listen(DASHBOARD_PORT, () => {
        logger.info(`Dashboard live at http://localhost:${DASHBOARD_PORT}`);
    });
}

module.exports = { startDashboard };
