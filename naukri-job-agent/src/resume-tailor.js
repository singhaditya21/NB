// src/resume-tailor.js — Dynamic Resume Tailoring via Gemini + pdf-lib
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { logger } = require('./logger');
const { callGemini } = require('./gemini');

const BASE_RESUME = path.resolve('D:\\NB\\Aditya_Singh_Resume.pdf');
const TAILORED_DIR = path.resolve('memory/tailored-resumes');

// Ensure directory exists
if (!fs.existsSync(TAILORED_DIR)) {
    fs.mkdirSync(TAILORED_DIR, { recursive: true });
}

/**
 * Ask Gemini to generate a tailored professional summary + key skills
 * based on the JD and the user's profile.
 */
async function generateTailoredContent(jdText, profile) {
    const prompt = `You are an expert resume writer for senior executives (VP/Director level, 15+ years experience).

Given the following Job Description and Candidate Profile, generate:
1. A tailored Professional Summary (3-4 sentences, max 60 words) that mirrors the JD's language and highlights the most relevant experience.
2. A list of 8-10 Key Skills that directly map to the JD requirements (pick from the candidate's actual skills).

Candidate Profile:
- Name: ${profile.name}
- Experience: ${profile.totalExperience}
- Education: ${profile.education}
- Certifications: ${profile.certifications.join(', ')}
- Skills: ${profile.skills.join(', ')}
- Resume Highlights:
${profile.resumeBullets.slice(0, 8).map(b => `  • ${b}`).join('\n')}

Job Description:
${jdText.substring(0, 3000)}

Respond in this exact JSON format:
{
  "summary": "...",
  "keySkills": ["skill1", "skill2", ...]
}`;

    try {
        const result = await callGemini(prompt, 'resume_tailor', { json: true });
        if (result && result.summary && result.keySkills) {
            logger.info(`Resume tailor: generated summary (${result.summary.length} chars) + ${result.keySkills.length} skills`);
            return result;
        }
        return null;
    } catch (err) {
        logger.warn(`Resume tailor Gemini call failed: ${err.message}`);
        return null;
    }
}

/**
 * Create a tailored resume PDF by appending a "Tailored Summary" page
 * to the original resume. This avoids the complexity of editing the
 * original PDF's text in place (which requires font matching).
 *
 * Strategy: Copy the original PDF pages, then prepend a cover page
 * with the tailored summary + skills targeted to this specific JD.
 */
