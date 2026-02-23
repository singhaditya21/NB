// src/config.js — Environment configuration with validation
require('dotenv').config();

const REQUIRED_VARS = [
  'GEMINI_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_USER_ID',
  'NAUKRI_EMAIL',
  'NAUKRI_PASSWORD',
];

function validateConfig() {
  const missing = REQUIRED_VARS.filter(v => !process.env[v]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables:\n  ${missing.join('\n  ')}\n` +
      `Copy .env.example to .env and fill in all values.`
    );
  }
}

validateConfig();

module.exports = {
  geminiApiKey: process.env.GEMINI_API_KEY,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramUserId: process.env.TELEGRAM_USER_ID,
  naukriEmail: process.env.NAUKRI_EMAIL,
  naukriPassword: process.env.NAUKRI_PASSWORD,
  gcpProjectId: process.env.GCP_PROJECT_ID || '',
  port: parseInt(process.env.PORT || '8080', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  memoryPath: process.env.MEMORY_PATH || './memory',
  budget: {
    dailyTotalCallLimit: parseInt(process.env.DAILY_TOTAL_CALL_LIMIT || '5000', 10),
    dailyFreeCallLimit: parseInt(process.env.DAILY_FREE_CALL_LIMIT || '2000', 10),
    dailyCheapCallLimit: parseInt(process.env.DAILY_CHEAP_CALL_LIMIT || '2000', 10),
    dailyBalancedCallLimit: parseInt(process.env.DAILY_BALANCED_CALL_LIMIT || '1000', 10),
    monthlyHardStopUSD: parseFloat(process.env.MONTHLY_BUDGET_HARD_STOP_USD || '50.00'),
    monthlyPauseUSD: parseFloat(process.env.MONTHLY_BUDGET_PAUSE_USD || '45.00'),
    monthlyWarningUSD: parseFloat(process.env.MONTHLY_BUDGET_WARNING_USD || '35.00'),
  },
};
