$ErrorActionPreference = 'Stop'
$installer = Join-Path $env:RUNNER_TEMP 'podman.msi'
Invoke-WebRequest -Uri 'https://github.com/podman-container-tools/podman/releases/download/v5.8.3/podman-installer-windows-amd64.msi' -OutFile $installer
if ((Get-FileHash $installer -Algorithm SHA256).Hash -ne '2c5cffb2f023ae122d52d7f4b30bb677adb933fb7aa7ad708d3d544f8d6fe13a') {
    throw 'Podman installer checksum did not match.'
}
$installation = Start-Process msiexec.exe -Wait -PassThru -ArgumentList "/i `"$installer`" /qn /norestart"
if ($installation.ExitCode -ne 0) { throw "Podman installation failed: $($installation.ExitCode)" }
$env:PATH = $env:PATH + ';' + [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
$podmanDirectory = Split-Path (Get-Command podman -ErrorAction Stop).Source
Add-Content -Path $env:GITHUB_PATH -Value $podmanDirectory
podman machine init
if ($LASTEXITCODE -ne 0) { throw 'Podman machine initialization failed.' }
$ready = $false
for ($attempt = 1; $attempt -le 3; $attempt++) {
    podman machine start
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Podman machine start failed on attempt $attempt; checking API readiness."
    }
    # WSL's first boot can lag behind machine start, including a failed start.
    # A usable API is the readiness check; machine state alone is insufficient.
    for ($probe = 0; $probe -lt 10; $probe++) {
        # Windows PowerShell turns redirected native stderr into error records.
        # Connection failures here are expected until the machine is ready.
        $previousErrorAction = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            podman info --format json *> $null
            $ready = $LASTEXITCODE -eq 0
        } finally {
            $ErrorActionPreference = $previousErrorAction
        }
        if ($ready) { break }
        Start-Sleep -Seconds 3
    }
    if ($ready) { break }
    if ($attempt -lt 3) {
        Write-Warning "Podman API is unavailable after attempt $attempt; restarting the CI machine."
        podman machine stop
        if ($LASTEXITCODE -ne 0) {
            # Only terminate the WSL distribution created by this script.
            wsl.exe --terminate podman-machine-default
            if ($LASTEXITCODE -ne 0) { throw 'Could not stop the failed Podman machine.' }
        }
        Start-Sleep -Seconds 3
    }
}
if (-not $ready) {
    podman machine inspect
    podman system connection list
    wsl.exe --list --verbose
    throw 'Podman API did not become ready after three startup attempts.'
}
podman machine ssh 'test -c /dev/fuse'
if ($LASTEXITCODE -ne 0) { throw 'The Podman machine has no /dev/fuse device.' }
