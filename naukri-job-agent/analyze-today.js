const fs = require('fs');
const path = require('path');
const memFile = path.resolve('memory/applied-jobs.json');

if (!fs.existsSync(memFile)) {
    console.log('No applied-jobs.json file found:', memFile);
    process.exit(1);
}

// Ensure the file exists and is parsable
let appliedJobs = [];
try {
    appliedJobs = JSON.parse(fs.readFileSync(memFile, 'utf8'));
} catch (e) {
    console.log('Error parsing JSON:', e.message);
    process.exit(1);
}

const today = new Date().toISOString().split('T')[0]; // Current date YYYY-MM-DD

// Some jobs might have different date formats or no appliedAt.
const appliedToday = appliedJobs.filter(j => j.appliedAt && j.appliedAt.startsWith(today));

console.log(`\n=== 📊 NAUKRI AUTO-APPLY STATS FOR TODAY (${today}) ===\n`);
console.log(`✅ Total successful applications today: ${appliedToday.length}`);

// Group by role
const byRole = {};
appliedToday.forEach(j => {
    if (j.score) {
        let scoreVal = j.score.quickScore || j.score.score || '?';
        let key = `Score ${scoreVal}`;
        byRole[key] = (byRole[key] || 0) + 1;
    } else {
        byRole['Unknown Score'] = (byRole['Unknown Score'] || 0) + 1;
    }
});

console.log('\n📈 Breakdown by Match Score (>= 45 required to apply):');
Object.keys(byRole).sort().reverse().forEach(score => {
    console.log(`  • ${score}: ${byRole[score]} jobs`);
});

console.log('\n📝 Last 10 Applications:');
const last10 = appliedToday.slice(-10);
last10.forEach((j, i) => {
    // try to get time out of ISO string if possible
    let time = j.appliedAt;
    if (time.includes('T')) {
        time = time.split('T')[1].substring(0, 8);
    }
    const score = j.score ? (j.score.quickScore || j.score.score) : '?';
    console.log(`  ${i + 1}. [${time}] Score ${score} | ${j.title} @ ${j.company}`);
});
console.log('\n');
