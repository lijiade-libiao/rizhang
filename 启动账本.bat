@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 日账 - 本地服务
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
if errorlevel 1 pause
