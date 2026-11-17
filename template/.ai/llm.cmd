@echo off
rem AI collaboration layer v2 launcher.
rem Bypasses per-folder script execution policy so any shell / AI tool can call it.
rem Usage is identical to llm.ps1:
rem   .ai\llm.cmd status
rem   .ai\llm.cmd add -Tool deepseek-harness -Action fix -Status ok -Summary "..."
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0llm.ps1" %*
exit /b %errorlevel%
