@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul 2>&1
title Setup GitHub repository

rem =====================================================================
rem setup_github.bat - 把"当前目录"设置为 GitHub 仓库,关联 origin/main 并推送
rem
rem 凭据文件: 优先目标目录下的 .env,找不到时用脚本所在目录的 .env
rem   GITHUB_TOKEN     GitHub PAT,只在内存与临时 -c 参数中使用,
rem                    不写入 .git/config,也不会拼进 remote URL
rem   GITHUB_REPO_URL  仓库地址,如 https://github.com/RONGLINC93/touch.git
rem   可选: GIT_USER_NAME / GIT_USER_EMAIL,本机未配置 git 身份时临时传入,
rem         脚本不会修改任何 git 配置
rem
rem 用法:
rem   setup_github.bat                     对当前目录操作,执行前确认,结束后暂停
rem   setup_github.bat "D:\path\to\dir"    对指定目录操作
rem   setup_github.bat --check             只检查配置,不做任何改动
rem   setup_github.bat --yes               跳过确认与暂停,供自动化使用
rem
rem 所有 git 命令都带 -c safe.directory,兼容目录所有者与当前用户不一致的情况。
rem =====================================================================

set "TARGET=%CD%"
set "CHECK=0"
set "ASSUME_YES=0"

:parse
if "%~1"=="" goto parsed
if /i "%~1"=="--check" ( set "CHECK=1" & shift & goto parse )
if /i "%~1"=="--yes" ( set "ASSUME_YES=1" & shift & goto parse )
set "TARGET=%~1"
shift
goto parse
:parsed

for %%I in ("%TARGET%") do set "TARGET=%%~fI"
set "SAFE_DIR=%TARGET:\=/%"

rem ---- 凭据文件:优先目标目录的 .env,其次脚本所在目录的 .env ----
set "ENV_FILE=%TARGET%\.env"
if not exist "%ENV_FILE%" set "ENV_FILE=%~dp0.env"

if not exist "%TARGET%\." ( echo [错误] 目录不存在: %TARGET% & goto fail )
if not exist "%ENV_FILE%" ( echo [错误] 未找到 .env,请把 .env 放在目标目录或脚本目录 & goto fail )

echo 目标目录: %TARGET%
echo 凭据文件: %ENV_FILE%

rem ---- 读取 .env:支持 # 注释、key=value、可选引号、首尾空格 ----
set "GH_TOKEN="
set "REPO_URL="
set "GIT_USER_NAME="
set "GIT_USER_EMAIL="
for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
    set "KEY=%%~A"
    set "VAL=%%~B"
    set "KEY=!KEY: =!"
    set "VAL=!VAL: =!"
    if /i "!KEY!"=="GITHUB_TOKEN" set "GH_TOKEN=!VAL!"
    if /i "!KEY!"=="GITHUB_REPO_URL" set "REPO_URL=!VAL!"
    if /i "!KEY!"=="GIT_USER_NAME" set "GIT_USER_NAME=!VAL!"
    if /i "!KEY!"=="GIT_USER_EMAIL" set "GIT_USER_EMAIL=!VAL!"
)
if not defined GH_TOKEN (
    echo [错误] .env 中缺少 GITHUB_TOKEN
    goto fail
)

rem ---- 用 PowerShell 生成 basic 认证头,token 只经环境变量传递,不出现在命令行 ----
set "AUTH_B64="
for /f "usebackq delims=" %%B in (`powershell -NoProfile -NonInteractive -Command "[Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes('x-access-token:' + $env:GH_TOKEN))"`) do set "AUTH_B64=%%B"
if not defined AUTH_B64 (
    echo [错误] 生成认证头失败,需要 PowerShell
    goto fail
)

cd /d "%TARGET%" || goto fail

