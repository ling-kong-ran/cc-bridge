param(
    [ValidateSet('pack', 'installer')]
    [string]$Target = 'installer',

    [switch]$SkipInstall,

    [switch]$Release,

    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$Version
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $RepoRoot

function Invoke-Step($Message, [scriptblock]$Block) {
    Write-Host "[CC Bridge] $Message"
    & $Block
    if ($LASTEXITCODE) {
        exit $LASTEXITCODE
    }
}

Invoke-Step 'Check Node/npm environment' {
    $null = Get-Command node -ErrorAction Stop
    $null = Get-Command npm -ErrorAction Stop
}

if ($Release) {
    Invoke-Step 'Check GitHub CLI environment' {
        $null = Get-Command gh -ErrorAction Stop
        gh auth status
    }
}

Invoke-Step 'Check Python entry syntax' {
    python -m py_compile server.py bootstrap.py bootstrap/launcher.py
}

if (-not $SkipInstall) {
    if (Test-Path package-lock.json) {
        Invoke-Step 'Install npm dependencies with npm ci' { npm ci }
    } else {
        Invoke-Step 'Install npm dependencies with npm install' { npm install }
    }
}

if ($Release) {
    if ($Target -eq 'pack') {
        throw 'Release requires installer target.'
    }

    $Package = Get-Content package.json -Raw | ConvertFrom-Json
    if (-not $Version) {
        $Parts = $Package.version.Split('.')
        $Patch = [int]$Parts[2] + 1
        $Version = "$($Parts[0]).$($Parts[1]).$Patch"
    }

    Invoke-Step "Set package version to $Version" {
        npm version $Version --no-git-tag-version
    }
}

if ($Target -eq 'pack') {
    Invoke-Step 'Build unpacked desktop app' { npm run desktop:pack }
} else {
    Invoke-Step 'Build Windows installer' { npm run desktop:dist:win }
}

if ($Release) {
    $Tag = "v$Version"
    $Installer = Join-Path $RepoRoot "release\CC-Bridge-$Version-win-x64.exe"
    $LatestYml = Join-Path $RepoRoot 'release\latest.yml'
    $BlockMap = "$Installer.blockmap"

    if (-not (Test-Path $Installer)) {
        throw "Installer not found: $Installer"
    }
    if (-not (Test-Path $LatestYml)) {
        throw "Update metadata not found: $LatestYml"
    }

    $Assets = @($Installer, $LatestYml)
    if (Test-Path $BlockMap) {
        $Assets += $BlockMap
    }

    Invoke-Step "Create or update GitHub release $Tag" {
        gh release view $Tag *> $null
        if ($LASTEXITCODE -eq 0) {
            gh release upload $Tag @Assets --clobber
        } else {
            gh release create $Tag @Assets --title "CC Bridge $Version" --notes "CC Bridge desktop release $Version"
        }
    }
}

Write-Host "[CC Bridge] Done. Output: $RepoRoot\release"
