param(
    [ValidatePattern('^COM\d+$')]
    [string]$PortName = 'COM3',
    [ValidateRange(9600, 2000000)]
    [int]$BaudRate = 115200
)

$ErrorActionPreference = 'Stop'

function Read-UsbCommand {
    param(
        [System.IO.Ports.SerialPort]$Port,
        [string]$Command
    )

    $Port.DiscardInBuffer()
    $Port.WriteLine($Command)
    $buffer = [System.Text.StringBuilder]::new()
    $lastByteAt = [DateTime]::UtcNow
    $deadline = [DateTime]::UtcNow.AddSeconds(4)

    while ([DateTime]::UtcNow -lt $deadline) {
        if ($Port.BytesToRead -gt 0) {
            [void]$buffer.Append($Port.ReadExisting())
            $lastByteAt = [DateTime]::UtcNow
        } elseif ($buffer.Length -gt 0 -and ([DateTime]::UtcNow - $lastByteAt).TotalMilliseconds -gt 250) {
            break
        }
        Start-Sleep -Milliseconds 50
    }

    return $buffer.ToString()
}

function Read-RawJsonResponse {
    param(
        [System.IO.Ports.SerialPort]$Port,
        [string]$Command
    )

    $text = Read-UsbCommand -Port $Port -Command $Command
    $line = $text -split "`r?`n" | Where-Object { $_.StartsWith('@{') } | Select-Object -Last 1
    if (-not $line) {
        throw "USB command '$Command' returned no JSON response."
    }

    $response = $line.Substring(1) | ConvertFrom-Json
    return $response
}

function Read-JsonResponse {
    param(
        [System.IO.Ports.SerialPort]$Port,
        [string]$Command
    )

    $response = Read-RawJsonResponse -Port $Port -Command $Command
    if (-not $response.ok) {
        throw "USB command '$Command' returned an error."
    }
    return $response
}

$port = [System.IO.Ports.SerialPort]::new(
    $PortName,
    $BaudRate,
    [System.IO.Ports.Parity]::None,
    8,
    [System.IO.Ports.StopBits]::One
)
$port.ReadTimeout = 100
$port.NewLine = "`n"

try {
    $port.Open()
    Start-Sleep -Milliseconds 200

    $status = (Read-JsonResponse -Port $port -Command 'status').data
    foreach ($field in @('config_valid', 'safe_mode', 'wifi_connected', 'ap_active', 'web_available', 'modem_available')) {
        $property = $status.PSObject.Properties[$field]
        if (-not $property -or $property.Value -isnot [bool]) {
            throw "Status field '$field' is missing or is not boolean."
        }
    }

    $config = (Read-JsonResponse -Port $port -Command 'config show').data
    $secretKeys = @(
        'wifi_password', 'wifi2_password', 'ap_password', 'web_admin_password',
        'smtp_password', 'pushplus_token', 'gotify_token', 'telegram_bot_token', 'server_token'
    )
    foreach ($key in $secretKeys) {
        $valueProperty = $config.PSObject.Properties[$key]
        $configuredProperty = $config.PSObject.Properties["${key}_configured"]
        if (-not $valueProperty -or $null -ne $valueProperty.Value -or
            -not $configuredProperty -or $configuredProperty.Value -isnot [bool]) {
            throw "Secret redaction failed for '$key'."
        }
    }

    $logs = (Read-JsonResponse -Port $port -Command 'logs').data
    if ($logs -isnot [array]) {
        throw 'The log response is not an array.'
    }
    $crashPattern = '(?i)Guru Meditation|panic(ed)?|abort\(\) was called|assert failed:|stack smashing protect failure|Backtrace:'
    if (($logs -join "`n") -match $crashPattern) {
        throw 'A crash signature was found in the device logs.'
    }

    $ota = (Read-JsonResponse -Port $port -Command 'ota status').data
    if (-not $ota.partition -or -not $ota.state) {
        throw 'OTA status is missing its partition or state.'
    }

    $help = Read-UsbCommand -Port $port -Command 'help'
    if ($help -notmatch 'JSONL requests are also accepted') {
        throw 'The maintenance help response is incomplete.'
    }

    $invalidJson = Read-RawJsonResponse -Port $port -Command '{"v":1,"id":"usb-smoke-invalid-json",'
    if ($invalidJson.ok -or $invalidJson.error -ne 'invalid JSON') {
        throw 'Malformed JSON was not rejected correctly.'
    }
    $nonStringOp = Read-RawJsonResponse -Port $port -Command '{"v":1,"id":"usb-smoke-numeric-op","op":7}'
    if ($nonStringOp.ok -or $nonStringOp.error -ne 'missing op') {
        throw 'A non-string operation was not rejected correctly.'
    }
    $missingOp = Read-RawJsonResponse -Port $port -Command '{"v":1,"id":"usb-smoke-missing-op"}'
    if ($missingOp.ok -or $missingOp.error -ne 'missing op') {
        throw 'A JSON request without an operation was not rejected correctly.'
    }
    $unsupportedOp = Read-RawJsonResponse -Port $port -Command '{"v":1,"id":"usb-smoke-unsupported-op","op":"__unsupported__"}'
    if ($unsupportedOp.ok -or $unsupportedOp.error -ne 'unsupported operation') {
        throw 'An unsupported JSON operation was not rejected correctly.'
    }

    $overlongSsidRequest = @{
        v = 1
        id = 'usb-smoke-overlong-ssid'
        op = 'config.set'
        key = 'wifi_ssid'
        value = 'x' * 33
    } | ConvertTo-Json -Compress
    $overlongSsid = Read-RawJsonResponse -Port $port -Command $overlongSsidRequest
    if ($overlongSsid.ok -or $overlongSsid.error -ne 'unknown key or value is too long/invalid') {
        throw 'An overlong Wi-Fi SSID was not rejected correctly.'
    }
    foreach ($value in @('not-a-number', '4294967296', '-1')) {
        $invalidHeartbeatRequest = @{
            v = 1
            id = "usb-smoke-invalid-heartbeat-$value"
            op = 'config.set'
            key = 'heartbeat_sec'
            value = $value
        } | ConvertTo-Json -Compress
        $invalidHeartbeat = Read-RawJsonResponse -Port $port -Command $invalidHeartbeatRequest
        if ($invalidHeartbeat.ok -or $invalidHeartbeat.error -ne 'unknown key or value is too long/invalid') {
            throw "Invalid heartbeat interval '$value' was not rejected correctly."
        }
    }
    $configAfterRejectedSet = (Read-JsonResponse -Port $port -Command '{"v":1,"id":"usb-smoke-config-after-set","op":"config.get"}').data
    if ($configAfterRejectedSet.wifi_ssid -cne $config.wifi_ssid -or
        $configAfterRejectedSet.heartbeat_sec -ne $config.heartbeat_sec -or
        $configAfterRejectedSet.generation -ne $config.generation) {
        throw 'Rejected configuration values changed the staged or saved configuration.'
    }

    Write-Output ("USB safety smoke passed: status, {0} redacted secrets, {1} log entries, OTA status, help, 8 rejected-input cases, rejected config.set unchanged. safe_mode={2}; config_valid={3}; ap_active={4}; web_available={5}; modem_available={6}" -f `
        $secretKeys.Count, $logs.Count, $status.safe_mode, $status.config_valid, $status.ap_active, $status.web_available, $status.modem_available)
} finally {
    if ($port.IsOpen) {
        $port.Close()
    }
}
