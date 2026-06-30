$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

function Find-Python {
    $commands = @("python", "py")
    foreach ($cmd in $commands) {
        $found = Get-Command $cmd -ErrorAction SilentlyContinue
        if ($found) { return $cmd }
    }
    return $null
}

$python = Find-Python
if (-not $python) {
    Write-Host "[CC Bridge] 未检测到 Python 3.10+。"
    $assumeYes = $env:CCB_BOOTSTRAP_ASSUME_YES -eq "1" -or ($args -contains "--yes")
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        $install = $assumeYes
        if (-not $install) {
            $answer = Read-Host "是否使用 winget 安装 Python 3.12？[y/N]"
            $install = $answer -in @("y", "Y", "yes", "YES")
        }
        if ($install) {
            winget install --id Python.Python.3.12 -e
            $python = Find-Python
        }
    }
    if (-not $python) {
        Write-Host "[ERROR] 请安装 Python 3.10 或更新版本后重试：https://www.python.org/downloads/"
        exit 1
    }
}

Write-Host "[CC Bridge] 启动 bootstrap..."
& $python -u bootstrap.py @args
exit $LASTEXITCODE
