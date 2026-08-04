@echo off
cd /d "%~dp0"

:: 检查是否解压运行（确保当前目录下存在主程序文件）
if not exist main.py (
    echo =================================================
    echo [错误] 启动失败：未在当前目录找到项目关键主程序！
    echo =================================================
    echo 出现该错误通常是因为：您直接在 ZIP 压缩包内双击启动了脚本。
    echo 请务必先将压缩包【全部解压】到一个普通文件夹中，再运行批处理。
    echo =================================================
    pause
    exit /b 1
)

echo =================================================
echo      本地数学题库教研系统 (Axiom) 便携版
echo =================================================
echo 正在释放端口...

for /f "tokens=5" %%a in ('netstat -aon ^| findstr LISTENING ^| findstr :8000') do (
    echo 检测到端口 8000 被占用，正在释放端口...
    taskkill /f /pid %%a >nul 2>&1
)

echo 正在启动后台服务...
:: 使用内置的便携式 Python 运行服务，输出重定向到日志文件
if not exist .system_generated mkdir .system_generated
del /f /q .system_generated\server.log >nul 2>&1

:: 使用 PowerShell 在后台静默运行
powershell -Command "Start-Process cmd -ArgumentList '/c python\python.exe -m uvicorn main:app --host 127.0.0.1 >.system_generated\server.log 2>&1' -WindowStyle Hidden"

echo 正在探测服务启动状态...
set TIMEOUT=10
set COUNTER=0
set SERVICE_READY=0

:loop
if %COUNTER% geq %TIMEOUT% goto end_loop

python\python.exe -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/questions')" >nul 2>&1
if not errorlevel 1 (
    echo [成功] 服务已成功启动！
    set SERVICE_READY=1
    goto end_loop
)

ping 127.0.0.1 -n 2 >nul
set /a COUNTER=%COUNTER%+1
goto loop

:end_loop
if %SERVICE_READY%==0 (
    echo [错误] 服务启动超时，后台服务启动失败！
    echo -------------------------------------------------
    if exist .system_generated\server.log (
        type .system_generated\server.log
    ) else (
        echo 未找到日志文件 .system_generated\server.log
    )
    echo -------------------------------------------------
    echo 请检查上述错误信息，或按任意键退出...
    pause
    exit
)

start http://127.0.0.1:8000
exit
