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
        $null = Get-Command git -ErrorAction Stop
        gh auth status
    }
}

Invoke-Step 'Check Python entry syntax' {
    $PythonFiles = @('server.py', 'bootstrap.py', 'ccb_bridge.py') + (Get-ChildItem -Path 'bootstrap' -Filter '*.py' | ForEach-Object { $_.FullName })
    python -m py_compile @PythonFiles
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

    $PackageJson = [System.IO.File]::ReadAllText((Join-Path $RepoRoot 'package.json'), [System.Text.Encoding]::UTF8)
    $Package = $PackageJson | ConvertFrom-Json
    if (-not $Version) {
        $Parts = $Package.version.Split('.')
        $Patch = [int]$Parts[2] + 1
        $Version = "$($Parts[0]).$($Parts[1]).$Patch"
    }

    $Tag = "v$Version"

    Invoke-Step "Set package version to $Version" {
        npm version $Version --no-git-tag-version --allow-same-version
    }

    Invoke-Step "Commit package version $Version" {
        git add package.json package-lock.json
        git diff --cached --quiet
        if ($LASTEXITCODE -eq 0) {
            Write-Host "[CC Bridge] package files already committed at $Version"
            $Global:LASTEXITCODE = 0
        } else {
            git commit -m "提升桌面端版本到 $Version"
        }
    }

    Invoke-Step 'Push version commit' {
        git push
    }
}

if ($Target -eq 'pack') {
    Invoke-Step 'Build unpacked desktop app' { npm run desktop:pack }
} else {
    Invoke-Step 'Build Windows installer' { npm run desktop:dist:win }
}

if ($Release) {
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

    Invoke-Step "Tag current commit as $Tag" {
        git fetch --tags origin
        $Head = (git rev-parse HEAD).Trim()
        $ExistingTag = (git rev-parse -q --verify "refs/tags/$Tag")
        if ($ExistingTag) {
            $ExistingTag = $ExistingTag.Trim()
            if ($ExistingTag -ne $Head) {
                throw "Tag $Tag already exists at $ExistingTag, not current HEAD $Head. Use a new version or move the tag manually."
            }
            Write-Host "[CC Bridge] tag $Tag already points to current HEAD"
        } else {
            git tag $Tag
        }
    }

    Invoke-Step "Push tag $Tag" {
        git push origin $Tag
    }

    Invoke-Step "Create or update GitHub release $Tag" {
        $PreviousErrorActionPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            gh release view $Tag *> $null
            $ReleaseExists = $LASTEXITCODE -eq 0
        } finally {
            $ErrorActionPreference = $PreviousErrorActionPreference
        }

        if ($ReleaseExists) {
            gh release upload $Tag @Assets --clobber
        } else {
            gh release create $Tag @Assets --title "CC Bridge $Version" --notes "CC Bridge desktop release $Version"
        }
    }
}

Write-Host "[CC Bridge] Done. Output: $RepoRoot\release"
