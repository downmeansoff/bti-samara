@echo off
cd /d "%~dp0"
title Deploy BTI Samara

echo.
echo ============================================
echo   DEPLOY: sayt BTI Samara
echo ============================================
echo.
echo [1/3] GitHub Pages - zerkalo...
echo.
git push origin main
if errorlevel 1 goto failed
echo.
echo   OK. Sborka zaymet okolo minuty.
echo.
echo [2/3] Railway - zayavki i zerkalo...
echo.
call railway up --ci
echo.
echo [3/3] kadastrhelp.ru - osnovnoy sayt...
echo.
"C:\Program Files\Git\bin\bash.exe" "C:/Users/glebo/bti-lab/tools/upload-hosting.sh"
if errorlevel 1 goto failed
echo.
echo ============================================
echo   GOTOVO
echo ============================================
echo.
echo   https://kadastrhelp.ru/
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
