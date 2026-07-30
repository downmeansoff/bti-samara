@echo off
cd /d "%~dp0"
title Deploy BTI Samara

echo.
echo ============================================
echo   DEPLOY: sayt BTI Samara
echo ============================================
echo.
echo [1/2] GitHub Pages - osnovnaya ssylka...
echo.
git push origin main
if errorlevel 1 goto failed
echo.
echo   OK. Sborka zaymet okolo minuty.
echo.
echo [2/2] Railway - rezervnaya ssylka...
echo.
call railway up --ci
echo.
echo ============================================
echo   GOTOVO
echo ============================================
echo.
echo   https://downmeansoff.github.io/bti-samara/
echo   https://bti-samara-landing-production.up.railway.app
echo.
echo   Podozhdite minutu, potom Ctrl+F5 na sayte.
echo.
pause
exit /b 0

:failed
echo.
echo   OSHIBKA pri otpravke.
echo   Chasto eto obryv svyazi - prosto zapustite fayl esche raz.
echo.
pause
exit /b 1
