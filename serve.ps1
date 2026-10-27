param(
  [int]$Port = 8080,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Split-Path -Parent $MyInvocation.MyCommand.Path)).Path
$listener = $null

try {
  $probe = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/" -TimeoutSec 2
  if ($probe.Content -match 'manifest\.webmanifest') {
    Write-Host ''
    Write-Host "  RiZhang is already running at http://localhost:$Port/" -ForegroundColor Green
    Write-Host '  Use the address from the existing server window.'
    Write-Host ''
    if (-not $NoBrowser) {
      try { Start-Process "http://localhost:$Port/" } catch {}
    }
    exit 0
  }
} catch {}

try {
  $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Any, $Port)
  $listener.Start()
} catch {
  Write-Host ''
  Write-Host "Could not start the local server on port $Port." -ForegroundColor Red
  Write-Host "Close any program using this port, then try again." -ForegroundColor Yellow
  Write-Host ''
  Read-Host 'Press Enter to close'
  exit 1
}

$Host.UI.RawUI.WindowTitle = 'RiZhang - Daily Expense Tracker'
$lanAddresses = @()
try {
  $lanAddresses = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
      $_.IPAddress -notlike '127.*' -and
      $_.IPAddress -notlike '169.254.*' -and
      $_.PrefixOrigin -ne 'WellKnown'
    } |
    Select-Object -ExpandProperty IPAddress -Unique
} catch {
  try {
    $lanAddresses = [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
      Where-Object { $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork } |
      ForEach-Object { $_.IPAddressToString } |
      Where-Object { $_ -notlike '127.*' } |
      Select-Object -Unique
  } catch {}
}

Write-Host ''
Write-Host '  RiZhang is ready.' -ForegroundColor Green
Write-Host "  Computer: http://localhost:$Port/"
if ($lanAddresses.Count -gt 0) {
  foreach ($address in $lanAddresses) {
    Write-Host "  Phone:    http://${address}:$Port/" -ForegroundColor Cyan
  }
} else {
  Write-Host '  Phone:    Connect this computer to Wi-Fi first.' -ForegroundColor Yellow
}
Write-Host '  Phone and computer must be on the same Wi-Fi.'
Write-Host '  Keep this window open. Close it to stop the server.'
Write-Host ''

if (-not $NoBrowser) {
  try { Start-Process "http://localhost:$Port/" } catch {}
}

$mimeTypes = @{
  '.html' = 'text/html; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'
  '.js' = 'text/javascript; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.webmanifest' = 'application/manifest+json; charset=utf-8'
  '.svg' = 'image/svg+xml'
  '.png' = 'image/png'
  '.jpg' = 'image/jpeg'
  '.jpeg' = 'image/jpeg'
  '.ico' = 'image/x-icon'
  '.woff2' = 'font/woff2'
  '.txt' = 'text/plain; charset=utf-8'
}

$securityHeaders = @(
  'X-Content-Type-Options: nosniff',
  'X-Frame-Options: DENY',
  'Referrer-Policy: no-referrer',
  'Permissions-Policy: camera=(), microphone=(), geolocation=()',
  "Content-Security-Policy: default-src 'self' blob: data:; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'"
)

function Send-Response {
  param(
    [System.Net.Sockets.NetworkStream]$Stream,
    [string]$StatusLine,
    [string]$ContentType,
    [byte[]]$Body,
    [bool]$IsHead
  )

  if ($null -eq $Body) { $Body = [byte[]]::new(0) }
  $headerLines = @(
    "HTTP/1.1 $StatusLine",
    "Content-Type: $ContentType",
    "Content-Length: $($Body.Length)",
    'Cache-Control: no-cache',
    'Connection: close'
  ) + $securityHeaders
  $header = ($headerLines -join "`r`n") + "`r`n`r`n"
  $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
  $Stream.Write($headerBytes, 0, $headerBytes.Length)
  if (-not $IsHead -and $Body.Length -gt 0) {
    $Stream.Write($Body, 0, $Body.Length)
  }
  $Stream.Flush()
}

function Send-TextResponse {
  param(
    [System.Net.Sockets.NetworkStream]$Stream,
    [string]$StatusLine,
    [string]$Text,
    [bool]$IsHead
  )
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
  Send-Response -Stream $Stream -StatusLine $StatusLine -ContentType 'text/plain; charset=utf-8' -Body $bytes -IsHead $IsHead
}

try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
      $client.ReceiveTimeout = 3000
      $client.SendTimeout = 5000
      $stream = $client.GetStream()
      $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::ASCII, $false, 2048, $true)
      $requestLine = $reader.ReadLine()
      if ([string]::IsNullOrWhiteSpace($requestLine)) { continue }

      $parts = $requestLine.Split(' ')
      if ($parts.Count -lt 2) {
        Send-TextResponse -Stream $stream -StatusLine '400 Bad Request' -Text 'Bad request' -IsHead $false
        continue
      }

      $method = $parts[0].ToUpperInvariant()
      $target = $parts[1]
      while ($true) {
        $line = $reader.ReadLine()
        if ($null -eq $line -or $line -eq '') { break }
      }

      $isHead = $method -eq 'HEAD'
      if ($method -ne 'GET' -and -not $isHead) {
        Send-TextResponse -Stream $stream -StatusLine '405 Method Not Allowed' -Text 'Method not allowed' -IsHead $false
        continue
      }

      $pathPart = ($target -split '\?', 2)[0]
      try { $pathPart = [System.Uri]::UnescapeDataString($pathPart) } catch {}
      if ([string]::IsNullOrWhiteSpace($pathPart) -or $pathPart -eq '/') { $pathPart = '/index.html' }

      $relative = $pathPart.TrimStart('/').Replace('/', [System.IO.Path]::DirectorySeparatorChar)
      $filePath = [System.IO.Path]::GetFullPath((Join-Path $root $relative))
      $rootPrefix = $root + [System.IO.Path]::DirectorySeparatorChar
      if (-not $filePath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        Send-TextResponse -Stream $stream -StatusLine '403 Forbidden' -Text 'Forbidden' -IsHead $isHead
        continue
      }

      if (Test-Path -LiteralPath $filePath -PathType Container) {
        $filePath = Join-Path $filePath 'index.html'
      }
      if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
        Send-TextResponse -Stream $stream -StatusLine '404 Not Found' -Text 'Not found' -IsHead $isHead
        continue
      }

      $extension = [System.IO.Path]::GetExtension($filePath).ToLowerInvariant()
      $contentType = $mimeTypes[$extension]
      if (-not $contentType) {
        Send-TextResponse -Stream $stream -StatusLine '404 Not Found' -Text 'Not found' -IsHead $isHead
        continue
      }
      $bytes = [System.IO.File]::ReadAllBytes($filePath)
      Send-Response -Stream $stream -StatusLine '200 OK' -ContentType $contentType -Body $bytes -IsHead $isHead

      $time = Get-Date -Format 'HH:mm:ss'
      Write-Host "[$time] $method $pathPart" -ForegroundColor DarkGray
    } catch {
      $innerError = $_.Exception
      while ($innerError.InnerException) { $innerError = $innerError.InnerException }
      if (-not ($innerError -is [System.IO.IOException] -or $innerError -is [System.Net.Sockets.SocketException])) {
        Write-Host "Request failed: $($innerError.GetType().Name)" -ForegroundColor DarkYellow
      }
    } finally {
      try { $client.Close() } catch {}
    }
  }
} finally {
  try { $listener.Stop() } catch {}
}
