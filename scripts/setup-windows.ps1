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
podman machine start
if ($LASTEXITCODE -ne 0) { throw 'Podman machine startup failed.' }
podman machine ssh 'test -c /dev/fuse'
if ($LASTEXITCODE -ne 0) { throw 'The Podman machine has no /dev/fuse device.' }
