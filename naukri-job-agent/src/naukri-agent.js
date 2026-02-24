// src/naukri-agent.js — Browser automation for Naukri.com
const { chromium } = require('playwright');
const config = require('./config');
const { logger } = require('./logger');
const { sendAlert } = require('./telegram');

// ─── All selectors in one place (from live DOM inspection) ───
const SELECTORS = {
    login: {
        emailInput: '#usernameField',
        passwordInput: '#passwordField',
        submitButton: 'button[type="submit"].blue-btn',
        googleLoginButton: 'a.socialbtn.google', // AVOID — never click
        captchaContainer: '.g-recaptcha, iframe[src*="recaptcha"]',
        // Post-login indicators
        profileAvatar: '.nI-gNb-header__avatar, .nI-gNb-header-avtar, img.avtar-img',
        dashboardIndicator: '.nI-gNb-drawer, .nI-gNb-header, [class*="header-avtar"]',
    },
    search: {
        jobCardWrapper: '.srp-jobtuple-wrapper, .cust-job-tuple',
        jobTitle: 'a.title',
        companyName: 'a.comp-name, .comp-name',
        salary: '.sal-wrap span, .sal, [class*="sal"]',
        location: '.loc-wrap span, .locWdth, .loc',
        experience: '.exp-wrap span, .expwdth',
        postedDate: '.job-post-day',
        tags: 'ul.tags-gt li.tag-li',
        paginationNext: 'a.fright, a[class*="next"], .styles_btn-secondary__2AsIP:last-child',
        paginationContainer: '[class*="pagination"]',
    },
    jobDetail: {
        jdContainer: 'section[class*="job-desc-container"], .job-desc, .jd-desc',
        jdContent: 'div[class*="dang-inner-html"], .job-desc .dang-inner-html',
        title: 'h1[class*="jd-header-title"], h1',
        companyName: '.jd-header-comp-name a, [class*="comp-name"] a',
        salary: '[class*="salary"], .sal',
        experience: '[class*="exp-salary"], .exp',
        location: '[class*="loc"], .location',
        applyButton: '#apply-button, button[id*="apply-button"]',
        easyApplyButton: '#apply-button',
        recruiterCard: '[class*="recruiter"], .rec-card, .rec-details',
        recruiterName: '[class*="recruiter"] .name, .rec-name',
        messageButton: '[class*="chat-btn"], [class*="message-btn"], button:has-text("Chat"), button:has-text("Message"), [class*="msg-recruiter"], a[class*="chat"]',
    },
    applyForm: {
        noticePeriod: 'select[name*="notice"], input[name*="notice"], [class*="notice"] select, [class*="notice"] input',
        currentCTC: 'input[name*="ctc"], input[name*="salary"], input[placeholder*="Current"], input[placeholder*="ctc" i]',
        expectedCTC: 'input[name*="expected"], input[placeholder*="Expected"], input[placeholder*="expected" i]',
        experience: 'input[name*="experience"], input[placeholder*="experience" i]',
        submitApplication: 'button[type="submit"], button[class*="submit"], .apply-form button.btn',
        successMessage: '.apply-success, [class*="success"], [class*="applied"]',
    },
};

// ─── Utility ───
function randomDelay(min, max) {
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise(r => setTimeout(r, ms));
}

async function humanType(page, selector, text) {
    await page.click(selector);
    await randomDelay(200, 400);
    for (const char of text) {
        await page.keyboard.type(char, { delay: 0 });
        await randomDelay(80, 200);
    }
}

// ─── Browser (persistent session — reused across cycles) ───
let _browser = null;
let _context = null;
let _page = null;
let _isLoggedIn = false;

