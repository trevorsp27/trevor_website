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

$manifest = [ordered]@{}
$extensions = @("*.jpg", "*.jpeg", "*.png", "*.webp", "*.gif", "*.avif")

foreach ($family in $families) {
  $familyPath = Join-Path $photosRoot $family.slug
  New-Item -Path $familyPath -ItemType Directory -Force | Out-Null

  foreach ($species in $family.species) {
    $speciesPath = Join-Path $familyPath $species.slug
    New-Item -Path $speciesPath -ItemType Directory -Force | Out-Null

    $gitkeepPath = Join-Path $speciesPath ".gitkeep"
    if (-not (Test-Path $gitkeepPath)) {
      New-Item -Path $gitkeepPath -ItemType File | Out-Null
    }

    $photoFiles = Get-ChildItem -Path $speciesPath -File -Include $extensions | Sort-Object Name
    $photoNames = @($photoFiles | ForEach-Object { $_.Name })

    if ($photoNames.Count -gt 0) {
      $manifest[$species.id] = $photoNames
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
([ordered]@{ speciesPhotos = $manifest }) | ConvertTo-Json -Depth 5 | Set-Content -Path $manifestPath -Encoding utf8

Write-Host "Bird catalog synced. Families:" $families.Count
Write-Host "Photo manifest entries:" $manifest.Count
