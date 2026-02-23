// src/outreach-extractor.js — Extract recruiter/contact info from JDs
const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');
const { callGemini } = require('./gemini');

const CONTACTS_FILE = path.resolve('memory/contacts.json');

// Initialize contacts file
if (!fs.existsSync(CONTACTS_FILE)) {
    fs.writeFileSync(CONTACTS_FILE, '[]');
}

/**
 * Extract contact information from the JD text using regex + Gemini Flash.
 */
async function extractContactInfo(jdText, job) {
    const result = {
        jobTitle: job.title,
        company: job.company,
        jobUrl: job.url,
        recruiterName: null,
        emails: [],
        phones: [],
        linkedinUrls: [],
        extractedAt: new Date().toISOString(),
    };

    const text = jdText || '';

    // --- Regex extraction ---

    // Emails
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const emails = text.match(emailRegex) || [];
    // Filter out common non-recruiter emails
    result.emails = [...new Set(emails)].filter(e =>
        !e.includes('noreply') && !e.includes('example.com') && !e.includes('test@')
    );

    // Phone numbers (Indian format)
    const phoneRegex = /(?:\+91[\s-]?)?[6-9]\d{9}/g;
    const phones = text.match(phoneRegex) || [];
    result.phones = [...new Set(phones)];

    // LinkedIn URLs  
    const linkedinRegex = /https?:\/\/(?:www\.)?linkedin\.com\/in\/[a-zA-Z0-9_-]+/gi;
    const linkedinUrls = text.match(linkedinRegex) || [];
    result.linkedinUrls = [...new Set(linkedinUrls)];

    // --- Gemini extraction for recruiter name ---
    if (text.length > 100) {
        try {
            const prompt = `Extract the recruiter or HR contact person's name from this job description. 
If no specific person is mentioned, respond with "none".
Only respond with the name or "none", nothing else.

Job Description excerpt:
${text.substring(0, 1500)}`;

            const name = await callGemini(prompt, 'keyword_extraction');
            if (name && name.trim().toLowerCase() !== 'none' && name.trim().length < 60) {
                result.recruiterName = name.trim();
            }
        } catch (err) {
            logger.debug(`Recruiter name extraction failed: ${err.message}`);
        }
    }

    // Only save if we found something useful
    const hasContact = result.emails.length > 0 || result.phones.length > 0 ||
        result.linkedinUrls.length > 0 || result.recruiterName;

    if (hasContact) {
        saveContact(result);
        logger.info(`Contact extracted for ${job.title} at ${job.company}: ` +
            `emails=${result.emails.length} phones=${result.phones.length} ` +
            `linkedin=${result.linkedinUrls.length} recruiter=${result.recruiterName || 'n/a'}`);
    }

    return hasContact ? result : null;
}

/**
 * Save a contact to the contacts.json file.
 */
function saveContact(contact) {
    try {
        const contacts = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
        // Avoid duplicates by job URL
        if (!contacts.some(c => c.jobUrl === contact.jobUrl)) {
            contacts.push(contact);
            fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2));
        }
    } catch (err) {
        logger.warn(`Failed to save contact: ${err.message}`);
    }
}

/**
 * Get all saved contacts.
 */
function getContacts() {
    try {
        return JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
    } catch {
        return [];
    }
}

/**
 * Format a contact for Telegram notification.
 */
function formatContactForTelegram(contact) {
    const parts = [`Contact found for ${contact.jobTitle} at ${contact.company}`];
    if (contact.recruiterName) parts.push(`Recruiter: ${contact.recruiterName}`);
    if (contact.emails.length) parts.push(`Email: ${contact.emails.join(', ')}`);
    if (contact.phones.length) parts.push(`Phone: ${contact.phones.join(', ')}`);
    if (contact.linkedinUrls.length) parts.push(`LinkedIn: ${contact.linkedinUrls.join(', ')}`);
    parts.push(`Job: ${contact.jobUrl}`);
    return parts.join('\n');
}

module.exports = { extractContactInfo, getContacts, formatContactForTelegram };