async function createBrowser() {
    // Reuse existing browser+page if still alive
    if (_browser && _page) {
        try {
            await _page.evaluate(() => true); // check page is alive
            logger.info('Reusing existing browser session');
            return { browser: _browser, page: _page };
        } catch {
            logger.info('Previous browser session dead — creating new one');
            _browser = null; _context = null; _page = null; _isLoggedIn = false;
        }
    }

    const headless = config.nodeEnv === 'production';
    _browser = await chromium.launch({
        headless,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-blink-features=AutomationControlled',
        ],
    });

    _context = await _browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 768 },
        locale: 'en-IN',
        timezoneId: 'Asia/Kolkata',
    });

    _page = await _context.newPage();

    // Stealth: remove webdriver detection
    await _page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    _isLoggedIn = false;
    logger.info(`Browser created (headless=${headless})`);
    return { browser: _browser, page: _page };
}

function isLoggedIn() { return _isLoggedIn; }
function setLoggedIn(val) { _isLoggedIn = val; }

async function closeBrowser() {
    if (_browser) {
        try { await _browser.close(); } catch { }
        _browser = null; _context = null; _page = null; _isLoggedIn = false;
        logger.info('Browser closed');
    }
}

// ─── CAPTCHA Detection ───
async function detectCaptcha(page) {
    try {
        const captcha = await page.$(SELECTORS.login.captchaContainer);
        // Check if captcha is actually visible
        if (captcha) {
            const isVisible = await captcha.isVisible().catch(() => false);
            if (isVisible) {
                logger.warn('CAPTCHA detected!');
                await sendAlert('CAPTCHA Detected', 'Agent paused. Solve CAPTCHA at naukri.com then send /resume');
                return true;
            }
        }
        // Also check for iframe-based CAPTCHA challenge
        const iframes = await page.$$('iframe[src*="recaptcha"], iframe[src*="captcha"]');
        for (const iframe of iframes) {
            const isVisible = await iframe.isVisible().catch(() => false);
            if (isVisible) {
                logger.warn('CAPTCHA iframe detected!');
                await sendAlert('CAPTCHA Detected', 'Agent paused. Solve CAPTCHA at naukri.com then send /resume');
                return true;
            }
        }
        return false;
    } catch {
        return false;
    }
}

