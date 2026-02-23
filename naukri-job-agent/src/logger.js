// src/logger.js — Winston structured logging with daily rotation + real-time dashboard streaming
const winston = require('winston');
const Transport = require('winston-transport');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const EventEmitter = require('events');

const LOG_DIR = path.resolve(process.env.MEMORY_PATH || '.', '..', 'logs');

// EventEmitter to broadcast logs to dashboard WebSocket
const logEmitter = new EventEmitter();

// Custom transport that emits every log entry to the dashboard
class DashboardTransport extends Transport {
    log(info, callback) {
        setImmediate(() => {
            logEmitter.emit('log', {
                level: (info.level || 'info').replace(/\u001b\[[\d;]*m/g, ''),
                message: (info.message || '').replace(/\u001b\[[\d;]*m/g, ''),
                timestamp: info.timestamp || new Date().toISOString(),
            });
        });
        callback();
    }
}

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true })
    ),
    transports: [
        // Console — colorized, human readable
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.printf(({ timestamp, level, message, ...meta }) => {
                    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
                    return `${timestamp} ${level}: ${message}${metaStr}`;
                })
            ),
        }),
        // File — daily rotate, JSON format, 14-day retention
        new DailyRotateFile({
            dirname: LOG_DIR,
            filename: 'app-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            maxFiles: '14d',
            format: winston.format.combine(
                winston.format.json()
            ),
        }),
        // Dashboard — real-time WebSocket streaming
        new DashboardTransport(),
    ],
});

module.exports = { logger, logEmitter };
