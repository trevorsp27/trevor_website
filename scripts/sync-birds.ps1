$ErrorActionPreference = "Stop"

function To-Slug {
  param([string]$Text)

  $slug = $Text.ToLowerInvariant()
  $slug = [regex]::Replace($slug, "[^a-z0-9]+", "-")
  $slug = $slug.Trim("-")

  if ([string]::IsNullOrWhiteSpace($slug)) {
    return "item"
  }

  return $slug
}

function Clean-Text {
  param([string]$Html)

  $text = [regex]::Replace($Html, "<[^>]+>", "")
  $text = [System.Net.WebUtility]::HtmlDecode($text)
  $text = [regex]::Replace($text, "\s+", " ").Trim()
  return $text
}

function From-Slug {
  param([string]$Slug)

  if ([string]::IsNullOrWhiteSpace($Slug)) {
    return "Unknown"
  }

  $parts = $Slug -split "-"
  $words = $parts | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object {
    if ($_.Length -eq 1) {
      $_.ToUpperInvariant()
    } else {
      $_.Substring(0, 1).ToUpperInvariant() + $_.Substring(1)
    }
  }

  return ($words -join " ")
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$apiUrl = "https://en.wikipedia.org/w/api.php?action=parse&page=List_of_birds_of_Louisiana&prop=text&formatversion=2&format=json&origin=*"
$response = Invoke-RestMethod -Uri $apiUrl -Method Get
$html = $response.parse.text

if ([string]::IsNullOrWhiteSpace($html)) {
  throw "No HTML content returned from Wikipedia API."
}

$stopTitles = @("See also", "Notes", "References", "External links")
$blocks = [regex]::Matches($html, "(?is)<h2[^>]*>.*?</h2>|<ul[^>]*>.*?</ul>")

$families = New-Object System.Collections.Generic.List[object]
$currentFamily = $null

foreach ($blockMatch in $blocks) {
  $block = $blockMatch.Value

  if ($block -match "(?is)^<h2") {
    $headlineMatch = [regex]::Match($block, "(?is)<span[^>]*mw-headline[^>]*>(.*?)</span>")
    if ($headlineMatch.Success) {
      $familyName = Clean-Text -Html $headlineMatch.Groups[1].Value
    } else {
      $familyName = Clean-Text -Html $block
    }

    if ($stopTitles -contains $familyName) {
      $currentFamily = $null
      continue
    }

    $currentFamily = [PSCustomObject]@{
      name = $familyName
      slug = To-Slug -Text $familyName
      species = New-Object System.Collections.Generic.List[object]
    }

    $families.Add($currentFamily)
    continue
  }

  if ($null -eq $currentFamily) {
    continue
  }

  if ($block -notmatch "(?is)^<ul") {
    continue
  }

  $itemMatches = [regex]::Matches($block, "(?is)<li[^>]*>(.*?)</li>")
  foreach ($itemMatch in $itemMatches) {
    $itemHtml = $itemMatch.Groups[1].Value
    $anchorMatch = [regex]::Match($itemHtml, "(?is)<a[^>]*>(.*?)</a>")
    if (-not $anchorMatch.Success) {
      continue
    }

    $birdName = Clean-Text -Html $anchorMatch.Groups[1].Value
    if ([string]::IsNullOrWhiteSpace($birdName)) {
      continue
    }

    $speciesSlug = To-Slug -Text $birdName
    $speciesId = "{0}--{1}" -f $currentFamily.slug, $speciesSlug

    $currentFamily.species.Add([PSCustomObject]@{
      id = $speciesId
      name = $birdName
      slug = $speciesSlug
      familySlug = $currentFamily.slug
    })
  }
}

$families = $families | Where-Object { $_.species.Count -gt 0 }

$photosRoot = Join-Path $repoRoot "assets/birds/photos"
New-Item -Path $photosRoot -ItemType Directory -Force | Out-Null

$knownFamilySlugs = @($families | ForEach-Object { $_.slug })
$existingFamilyDirs = Get-ChildItem -Path $photosRoot -Directory
foreach ($familyDir in $existingFamilyDirs) {
  if ($knownFamilySlugs -contains $familyDir.Name) {
    continue
  }

  $families.Add([PSCustomObject]@{
    name = From-Slug -Slug $familyDir.Name
    slug = $familyDir.Name
    species = New-Object System.Collections.Generic.List[object]
  })
}

$manifest = [ordered]@{}
$notesManifest = [ordered]@{}
$validExtensions = @(".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".heic", ".heif")

foreach ($family in $families) {
  $familyPath = Join-Path $photosRoot $family.slug
  New-Item -Path $familyPath -ItemType Directory -Force | Out-Null

  $knownSpeciesSlugs = @($family.species | ForEach-Object { $_.slug })
  $existingSpeciesDirs = Get-ChildItem -Path $familyPath -Directory
  foreach ($speciesDir in $existingSpeciesDirs) {
    if ($knownSpeciesSlugs -contains $speciesDir.Name) {
      continue
    }

    $family.species.Add([PSCustomObject]@{
      id = ("{0}--{1}" -f $family.slug, $speciesDir.Name)
      name = From-Slug -Slug $speciesDir.Name
      slug = $speciesDir.Name
      familySlug = $family.slug
    })
  }

  foreach ($species in $family.species) {
    $speciesPath = Join-Path $familyPath $species.slug
    New-Item -Path $speciesPath -ItemType Directory -Force | Out-Null

    $gitkeepPath = Join-Path $speciesPath ".gitkeep"
    if (-not (Test-Path $gitkeepPath)) {
      New-Item -Path $gitkeepPath -ItemType File | Out-Null
    }

    $photoFiles = Get-ChildItem -Path $speciesPath -File |
      Where-Object { $validExtensions -contains $_.Extension.ToLowerInvariant() } |
      Sort-Object `
        @{ Expression = {
            $baseName = $_.BaseName.ToLowerInvariant()
            $slugUnderscore = $species.slug.Replace("-", "_").ToLowerInvariant()
            $slugHyphen = $species.slug.ToLowerInvariant()

            if (
              $baseName.StartsWith("main_") -or
              $baseName.StartsWith("main-") -or
              $baseName -eq "main_speciesname" -or
              $baseName -eq ("main_" + $slugUnderscore) -or
              $baseName -eq ("main_" + $slugHyphen) -or
              $baseName -eq ("main-" + $slugHyphen)
            ) {
              return 0
            }

            return 1
          }
        },
        @{ Expression = { $_.Name.ToLowerInvariant() } }
    $photoNames = @($photoFiles | ForEach-Object { $_.Name })

    if ($photoNames.Count -gt 0) {
      $manifest[$species.id] = $photoNames
    }

    $snippetFiles = Get-ChildItem -Path $speciesPath -File -Filter "*.txt" | Sort-Object Name
    if ($snippetFiles.Count -gt 0) {
      $snippetParts = $snippetFiles |
        ForEach-Object {
          $content = (Get-Content -Path $_.FullName -Raw -Encoding UTF8).Trim()
          if (-not [string]::IsNullOrWhiteSpace($content)) {
            $content
          }
        }

      if ($snippetParts.Count -gt 0) {
        $notesManifest[$species.id] = ($snippetParts -join "`r`n`r`n")
      }
    }
  }
}

$catalogOutput = [ordered]@{
  generatedAt = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssK")
  source = "Wikipedia List of birds of Louisiana (localized snapshot)"
  families = $families
}

$catalogPath = Join-Path $repoRoot "assets/birds/birds-catalog.json"
$manifestPath = Join-Path $repoRoot "assets/birds/photo-manifest.json"

$catalogOutput | ConvertTo-Json -Depth 8 | Set-Content -Path $catalogPath -Encoding utf8
([ordered]@{ speciesPhotos = $manifest; speciesNotes = $notesManifest }) | ConvertTo-Json -Depth 5 | Set-Content -Path $manifestPath -Encoding utf8

Write-Host "Bird catalog synced. Families:" $families.Count
Write-Host "Photo manifest entries:" $manifest.Count