// ─── Login ───
async function login(page) {
    try {
        logger.info('Navigating to Naukri login...');
        await page.goto('https://www.naukri.com/nlogin/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await randomDelay(2000, 3000);

        // Check for CAPTCHA
        if (await detectCaptcha(page)) {
            return { success: false, reason: 'captcha' };
        }

        // Wait for email field
        await page.waitForSelector(SELECTORS.login.emailInput, { timeout: 30000 });

        // Type email
        await humanType(page, SELECTORS.login.emailInput, config.naukriEmail);
        await randomDelay(500, 800);

        // Type password
        await humanType(page, SELECTORS.login.passwordInput, config.naukriPassword);
        await randomDelay(600, 1200);

        // Click submit
        await page.click(SELECTORS.login.submitButton);
        logger.info('Login form submitted, waiting for auth...');

        // Wait for authenticated state
        try {
            await page.waitForSelector(
                `${SELECTORS.login.profileAvatar}, ${SELECTORS.login.dashboardIndicator}`,
                { timeout: 12000 }
            );
            logger.info('Login successful — authenticated state detected');
            return { success: true };
        } catch {
            // Check if CAPTCHA appeared
            if (await detectCaptcha(page)) {
                return { success: false, reason: 'captcha' };
            }

            // Check URL for signs of success
            const url = page.url();
            if (url.includes('dashboard') || url.includes('mnjuser') || !url.includes('login')) {
                logger.info('Login likely successful — redirected away from login page');
                return { success: true };
            }

            logger.error('Login failed — still on login page');
            return { success: false, reason: 'login_failed' };
        }
    } catch (err) {
        logger.error(`Login error: ${err.message}`);
        return { success: false, reason: err.message };
    }
}

// ─── Search Jobs ───
async function searchJobs(page, searchConfig) {
    const {
        keywords = 'operations manager',
        experienceMin = 10,
        experienceMax = 20,
        location = 'Delhi NCR',
        postedWithin = '7',
        maxPages = 3,
    } = searchConfig;

    const encodedKeywords = encodeURIComponent(keywords.replace(/\s+/g, '-'));
    const encodedLocation = encodeURIComponent(location.replace(/\s+/g, '-'));
    const baseUrl = `https://www.naukri.com/${encodedKeywords}-jobs-in-${encodedLocation}?k=${encodeURIComponent(keywords)}&l=${encodeURIComponent(location)}&experience=${experienceMin}&jobAge=${postedWithin}`;

    const allJobs = [];

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
        const url = pageNum === 1 ? baseUrl : `${baseUrl}&pageNo=${pageNum}`;
        logger.info(`Searching: page ${pageNum} — ${url}`);

        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            // Wait for job cards to render (JS-loaded)
            try {
                await page.waitForSelector('.cust-job-tuple, .srp-jobtuple-wrapper', { timeout: 10000 });
            } catch { }
            await randomDelay(1500, 2500);

            if (await detectCaptcha(page)) {
                logger.warn('CAPTCHA on search page — stopping search');
                break;
            }

            // Extract job cards
            const cards = await page.$$('.srp-jobtuple-wrapper, .cust-job-tuple');
            logger.info(`Found ${cards.length} job cards on page ${pageNum}`);

            for (const card of cards) {
                try {
                    const jobData = await card.evaluate((el) => {
                        const titleEl = el.querySelector('a.title');
                        const companyEl = el.querySelector('a.comp-name, .comp-name');
                        const salaryEl = el.querySelector('.sal-wrap span, .sal, [class*="sal"]');
                        const locEl = el.querySelector('.loc-wrap span, .locWdth, .loc');
                        const snippetEl = el.querySelector('.job-desc, .row3, .ellipsis');
                        const href = titleEl ? titleEl.getAttribute('href') : '';
                        const jobId = el.getAttribute('data-job-id') || (href && href.match(/-(\d+)(?:\?|$)/)?.[1]) || '';

                        return {
                            jobId: jobId,
                            title: titleEl ? titleEl.textContent.trim() : '',
                            company: companyEl ? companyEl.textContent.trim() : '',
                            salary: salaryEl ? salaryEl.textContent.trim() : '',
                            location: locEl ? locEl.textContent.trim() : '',
                            jdSnippet: snippetEl ? snippetEl.textContent.trim() : '',
                            url: href ? (href.startsWith('http') ? href : `https://www.naukri.com${href}`) : '',
                            isEasyApply: true,
                        };
                    });

                    if (jobData.jobId && jobData.title) {
                        allJobs.push(jobData);
                    }
                } catch (err) {
                    logger.debug(`Card extraction error: ${err.message}`);
                }
            }

            await randomDelay(3000, 5500);
        } catch (err) {
            logger.error(`Search page ${pageNum} error: ${err.message}`);
            break;
        }
    }

    logger.info(`Total jobs extracted: ${allJobs.length}`);
    return allJobs;
}

// ─── Get JD Text ───
async function getJDText(page, jobUrl) {
    try {
        await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await randomDelay(2000, 3500);

        if (await detectCaptcha(page)) return null;

        const data = await page.evaluate((selectors) => {
            const jdEl = document.querySelector(selectors.jdContent) || document.querySelector(selectors.jdContainer);
            const titleEl = document.querySelector(selectors.title);
            const companyEl = document.querySelector(selectors.companyName);
            const salaryEl = document.querySelector(selectors.salary);
            const recruiterEl = document.querySelector(selectors.recruiterName);

            return {
                jdText: jdEl ? jdEl.textContent.trim() : '',
                jobTitle: titleEl ? titleEl.textContent.trim() : '',
                companyName: companyEl ? companyEl.textContent.trim() : '',
                salaryRange: salaryEl ? salaryEl.textContent.trim() : '',
                recruiterName: recruiterEl ? recruiterEl.textContent.trim() : '',
            };
        }, SELECTORS.jobDetail);

        if (!data.jdText) {
            // Fallback - try page.textContent on body area
            const bodyText = await page.textContent('body').catch(() => '');
            data.jdText = bodyText.slice(0, 5000);
        }

        logger.info(`JD extracted: ${data.jobTitle} at ${data.companyName} (${data.jdText.length} chars)`);
        return data;
    } catch (err) {
        logger.error(`getJDText error: ${err.message}`);
        return null;
    }
}

