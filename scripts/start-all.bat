@echo off
title Dev Flow Server + ngrok
echo ==========================================
echo Starting Dev Flow Project and ngrok...
echo ==========================================
cd /d "%~dp0.."

echo [1] Starting Dev Flow API (npm run dev)...
start "Dev Flow API" cmd /k "npm run dev"

echo [2] Starting ngrok on port 3000...
echo ==========================================
echo *** หากคุณได้ Static Domain แล้ว ให้คลิกขวาที่ไฟล์นี้ เลือก Edit 
echo *** แล้วแก้คำสั่งบรรทัดล่างสุดให้เป็น ngrok http --domain=ชื่อโดเมนคุณ 3000 นะครับ
echo ==========================================
start "ngrok Tunnel" cmd /k "ngrok http --domain=bacteria-attendee-ferocity.ngrok-free.dev 3000"

echo.
echo Both services are starting in new windows!
echo คุณสามารถปิดหน้าต่างนี้ได้เลยครับ
echo ==========================================
pause
