@echo off
:: Naukri Job Agent — Auto-start script
:: Placed in Windows Startup folder to run on user login

cd /d D:\NB\naukri-job-agent

:: Wait 30 seconds for network to be ready after boot
timeout /t 30 /nobreak > nul

:: Start the agent (minimized, logs appended)
start /min "NaukriAgent" cmd /c "node src/index.js >> memory\startup.log 2>&1"