// ─── Easy Apply (with popup handling + chatbot + reload-confirm) ───
async function applyEasyApply(page, jobUrl, profile) {
    try {
        const pagesBefore = _context ? _context.pages().length : 1;

        await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await randomDelay(2000, 3000);

        if (await detectCaptcha(page)) {
            return { success: false, reason: 'captcha' };
        }

        // Check logged-out state
        const loginBtn = await page.$('#login-apply-button, #reg-apply-button');
        if (loginBtn && await loginBtn.isVisible().catch(() => false)) {
            logger.warn('Not logged in on job page');
            _isLoggedIn = false;
            return { success: false, reason: 'not_logged_in' };
        }

        // Check already applied
        const bodyText = await page.textContent('body').catch(() => '');
        if (/already applied/i.test(bodyText)) {
            logger.info('Already applied to this job');
            return { success: false, reason: 'already_applied' };
        }

        // Find apply button — ONLY direct apply
        const applyBtn = await page.$('#apply-button');
        if (!applyBtn || !(await applyBtn.isVisible().catch(() => false))) {
            return { success: false, reason: 'no_apply_button' };
        }

        const btnText = (await applyBtn.textContent().catch(() => '')).toLowerCase();
        if (btnText.includes('login') || btnText.includes('register') || btnText.includes('company site')) {
            return { success: false, reason: 'external_apply' };
        }

        logger.info(`Clicking apply: "${btnText.trim()}"`);
        await randomDelay(500, 1000);
        await applyBtn.click();
        await randomDelay(5000, 7000);

        // Handle popups / new tabs
        if (_context) {
            const pagesAfter = _context.pages();
            if (pagesAfter.length > pagesBefore) {
                logger.info(`Popup/new tab opened — closing and skipping`);
                for (const p of pagesAfter) {
                    if (p !== _page) { try { await p.close(); } catch { } }
                }
                return { success: false, reason: 'popup_opened' };
            }
        }

        // Save debug screenshot after Apply click
        try {
            const ts = Date.now();
            await page.screenshot({ path: `memory/debug-apply-${ts}.png`, fullPage: false });
            logger.info(`Debug screenshot saved: debug-apply-${ts}.png`);
        } catch { }

        // ─── Handle Naukri chatbot apply flow ───
        // The chatbot asks recruiter questions like CTC, notice period, etc.
        // We read the question, match to a profile answer, type it, and click Save
        try {
            const chatContainer = await page.$('[class*="chatbot"]');
            if (chatContainer && await chatContainer.isVisible().catch(() => false)) {
                logger.info('Chatbot widget detected — answering questions');

                // Answer map: keyword in question → answer from profile
                const answerMap = [
                    { keywords: ['ctc', 'current salary', 'current ctc', 'lacs per annum', 'current package', 'annual salary'], answer: String(profile.currentSalaryLPA || 45) },
                    { keywords: ['expected', 'expected ctc', 'expected salary', 'expected package'], answer: String(profile.expectedSalaryLPA || 55) },
                    { keywords: ['notice period', 'notice'], answer: String(profile.noticePeriodDays || 30) },
                    { keywords: ['experience', 'years of experience', 'total experience', 'relevant experience'], answer: String(profile.experienceYears || 14) },
                    { keywords: ['location', 'relocate', 'relocation', 'willing to relocate'], answer: 'Yes' },
                    { keywords: ['available', 'join', 'joining date', 'start date', 'earliest'], answer: '30 days' },
                    { keywords: ['gender'], answer: 'Male' },
                    { keywords: ['manage team', 'team size', 'people managed'], answer: '50+' },
                    { keywords: ['visa', 'work permit', 'authorization'], answer: 'Yes' },
                ];

                // Process up to 5 chatbot questions
                for (let round = 0; round < 5; round++) {
                    await randomDelay(1500, 2500);

                    // Get the latest question text from the chatbot
                    const chatText = await page.textContent('[class*="chatbot"]').catch(() => '');
                    if (!chatText) break;

                    // Check for completion signals
                    if (/applied to/i.test(chatText) || /thank you/i.test(chatText) ||
                        /successfully/i.test(chatText) || /send me jobs/i.test(chatText)) {
                        logger.info('Chatbot flow complete — applied successfully');
                        break;
                    }

                    // Find the input field
                    const msgInput = await page.$('[class*="chatbot"] input[type="text"], [class*="chatbot"] textarea, [class*="chatbot"] [placeholder*="message"], [class*="chatbot"] [placeholder*="type"]');
                    if (!msgInput || !(await msgInput.isVisible().catch(() => false))) {
                        logger.info('No chatbot input field found — chatbot may be done');
                        break;
                    }

                    // Match question to answer
                    const questionLower = chatText.toLowerCase();
                    let answer = 'Yes'; // Default answer
                    for (const entry of answerMap) {
                        if (entry.keywords.some(kw => questionLower.includes(kw))) {
                            answer = entry.answer;
                            break;
                        }
                    }

                    logger.info(`Chatbot Q: "${chatText.slice(-80)}" → A: "${answer}"`);

                    // Type answer and submit
                    await msgInput.click();
                    await randomDelay(300, 500);
                    await msgInput.fill(answer);
                    await randomDelay(500, 800);

                    // Click Save/Send button
                    const saveBtn = await page.$('[class*="chatbot"] button:visible, [class*="chatbot"] [class*="save"], [class*="chatbot"] [class*="send"]');
                    if (saveBtn && await saveBtn.isVisible().catch(() => false)) {
                        await saveBtn.click();
                        await randomDelay(2000, 3000);
                    } else {
                        // Try pressing Enter
                        await msgInput.press('Enter');
                        await randomDelay(2000, 3000);
                    }
                }
            }
        } catch (chatErr) {
            logger.warn(`Chatbot interaction error: ${chatErr.message}`);
        }

        // Handle form fields that may appear in chatbot or modal
        try {
            const formFields = [
                { sel: SELECTORS.applyForm.noticePeriod, val: String(profile.noticePeriodDays) },
                { sel: SELECTORS.applyForm.currentCTC, val: String(profile.currentSalaryLPA) },
                { sel: SELECTORS.applyForm.expectedCTC, val: String(profile.expectedSalaryLPA) },
            ];
            for (const f of formFields) {
                const el = await page.$(f.sel);
                if (el && await el.isVisible().catch(() => false)) {
                    await el.fill('');
                    await el.type(f.val, { delay: 80 });
                    await randomDelay(300, 500);
                }
            }
            // Click Yes on any radio buttons
            const radios = await page.$$('input[type="radio"][value="Yes"], input[type="radio"][value="yes"]');
            for (const r of radios) {
                if (await r.isVisible().catch(() => false)) await r.click();
            }
            // Submit form if visible
            const submitBtn = await page.$(SELECTORS.applyForm.submitApplication);
            if (submitBtn && await submitBtn.isVisible().catch(() => false)) {
                await submitBtn.click();
                await randomDelay(2000, 3000);
            }
        } catch { }

        // ─── CONFIRM via multiple checks ───
        // Naukri redirects to a success page after applying that shows:
        //   "Applied to [Job Title]" with a green checkmark
        const afterText = await page.textContent('body').catch(() => '');
        const currentUrl = page.url();

        // Check 1: "Applied to" text on the success redirect page
        if (/Applied to\s+"/i.test(afterText) || /Applied to\s+'/i.test(afterText) ||
            /applied to\s+[""]/i.test(afterText)) {
            logger.info('✅ Application CONFIRMED — "Applied to" success page detected');
            return { success: true, reason: 'confirmed' };
        }

        // Check 2: other success indicators
        if (/already applied/i.test(afterText) || /successfully applied/i.test(afterText) ||
            /application submitted/i.test(afterText) || /applied successfully/i.test(afterText) ||
            /send me jobs like this/i.test(afterText)) {
            logger.info('✅ Application CONFIRMED — success text found');
            return { success: true, reason: 'confirmed' };
        }

        // Check 3: URL changed to success/applied page
        if (currentUrl.includes('applied') || currentUrl.includes('application') ||
            currentUrl.includes('success')) {
            logger.info('✅ Application CONFIRMED — redirected to success URL');
            return { success: true, reason: 'confirmed' };
        }

        // Check 4: apply button text changed
        const btnAfter = await page.$('#apply-button');
        if (btnAfter) {
            const aftText = (await btnAfter.textContent().catch(() => '')).toLowerCase();
            if (aftText.includes('applied')) {
                logger.info('✅ Application CONFIRMED — button says "Applied"');
                return { success: true, reason: 'confirmed' };
            }
        }

        logger.warn('Application NOT confirmed');
        return { success: false, reason: 'unconfirmed' };
    } catch (err) {
        logger.error(`Easy Apply error: ${err.message}`);
        return { success: false, reason: err.message };
    }
}

