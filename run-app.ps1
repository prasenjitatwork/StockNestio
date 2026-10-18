$ErrorActionPreference = "Stop"
$root = [IO.Path]::GetFullPath($PSScriptRoot)
$clientConfigPath = Join-Path $root "google-config.js"
$clientConfig = [IO.File]::ReadAllText($clientConfigPath)
if ($clientConfig -notmatch 'googleClientId:\s*"([^"]+)"') {
    throw "Set the Google OAuth client ID in google-config.js before starting the app."
}
$clientId = $Matches[1]
$secretPath = Join-Path $env:LOCALAPPDATA "AaravisYumBox\google-client-secret.dpapi"
if (-not [IO.File]::Exists($secretPath)) {
    throw "Run powershell -ExecutionPolicy Bypass -File .\configure-google.ps1 and enter your Google OAuth client secret at its secure prompt."
}
$protectedSecret = [IO.File]::ReadAllText($secretPath)
$secureSecret = ConvertTo-SecureString $protectedSecret
$secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSecret)
try {
    $clientSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer)
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$listener = [Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:8765/")
$sessions = @{}
$pendingAuthStates = @{}
$redirectUri = "http://localhost:8765/oauth/callback"
$sessionDuration = [TimeSpan]::FromHours(24)
$contentTypes = @{
    ".html" = "text/html; charset=utf-8"
    ".js" = "text/javascript; charset=utf-8"
    ".css" = "text/css; charset=utf-8"
    ".svg" = "image/svg+xml"
    ".ico" = "image/x-icon"
    ".png" = "image/png"
}

function Send-Json($Response, [int]$StatusCode, $Value) {
    $Response.StatusCode = $StatusCode
    $Response.ContentType = "application/json; charset=utf-8"
    $Response.Headers["Cache-Control"] = "no-store"
    $bytes = [Text.Encoding]::UTF8.GetBytes(($Value | ConvertTo-Json -Depth 30 -Compress))
    $Response.ContentLength64 = $bytes.Length
    $Response.OutputStream.Write($bytes, 0, $bytes.Length)
}

function Send-Text($Response, [int]$StatusCode, [string]$Content, [string]$ContentType = "text/plain; charset=utf-8") {
    $Response.StatusCode = $StatusCode
    $Response.ContentType = $ContentType
    $Response.Headers["Cache-Control"] = "no-store"
    $bytes = [Text.Encoding]::UTF8.GetBytes($Content)
    $Response.ContentLength64 = $bytes.Length
    $Response.OutputStream.Write($bytes, 0, $bytes.Length)
}

function Set-SessionCookie($Response, [string]$SessionId, [int]$MaxAge) {
    $Response.AppendHeader("Set-Cookie", "yum_box_session=$SessionId; Path=/; HttpOnly; SameSite=Lax; Max-Age=$MaxAge")
}

function Get-Session($Request) {
    $cookie = $Request.Cookies["yum_box_session"]
    if (-not $cookie) { return $null }
    $session = $sessions[$cookie.Value]
    if (-not $session) { return $null }
    if ([DateTimeOffset]::UtcNow -ge $session.ExpiresAt) {
        $sessions.Remove($cookie.Value) | Out-Null
        return $null
    }
    return $session
}

function Get-SessionId($Request) {
    $cookie = $Request.Cookies["yum_box_session"]
    if ($cookie) { return $cookie.Value }
    return ""
}

function Test-SameOrigin($Request) {
    $origin = $Request.Headers["Origin"]
    return (-not $origin -or $origin -eq "http://localhost:8765") -and $Request.Headers["Host"] -eq "localhost:8765"
}

function Update-AccessToken($Session) {
    if ($Session.AccessToken -and $Session.AccessExpiresAt -gt [DateTimeOffset]::UtcNow.AddMinutes(1)) {
        return
    }
    if (-not $Session.RefreshToken) {
        throw "Google did not provide a refresh token. Log out and sign in again to renew the one-day session."
    }
    $form = @{
        client_id = $clientId
        client_secret = $clientSecret
        refresh_token = $Session.RefreshToken
        grant_type = "refresh_token"
    }
    $token = Invoke-RestMethod -Uri "https://oauth2.googleapis.com/token" -Method Post -ContentType "application/x-www-form-urlencoded" -Body $form
    $Session.AccessToken = $token.access_token
    $Session.AccessExpiresAt = [DateTimeOffset]::UtcNow.AddSeconds([Math]::Max(60, [int]$token.expires_in))
}

function Get-RequestBody($Request) {
    $reader = [IO.StreamReader]::new($Request.InputStream, $Request.ContentEncoding)
    try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}

function Get-UpstreamError($ErrorRecord) {
    $response = $ErrorRecord.Exception.Response
    if (-not $response) {
        return @{ status = 502; body = @{ error = @{ message = $ErrorRecord.Exception.Message } } }
    }
    $status = [int]$response.StatusCode
    try {
        $reader = [IO.StreamReader]::new($response.GetResponseStream())
        try { $body = $reader.ReadToEnd() } finally { $reader.Dispose() }
    } catch {
        $body = @{ error = @{ message = $ErrorRecord.Exception.Message } } | ConvertTo-Json -Compress
    }
    if (-not $body) { $body = @{ error = @{ message = $ErrorRecord.Exception.Message } } | ConvertTo-Json -Compress }
    return @{ status = $status; body = $body }
}

try {
    $listener.Start()
    Write-Host "StockNestio is running at http://localhost:8765/"
    Write-Host "Google refresh tokens stay in this server process, never in the browser."
    Write-Host "Keep this PowerShell window open while using the app. Press Ctrl+C to stop."

    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response
        try {
            $path = $request.Url.AbsolutePath

            if ($path -eq "/api/auth/login" -and $request.HttpMethod -eq "GET") {
                $state = [Guid]::NewGuid().ToString("N")
                $pendingAuthStates[$state] = [DateTimeOffset]::UtcNow.AddMinutes(10)
                foreach ($expiredState in @($pendingAuthStates.Keys)) {
                    if ($pendingAuthStates[$expiredState] -lt [DateTimeOffset]::UtcNow) {
                        $pendingAuthStates.Remove($expiredState)
                    }
                }
                $parameters = @{
                    client_id = $clientId
                    redirect_uri = $redirectUri
                    response_type = "code"
                    scope = "https://www.googleapis.com/auth/spreadsheets openid email profile"
                    access_type = "offline"
                    prompt = "consent select_account"
                    include_granted_scopes = "true"
                    state = $state
                }
                $query = ($parameters.GetEnumerator() | ForEach-Object {
                    [Uri]::EscapeDataString([string]$_.Key) + "=" + [Uri]::EscapeDataString([string]$_.Value)
                }) -join "&"
                $response.Redirect("https://accounts.google.com/o/oauth2/v2/auth?$query")
            } elseif ($path -eq "/oauth/callback" -and $request.HttpMethod -eq "GET") {
                $state = $request.QueryString["state"]
                if (-not $state -or -not $pendingAuthStates.ContainsKey($state) -or $pendingAuthStates[$state] -lt [DateTimeOffset]::UtcNow) {
                    throw "Google sign-in expired or its state could not be verified. Start sign-in again."
                }
                $pendingAuthStates.Remove($state) | Out-Null
                if ($request.QueryString["error"]) {
                    throw "Google sign-in failed: $($request.QueryString['error']). $($request.QueryString['error_description'])"
                }
                $tokenForm = @{
                    code = $request.QueryString["code"]
                    client_id = $clientId
                    client_secret = $clientSecret
                    redirect_uri = $redirectUri
                    grant_type = "authorization_code"
                }
                $token = Invoke-RestMethod -Uri "https://oauth2.googleapis.com/token" -Method Post -ContentType "application/x-www-form-urlencoded" -Body $tokenForm
                if (-not $token.refresh_token) {
                    throw "Google did not issue a refresh token. In Google Account settings, remove this app's access, then sign in again."
                }
                $profile = Invoke-RestMethod -Uri "https://openidconnect.googleapis.com/v1/userinfo" -Headers @{ Authorization = "Bearer $($token.access_token)" }
                $sessionId = [Guid]::NewGuid().ToString("N")
                $sessions[$sessionId] = @{
                    AccessToken = $token.access_token
                    AccessExpiresAt = [DateTimeOffset]::UtcNow.AddSeconds([Math]::Max(60, [int]$token.expires_in))
                    RefreshToken = $token.refresh_token
                    Email = $profile.email
                    Name = $profile.name
                    Picture = $profile.picture
                    ExpiresAt = [DateTimeOffset]::UtcNow.Add($sessionDuration)
                }
                Set-SessionCookie $response $sessionId ([int]$sessionDuration.TotalSeconds)
                $response.Redirect("/")
            } elseif ($path -eq "/api/auth/session" -and $request.HttpMethod -eq "GET") {
                $session = Get-Session $request
                if ($session) {
                    Send-Json $response 200 @{
                        configured = $true
                        authenticated = $true
                        email = $session.Email
                        name = $session.Name
                        picture = $session.Picture
                        expiresAt = $session.ExpiresAt.ToUnixTimeMilliseconds()
                    }
                } else {
                    Send-Json $response 200 @{ configured = $true; authenticated = $false }
                }
            } elseif ($path -eq "/api/auth/logout" -and $request.HttpMethod -eq "POST") {
                if (-not (Test-SameOrigin $request)) {
                    Send-Json $response 403 @{ error = @{ message = "Logout request origin was rejected." } }
                } else {
                    $sessionId = Get-SessionId $request
                    $session = Get-Session $request
                    if ($session) {
                        try {
                            Invoke-RestMethod -Uri "https://oauth2.googleapis.com/revoke" -Method Post -ContentType "application/x-www-form-urlencoded" -Body @{ token = $session.RefreshToken } | Out-Null
                        } catch {
                            Write-Warning "Google token revocation failed during logout."
                        }
                    }
                    if ($sessionId) { $sessions.Remove($sessionId) | Out-Null }
                    Set-SessionCookie $response "" 0
                    Send-Json $response 200 @{ authenticated = $false }
                }
            } elseif ($path.StartsWith("/api/sheets/") -and $request.HttpMethod -in @("GET", "POST", "PUT", "PATCH", "DELETE")) {
                if ($request.HttpMethod -ne "GET" -and -not (Test-SameOrigin $request)) {
                    Send-Json $response 403 @{ error = @{ message = "Request origin was rejected." } }
                } else {
                    $session = Get-Session $request
                    if (-not $session) {
                        Send-Json $response 401 @{ error = @{ message = "Your one-day Google session expired. Sign in again." } }
                    } else {
                        try {
                            Update-AccessToken $session
                            $upstreamUri = "https://sheets.googleapis.com/" + $request.RawUrl.Substring("/api/sheets/".Length)
                            $invokeParameters = @{
                                Uri = $upstreamUri
                                Method = $request.HttpMethod
                                Headers = @{ Authorization = "Bearer $($session.AccessToken)" }
                                UseBasicParsing = $true
                            }
                            if ($request.HttpMethod -in @("POST", "PUT", "PATCH")) {
                                $invokeParameters.Body = Get-RequestBody $request
                                $invokeParameters.ContentType = $request.ContentType
                            }
                            $upstream = Invoke-WebRequest @invokeParameters
                            Send-Text $response ([int]$upstream.StatusCode) $upstream.Content "application/json; charset=utf-8"
                        } catch {
                            $upstreamError = Get-UpstreamError $_
                            if ($upstreamError.status -eq 401) {
                                $sessionId = Get-SessionId $request
                                if ($sessionId) { $sessions.Remove($sessionId) | Out-Null }
                                Set-SessionCookie $response "" 0
                            }
                            Send-Text $response $upstreamError.status ([string]$upstreamError.body) "application/json; charset=utf-8"
                        }
                    }
                }
            } else {
                $relativePath = [Uri]::UnescapeDataString($path.TrimStart("/"))
                if ([string]::IsNullOrWhiteSpace($relativePath)) { $relativePath = "index.html" }
                $filePath = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $relativePath))
                if (-not $filePath.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
                    $response.StatusCode = 404
                } elseif (-not [IO.File]::Exists($filePath)) {
                    $response.StatusCode = 404
                } else {
                    $extension = [IO.Path]::GetExtension($filePath).ToLowerInvariant()
                    if (-not $contentTypes.ContainsKey($extension)) {
                        $response.StatusCode = 404
                    } else {
                        $bytes = [IO.File]::ReadAllBytes($filePath)
                        $response.ContentType = $contentTypes[$extension]
                        $response.Headers["Cache-Control"] = "no-store"
                        $response.ContentLength64 = $bytes.Length
                        if ($request.HttpMethod -ne "HEAD") { $response.OutputStream.Write($bytes, 0, $bytes.Length) }
                    }
                }
            }
        } catch {
            Write-Warning "Request failed: $($_.Exception.Message)"
            if ($path -eq "/oauth/callback") {
                $errorMessage = [Uri]::EscapeDataString($_.Exception.Message)
                $response.Redirect("/?auth_error=$errorMessage")
            } else {
                Send-Json $response 500 @{ error = @{ message = $_.Exception.Message } }
            }
        } finally {
            $response.Close()
        }
    }
} finally {
    $listener.Close()
    $clientSecret = $null
    $secureSecret.Dispose()
}