rem ---- 仓库 URL:优先 .env,否则沿用已有 origin ----
if not defined REPO_URL (
    for /f "delims=" %%U in ('git -c "safe.directory=%SAFE_DIR%" remote get-url origin 2^>nul') do set "REPO_URL=%%U"
)
if not defined REPO_URL (
    echo [错误] .env 中缺少 GITHUB_REPO_URL,且当前目录没有 origin
    goto fail
)
echo(!REPO_URL!| findstr /i /c:"@" >nul && (
    echo [错误] GITHUB_REPO_URL 似乎含账号或凭据,请使用不含 token 的 https URL
    goto fail
)

echo 仓库 URL : %REPO_URL%
echo Token    : 已读取
echo 认证头   : 已生成
git --version

if "%CHECK%"=="1" (
    echo.
    echo 当前仓库状态,只读:
    call :git status -sb
    echo.
    echo [检查完成] 未对仓库做任何改动
    goto done
)

if "%ASSUME_YES%"=="0" (
    choice /c YN /n /m "Proceed with init/commit/push to origin main? [Y/N] "
    if errorlevel 2 goto cancelled
)

rem ---- 防止把本地 .env 误提交 ----
if exist ".env" (
    call :git check-ignore -q .env >nul 2>&1
    if errorlevel 1 (
        echo [错误] 当前目录存在 .env 但未被 .gitignore 忽略,为防凭据泄露已中止
        goto fail
    )
)

rem ---- 初始化,保留已有历史,并统一分支为 main ----
if not exist ".git\." (
    call :git init >nul
    if errorlevel 1 ( echo [错误] git init 失败 & goto fail )
    call :git symbolic-ref HEAD refs/heads/main >nul
    echo [完成] 已初始化仓库,分支 main
) else (
    echo [提示] 已是 git 仓库,保留现有历史
)

rem ---- 设置 remote,不含 token ----
call :git remote get-url origin >nul 2>&1
if errorlevel 1 (
    call :git remote add origin "%REPO_URL%"
) else (
    call :git remote set-url origin "%REPO_URL%"
)
if errorlevel 1 ( echo [错误] 设置 origin 失败 & goto fail )
echo [完成] origin = %REPO_URL%

rem ---- 提交 ----
call :git add -A
if errorlevel 1 ( echo [错误] git add 失败 & goto fail )
call :git diff --cached --quiet
if errorlevel 1 (
    if defined GIT_USER_NAME if defined GIT_USER_EMAIL (
        call :git -c "user.name=!GIT_USER_NAME!" -c "user.email=!GIT_USER_EMAIL!" commit -m "chore: setup github repo"
    ) else (
        call :git commit -m "chore: setup github repo"
    )
    if errorlevel 1 (
        echo [错误] git commit 失败;若提示身份未配置,请在 .env 提供 GIT_USER_NAME/GIT_USER_EMAIL
        goto fail
    )
    echo [完成] 已提交本地改动
) else (
    echo [提示] 无待提交改动
)

rem ---- 远程已有 main 时先变基,再推送 ----
call :git ls-remote --exit-code --heads origin main >nul 2>&1
if not errorlevel 1 (
    call :git pull --rebase origin main
    if errorlevel 1 ( echo [错误] pull --rebase 失败,请手动处理冲突 & goto fail )
)
call :git push -u origin main
if errorlevel 1 (
    echo [错误] push 失败,请检查 token 权限、网络、远程仓库是否存在
    goto fail
)

echo.
echo [完成] %TARGET% 已关联 %REPO_URL% 并推送到 main
goto done

rem ---------------------------------------------------------------------
:git
git -c "safe.directory=%SAFE_DIR%" -c "http.https://github.com/.extraheader=AUTHORIZATION: basic %AUTH_B64%" %*
exit /b %ERRORLEVEL%

:fail
echo [失败] 操作未完成,工作区可能已有部分改动,请用 git status 查看
set "EXITCODE=1"
goto cleanup

:cancelled
echo 已取消,未做任何改动
set "EXITCODE=1"
goto cleanup

:done
set "EXITCODE=0"

:cleanup
set "GH_TOKEN="
set "AUTH_B64="
set "KEY="
set "VAL="
if "%CHECK%"=="0" if "%ASSUME_YES%"=="0" pause
exit /b %EXITCODE%