// ─── Send Recruiter Message ───
async function sendRecruiterMessage(page, recruiterName, messageText) {
    try {
        const msgBtn = await page.$(SELECTORS.jobDetail.messageButton);
        if (!msgBtn) {
            return { success: false, reason: 'no message button' };
        }

        const isVisible = await msgBtn.isVisible().catch(() => false);
        if (!isVisible) {
            return { success: false, reason: 'message button not visible' };
        }

        await randomDelay(1200, 2500);
        await msgBtn.click();
        await randomDelay(1500, 2500);

        // Find message textarea
        const textarea = await page.$('textarea, [contenteditable="true"], input[type="text"]');
        if (!textarea) {
            return { success: false, reason: 'message input not found' };
        }

        // Type message
        for (const char of messageText) {
            await page.keyboard.type(char, { delay: 0 });
            await randomDelay(30, 80);
        }

        await randomDelay(800, 1500);

        // Submit message
        const sendBtn = await page.$('button[type="submit"], button:has-text("Send"), button:has-text("Submit")');
        if (sendBtn) {
            await sendBtn.click();
            await randomDelay(1500, 2500);
            logger.info(`Recruiter message sent to ${recruiterName}`);
            return { success: true };
        }

        return { success: false, reason: 'send button not found' };
    } catch (err) {
        logger.error(`sendRecruiterMessage error: ${err.message}`);
        return { success: false, reason: err.message };
    }
}