async function tailorResume(jdText, job, profile) {
    try {
        // Generate tailored content via Gemini
        const content = await generateTailoredContent(jdText, profile);
        if (!content) {
            logger.info('Resume tailor: no content generated, using base resume');
            return BASE_RESUME;
        }

        // Load the base resume
        const basePdfBytes = fs.readFileSync(BASE_RESUME);
        const basePdf = await PDFDocument.load(basePdfBytes);

        // Create a new PDF with the cover page + original pages
        const tailoredPdf = await PDFDocument.create();
        const font = await tailoredPdf.embedFont(StandardFonts.Helvetica);
        const boldFont = await tailoredPdf.embedFont(StandardFonts.HelveticaBold);

        // --- Cover Page ---
        const coverPage = tailoredPdf.addPage([595.28, 841.89]); // A4
        const { width, height } = coverPage.getSize();
        let y = height - 60;

        // Name header
        coverPage.drawText(profile.name, {
            x: 50, y, size: 22, font: boldFont, color: rgb(0.1, 0.1, 0.4),
        });
        y -= 25;

        // Contact line
        coverPage.drawText(`${profile.email} | ${profile.phone} | ${profile.location}`, {
            x: 50, y, size: 9, font, color: rgb(0.3, 0.3, 0.3),
        });
        y -= 30;

        // Horizontal rule
        coverPage.drawLine({
            start: { x: 50, y }, end: { x: width - 50, y },
            thickness: 1, color: rgb(0.2, 0.2, 0.6),
        });
        y -= 25;

        // "Professional Summary" header
        coverPage.drawText('PROFESSIONAL SUMMARY', {
            x: 50, y, size: 12, font: boldFont, color: rgb(0.1, 0.1, 0.4),
        });
        y -= 20;

        // Summary text (word-wrap)
        const summaryLines = wrapText(content.summary, font, 9, width - 100);
        for (const line of summaryLines) {
            coverPage.drawText(line, { x: 50, y, size: 9, font, color: rgb(0, 0, 0) });
            y -= 14;
        }
        y -= 15;

        // "Key Skills" header
        coverPage.drawText('KEY SKILLS (TAILORED TO THIS ROLE)', {
            x: 50, y, size: 12, font: boldFont, color: rgb(0.1, 0.1, 0.4),
        });
        y -= 20;

        // Skills in two columns
        const skills = content.keySkills;
        const colWidth = (width - 100) / 2;
        for (let i = 0; i < skills.length; i += 2) {
            coverPage.drawText(`• ${skills[i]}`, { x: 50, y, size: 9, font, color: rgb(0, 0, 0) });
            if (skills[i + 1]) {
                coverPage.drawText(`• ${skills[i + 1]}`, { x: 50 + colWidth, y, size: 9, font, color: rgb(0, 0, 0) });
            }
            y -= 14;
        }
        y -= 15;

        // "Career Highlights" header
        coverPage.drawText('CAREER HIGHLIGHTS', {
            x: 50, y, size: 12, font: boldFont, color: rgb(0.1, 0.1, 0.4),
        });
        y -= 20;

        // Top 5 resume bullets
        const topBullets = profile.resumeBullets.slice(0, 5);
        for (const bullet of topBullets) {
            const bulletLines = wrapText(`• ${bullet}`, font, 8.5, width - 100);
            for (const line of bulletLines) {
                if (y < 60) break;
                coverPage.drawText(line, { x: 50, y, size: 8.5, font, color: rgb(0, 0, 0) });
                y -= 13;
            }
            y -= 4;
        }
        y -= 10;

        // Education + Certifications
        if (y > 100) {
            coverPage.drawText('EDUCATION & CERTIFICATIONS', {
                x: 50, y, size: 12, font: boldFont, color: rgb(0.1, 0.1, 0.4),
            });
            y -= 20;
            coverPage.drawText(profile.education, { x: 50, y, size: 9, font, color: rgb(0, 0, 0) });
            y -= 14;
            coverPage.drawText(`Certifications: ${profile.certifications.join(' | ')}`, {
                x: 50, y, size: 9, font, color: rgb(0, 0, 0),
            });
        }

        // Footer
        coverPage.drawText(`Tailored for: ${job.title} at ${job.company}`, {
            x: 50, y: 30, size: 7, font, color: rgb(0.5, 0.5, 0.5),
        });

        // --- Copy original resume pages ---
        const copiedPages = await tailoredPdf.copyPages(basePdf, basePdf.getPageIndices());
        for (const page of copiedPages) {
            tailoredPdf.addPage(page);
        }

        // Save
        const pdfBytes = await tailoredPdf.save();
        const jobSlug = `${job.company}-${job.title}`.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 60);
        const outPath = path.join(TAILORED_DIR, `${jobSlug}.pdf`);
        fs.writeFileSync(outPath, pdfBytes);

        logger.info(`Tailored resume saved: ${outPath} (${Math.round(pdfBytes.length / 1024)} KB)`);
        return outPath;
    } catch (err) {
        logger.error(`Resume tailor failed: ${err.message}`);
        return BASE_RESUME; // Fallback to base resume
    }
}

/**
 * Word-wrap helper for pdf-lib (no built-in wrap support)
 */
function wrapText(text, font, fontSize, maxWidth) {
    const words = text.split(' ');
    const lines = [];
    let currentLine = '';

    for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word;
        const testWidth = font.widthOfTextAtSize(testLine, fontSize);
        if (testWidth > maxWidth && currentLine) {
            lines.push(currentLine);
            currentLine = word;
        } else {
            currentLine = testLine;
        }
    }
    if (currentLine) lines.push(currentLine);
    return lines;
}

module.exports = { tailorResume, generateTailoredContent };
