param([switch]$Open)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
$scriptPath = $PSCommandPath
$nodePath = (Get-Command node.exe).Source
$config = & $nodePath -r dotenv/config -p 'JSON.stringify({ port: process.env.PORT || 3000, dbHost: process.env.DB_HOST || "127.0.0.1", dbPort: process.env.DB_PORT || 3306 })' | ConvertFrom-Json
$baseUrl = "http://localhost:$($config.port)"
$logPath = Join-Path $env:LOCALAPPDATA 'TAASCOR-local.log'

if ($Open) {
    $powershellPath = Join-Path $PSHOME 'powershell.exe'
    $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""
    Start-Process -FilePath $powershellPath -ArgumentList $arguments -WindowStyle Hidden
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    do {
        try {
            $health = Invoke-RestMethod "$baseUrl/health" -TimeoutSec 2
            if ($health.status -eq 'ok' -and $health.timestamp) {
                Start-Process "$baseUrl/login"
                exit 0
            }
        } catch {}
        Start-Sleep -Seconds 1
    } while ([DateTime]::UtcNow -lt $deadline)
    Write-Error "TAASCOR did not start. Check $logPath and $logPath.errors."
}

function Test-DatabasePort {
    $client = New-Object Net.Sockets.TcpClient
    try {
        $connection = $client.ConnectAsync([string]$config.dbHost, [int]$config.dbPort)
        return $connection.Wait(1000) -and $client.Connected
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

$mutex = New-Object Threading.Mutex($false, "Local\TAASCOR-$($config.port)")
$ownsMutex = $false
$xampp = 'C:\xampp'
$mysql = Join-Path $xampp 'mysql\bin\mysqld.exe'
$mysqlConfig = Join-Path $xampp 'mysql\bin\my.ini'
$canStartMySql = $config.dbHost -in @('127.0.0.1', 'localhost') -and $config.dbPort -eq 3306 -and
    (Test-Path -LiteralPath $mysql) -and (Test-Path -LiteralPath $mysqlConfig)
$mysqlProcess = $null

function Start-LocalDatabase {
    if (!$canStartMySql -or ($script:mysqlProcess -and !$script:mysqlProcess.HasExited) -or (Test-DatabasePort)) {
        return
    }
    $script:mysqlProcess = Start-Process $mysql -ArgumentList "--defaults-file=`"$mysqlConfig`" --standalone" -WorkingDirectory $xampp -WindowStyle Hidden -PassThru
    for ($attempt = 0; $attempt -lt 10 -and !$script:mysqlProcess.HasExited; $attempt++) {
        if (Test-DatabasePort) { break }
        Start-Sleep -Seconds 1
    }
}

try {
    try { $ownsMutex = $mutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { exit 0 }

    while ($true) {
        Start-LocalDatabase
        if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 1MB) {
            Move-Item -LiteralPath $logPath -Destination "$logPath.previous" -Force
        }
        $server = Start-Process $nodePath -ArgumentList 'server.js' -WindowStyle Hidden -PassThru -RedirectStandardOutput "$logPath.output" -RedirectStandardError "$logPath.errors"
        while (!$server.WaitForExit(10000)) {
            Start-LocalDatabase
        }
        Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format s) TAASCOR exited with code $($server.ExitCode). Retrying in 10 seconds."
        Start-Sleep -Seconds 10
    }
} finally {
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