// ─── Profile Refresh (resume upload + headline edit) ───
const RESUME_PATH = 'D:\\NB\\Aditya_Singh_Resume.pdf';

async function refreshProfileTimestamp(page) {
    const result = { resumeUploaded: false, headlineUpdated: false };

    try {
        await page.goto('https://www.naukri.com/mnjuser/profile', {
            waitUntil: 'domcontentloaded', timeout: 30000,
        });
        await randomDelay(3000, 5000);

        // ─── 1. Upload resume ───
        try {
            // Naukri has a hidden file input for resume upload
            // Look for file input or the "Update Resume" button
            const fileInput = await page.$('input[type="file"]');
            if (fileInput) {
                await fileInput.setInputFiles(RESUME_PATH);
                await randomDelay(3000, 5000);
                logger.info('Resume file set via input[type="file"]');
                result.resumeUploaded = true;
            } else {
                // Try clicking "Update Resume" / "Upload Resume" button first
                const uploadBtn = await page.$('[class*="update-resume"], [class*="upload-resume"], [id*="attachCV"], button:has-text("Update resume"), button:has-text("Upload Resume"), a:has-text("Update resume")');
                if (uploadBtn && await uploadBtn.isVisible().catch(() => false)) {
                    await uploadBtn.click();
                    await randomDelay(1500, 2500);
                    // Now look for the file input that appeared
                    const fileInput2 = await page.$('input[type="file"]');
                    if (fileInput2) {
                        await fileInput2.setInputFiles(RESUME_PATH);
                        await randomDelay(3000, 5000);
                        logger.info('Resume uploaded via Update Resume flow');
                        result.resumeUploaded = true;
                    }
                }
            }

            // Wait for upload confirmation
            if (result.resumeUploaded) {
                await randomDelay(2000, 3000);
                // Check for upload success
                const bodyText = await page.textContent('body').catch(() => '');
                if (/resume.*updated/i.test(bodyText) || /upload.*success/i.test(bodyText) ||
                    /file.*uploaded/i.test(bodyText)) {
                    logger.info('Resume upload confirmed');
                }
            }
        } catch (uploadErr) {
            logger.warn(`Resume upload error: ${uploadErr.message}`);
        }

        // ─── 2. Edit/Save headline to touch timestamp ───
        try {
            // Click edit on the resume headline section
            const editBtns = await page.$$('[class*="edit-icon"], .icon-edit, [class*="editIcon"], [data-section="resumeHeadline"] [class*="edit"]');
            for (const btn of editBtns) {
                if (await btn.isVisible().catch(() => false)) {
                    await btn.click();
                    await randomDelay(1500, 2500);

                    // Find save button and click it
                    const saveBtn = await page.$('button:has-text("Save"), button[type="submit"], [class*="save-btn"]');
                    if (saveBtn && await saveBtn.isVisible().catch(() => false)) {
                        await saveBtn.click();
                        await randomDelay(2000, 3000);
                        logger.info('Profile headline saved');
                        result.headlineUpdated = true;
                    }
                    break;
                }
            }

            // Fallback: click any edit icon on the page
            if (!result.headlineUpdated) {
                const anyEdit = await page.$('.widgetHead .edit, .widget-head .edit, .edit-btn');
                if (anyEdit && await anyEdit.isVisible().catch(() => false)) {
                    await anyEdit.click();
                    await randomDelay(1500, 2500);
                    const saveBtn = await page.$('button:has-text("Save"), button[type="submit"]');
                    if (saveBtn && await saveBtn.isVisible().catch(() => false)) {
                        await saveBtn.click();
                        await randomDelay(2000, 3000);
                        result.headlineUpdated = true;
                    }
                }
            }
        } catch (headErr) {
            logger.warn(`Headline edit error: ${headErr.message}`);
        }

        const ts = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
        logger.info(`Profile refresh done at ${ts}: resume=${result.resumeUploaded} headline=${result.headlineUpdated}`);
        return { success: true, ...result, time: ts };
    } catch (err) {
        logger.error(`Profile refresh error: ${err.message}`);
        return { success: false, ...result, error: err.message };
    }
}

// ─── Check Application Status ───
async function checkApplicationStatus(page) {
    try {
        await page.goto('https://www.naukri.com/mnjuser/recommendedjobs', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await randomDelay(2000, 3500);

        // Try to navigate to applied jobs
        const appliedLink = await page.$('a[href*="applied"], a:has-text("Applied")');
        if (appliedLink) {
            await appliedLink.click();
            await randomDelay(2000, 3000);
        }

        // Extract status info from the page
        const statusInfo = await page.evaluate(() => {
            const items = document.querySelectorAll('.applied-job, [class*="applied"], .job-tuple');
            return [...items].slice(0, 20).map(el => {
                const titleEl = el.querySelector('a, .title');
                const statusEl = el.querySelector('.status, [class*="status"], .viewed');
                return {
                    title: titleEl ? titleEl.textContent.trim() : '',
                    status: statusEl ? statusEl.textContent.trim().toLowerCase() : 'unknown',
                };
            });
        });

        return statusInfo;
    } catch (err) {
        logger.error(`checkApplicationStatus error: ${err.message}`);
        return [];
    }
}

module.exports = {
    SELECTORS,
    createBrowser,
    closeBrowser,
    detectCaptcha,
    login,
    isLoggedIn,
    setLoggedIn,
    searchJobs,
    getJDText,
    applyEasyApply,
    sendRecruiterMessage,
    refreshProfileTimestamp,
    checkApplicationStatus,
    randomDelay,
};
