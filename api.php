<?php
declare(strict_types=1);

const SESSION_LIFETIME = 86400;
const MAX_REQUEST_BYTES = 1048576;

function respond_json(int $status, array $body)
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function finish_oauth_popup(string $baseUrl, ?string $error = null)
{
    $origin = json_encode($baseUrl, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT);
    $message = json_encode($error, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT);
    $fallback = json_encode(
        $baseUrl . ($error !== null ? '/?auth_error=' . rawurlencode($error) : '/'),
        JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT
    );
    header('Cache-Control: no-store');
    header('Content-Type: text/html; charset=utf-8');
    echo '<!doctype html><meta charset="utf-8"><title>Google sign-in</title><p>Sign-in complete. You may close this window.</p><script>'
        . 'const appOrigin=' . $origin . ';'
        . 'if(window.opener&&!window.opener.closed){window.opener.postMessage({type:"stocknest-oauth",error:' . $message . '},appOrigin);window.close();}'
        . 'else{window.location.replace(' . $fallback . ');}'
        . '</script>';
    exit;
}

function redirect_with_error(string $message, string $baseUrl, bool $popup = false)
{
    if ($popup && $baseUrl !== '') {
        finish_oauth_popup($baseUrl, $message);
    }
    header('Cache-Control: no-store');
    header('Location: ' . $baseUrl . '/?auth_error=' . rawurlencode($message), true, 302);
    exit;
}

function load_app_config(): ?array
{
    $path = __DIR__ . '/App_Data/google-oauth.php';
    if (!is_file($path)) {
        return null;
    }

    $config = require $path;
    if (!is_array($config)
        || !isset($config['client_secret'], $config['app_base_url'])
        || !is_string($config['client_secret'])
        || trim($config['client_secret']) === ''
        || strpos($config['client_secret'], 'PASTE_YOUR_') !== false
        || !is_string($config['app_base_url'])) {
        throw new RuntimeException('App_Data/google-oauth.php must return the configured client_secret and app_base_url values.');
    }

    $baseUrl = rtrim($config['app_base_url'], '/');
    $baseUrlParts = parse_url($baseUrl);
    if (!filter_var($baseUrl, FILTER_VALIDATE_URL)
        || $baseUrlParts === false
        || ($baseUrlParts['scheme'] ?? '') !== 'https'
        || empty($baseUrlParts['host'])
        || isset($baseUrlParts['path'])
        || isset($baseUrlParts['query'])
        || isset($baseUrlParts['fragment'])
        || isset($baseUrlParts['user'])
        || isset($baseUrlParts['pass'])) {
        throw new RuntimeException('Set app_base_url to this site’s HTTPS origin, for example https://example.com.');
    }

    $clientConfigPath = __DIR__ . '/google-config.js';
    $clientConfig = is_file($clientConfigPath) ? file_get_contents($clientConfigPath) : false;
    if ($clientConfig === false
        || !preg_match('/googleClientId:\s*"([^"]+)"/', $clientConfig, $match)) {
        throw new RuntimeException('Set the Google OAuth client ID in google-config.js.');
    }

    return [
        'client_id' => $match[1],
        'client_secret' => $config['client_secret'],
        'base_url' => $baseUrl,
        'redirect_uri' => $baseUrl . '/oauth-callback.php',
    ];
}

function start_app_session(): void
{
    $sessionDirectory = __DIR__ . '/App_Data/yum-box-sessions';
    if (!is_dir($sessionDirectory)
        && !mkdir($sessionDirectory, 0700, true)
        && !is_dir($sessionDirectory)) {
        throw new RuntimeException('PHP cannot create App_Data/yum-box-sessions. Grant the site’s PHP process write access to App_Data.');
    }
    if (!is_writable($sessionDirectory)) {
        throw new RuntimeException('PHP cannot write to App_Data/yum-box-sessions. Grant the site’s PHP process write access to App_Data.');
    }

    ini_set('session.save_path', $sessionDirectory);
    ini_set('session.gc_maxlifetime', (string) SESSION_LIFETIME);
    ini_set('session.use_strict_mode', '1');
    ini_set('session.use_only_cookies', '1');
    ini_set('session.use_trans_sid', '0');
    session_name('yum_box_session');
    session_set_cookie_params([
        'lifetime' => SESSION_LIFETIME,
        'path' => '/',
        'secure' => true,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    if (!session_start()) {
        throw new RuntimeException('PHP could not start the sign-in session.');
    }
}

function request_json(string $url, string $method = 'GET', ?string $body = null, array $headers = []): array
{
    if (!function_exists('curl_init')) {
        throw new RuntimeException('Enable the PHP cURL extension for Google sign-in and Sheets access.');
    }

    $handle = curl_init($url);
    if ($handle === false) {
        throw new RuntimeException('Could not initialize the HTTPS request to Google.');
    }

    $options = [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => 30,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_HTTPHEADER => $headers,
    ];
    if ($body !== null) {
        $options[CURLOPT_POSTFIELDS] = $body;
    }
    if (!curl_setopt_array($handle, $options)) {
        curl_close($handle);
        throw new RuntimeException('Could not configure the HTTPS request to Google.');
    }

    $responseBody = curl_exec($handle);
    $curlError = curl_error($handle);
    $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
    curl_close($handle);

    if ($responseBody === false) {
        throw new RuntimeException('Google HTTPS request failed: ' . ($curlError ?: 'unknown cURL error'));
    }
    if (trim($responseBody) === '') {
        return ['status' => $status, 'body' => []];
    }

    $decoded = json_decode($responseBody, true);
    if (!is_array($decoded)) {
        throw new RuntimeException('Google returned a response that was not valid JSON.');
    }

    return ['status' => $status, 'body' => $decoded];
}

function post_google_form(string $url, array $fields): array
{
    return request_json(
        $url,
        'POST',
        http_build_query($fields, '', '&', PHP_QUERY_RFC3986),
        ['Content-Type: application/x-www-form-urlencoded']
    );
}

function require_same_origin(string $baseUrl): void
{
    if (($_SERVER['HTTP_ORIGIN'] ?? '') !== $baseUrl) {
        respond_json(403, ['error' => ['message' => 'Request origin was rejected.']]);
    }
}

function clear_session_cookie(): void
{
    setcookie(session_name(), '', [
        'expires' => time() - 3600,
        'path' => '/',
        'secure' => true,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

try {
    $route = $_GET['route'] ?? '';
    if (!is_string($route)) {
        respond_json(400, ['error' => ['message' => 'Invalid API route.']]);
    }

    $config = load_app_config();
    if ($route === 'auth/session' && $_SERVER['REQUEST_METHOD'] === 'GET' && $config === null) {
        respond_json(200, ['configured' => false, 'authenticated' => false]);
    }
    if ($config === null) {
        if ($route === 'auth/login') {
            redirect_with_error('Google sign-in is not configured. Add App_Data/google-oauth.php using the setup instructions in README.md.', '');
        }
        respond_json(503, ['error' => ['message' => 'Google sign-in is not configured. Add App_Data/google-oauth.php using the setup instructions in README.md.']]);
    }

    start_app_session();

    if ($route === 'auth/login' && $_SERVER['REQUEST_METHOD'] === 'GET') {
        if (!function_exists('curl_init')) {
            redirect_with_error('Enable the PHP cURL extension for Google sign-in and Sheets access.', $config['base_url']);
        }
        $state = bin2hex(random_bytes(32));
        $_SESSION['oauth_state'] = $state;
        $_SESSION['oauth_state_created_at'] = time();
        $_SESSION['oauth_popup'] = ($_GET['popup'] ?? '') === '1';
        $authorizationUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' . http_build_query([
            'client_id' => $config['client_id'],
            'redirect_uri' => $config['redirect_uri'],
            'response_type' => 'code',
            'scope' => 'https://www.googleapis.com/auth/spreadsheets openid email profile',
            'access_type' => 'offline',
            'prompt' => 'consent select_account',
            'include_granted_scopes' => 'true',
            'state' => $state,
        ], '', '&', PHP_QUERY_RFC3986);
        header('Cache-Control: no-store');
        header('Location: ' . $authorizationUrl, true, 302);
        exit;
    }

    if ($route === 'oauth/callback' && $_SERVER['REQUEST_METHOD'] === 'GET') {
        $popup = !empty($_SESSION['oauth_popup']);
        unset($_SESSION['oauth_popup']);
        if (isset($_GET['error'])) {
            redirect_with_error('Google sign-in failed: ' . (string) $_GET['error'], $config['base_url'], $popup);
        }

        $providedState = $_GET['state'] ?? '';
        $savedState = $_SESSION['oauth_state'] ?? '';
        $stateCreatedAt = (int) ($_SESSION['oauth_state_created_at'] ?? 0);
        unset($_SESSION['oauth_state'], $_SESSION['oauth_state_created_at']);
        if (!is_string($providedState)
            || !is_string($savedState)
            || $savedState === ''
            || !hash_equals($savedState, $providedState)
            || $stateCreatedAt < time() - 600) {
            redirect_with_error('Google sign-in expired or its state could not be verified. Start sign-in again.', $config['base_url'], $popup);
        }

        $code = $_GET['code'] ?? '';
        if (!is_string($code) || $code === '') {
            redirect_with_error('Google did not return an authorization code. Start sign-in again.', $config['base_url'], $popup);
        }
        $tokenResponse = post_google_form('https://oauth2.googleapis.com/token', [
            'code' => $code,
            'client_id' => $config['client_id'],
            'client_secret' => $config['client_secret'],
            'redirect_uri' => $config['redirect_uri'],
            'grant_type' => 'authorization_code',
        ]);
        if ($tokenResponse['status'] < 200 || $tokenResponse['status'] >= 300) {
            $message = $tokenResponse['body']['error_description'] ?? $tokenResponse['body']['error'] ?? 'Google rejected the sign-in request.';
            redirect_with_error('Google sign-in failed: ' . (string) $message, $config['base_url'], $popup);
        }
        $token = $tokenResponse['body'];
        if (empty($token['access_token']) || empty($token['refresh_token'])) {
            redirect_with_error('Google did not issue a refresh token. Remove this app in your Google Account settings, then sign in again.', $config['base_url'], $popup);
        }

        $profileResponse = request_json('https://openidconnect.googleapis.com/v1/userinfo', 'GET', null, [
            'Authorization: Bearer ' . $token['access_token'],
        ]);
        if ($profileResponse['status'] < 200 || $profileResponse['status'] >= 300
            || empty($profileResponse['body']['email'])
            || empty($profileResponse['body']['email_verified'])) {
            redirect_with_error('Google could not verify the signed-in account. Start sign-in again.', $config['base_url'], $popup);
        }

        session_regenerate_id(true);
        $_SESSION['access_token'] = $token['access_token'];
        $_SESSION['access_expires_at'] = time() + (int) ($token['expires_in'] ?? 3600);
        $_SESSION['refresh_token'] = $token['refresh_token'];
        $_SESSION['email'] = $profileResponse['body']['email'];
        $_SESSION['name'] = is_string($profileResponse['body']['name'] ?? null) ? $profileResponse['body']['name'] : '';
        $_SESSION['picture'] = is_string($profileResponse['body']['picture'] ?? null) ? $profileResponse['body']['picture'] : '';
        $_SESSION['expires_at'] = time() + SESSION_LIFETIME;
        if ($popup) {
            finish_oauth_popup($config['base_url']);
        }
        header('Cache-Control: no-store');
        header('Location: ' . $config['base_url'] . '/', true, 302);
        exit;
    }

    if ($route === 'auth/session' && $_SERVER['REQUEST_METHOD'] === 'GET') {
        if (empty($_SESSION['expires_at']) || (int) $_SESSION['expires_at'] <= time()) {
            $_SESSION = [];
            session_destroy();
            clear_session_cookie();
            respond_json(200, ['configured' => true, 'authenticated' => false]);
        }
        respond_json(200, [
            'configured' => true,
            'authenticated' => !empty($_SESSION['refresh_token']),
            'email' => $_SESSION['email'] ?? '',
            'name' => $_SESSION['name'] ?? '',
            'picture' => $_SESSION['picture'] ?? '',
            'expiresAt' => (int) $_SESSION['expires_at'] * 1000,
        ]);
    }

    if ($route === 'auth/logout' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        require_same_origin($config['base_url']);
        $refreshToken = $_SESSION['refresh_token'] ?? '';
        if (is_string($refreshToken) && $refreshToken !== '') {
            try {
                $revocation = post_google_form('https://oauth2.googleapis.com/revoke', ['token' => $refreshToken]);
                if ($revocation['status'] < 200 || $revocation['status'] >= 300) {
                    error_log('Google token revocation returned HTTP ' . $revocation['status'] . '.');
                }
            } catch (Throwable $error) {
                error_log('Google token revocation failed during logout: ' . $error->getMessage());
            }
        }
        $_SESSION = [];
        session_destroy();
        clear_session_cookie();
        respond_json(200, ['authenticated' => false]);
    }

    if (strpos($route, 'sheets/') === 0) {
        $method = $_SERVER['REQUEST_METHOD'] ?? '';
        if (!in_array($method, ['GET', 'POST'], true)) {
            header('Allow: GET, POST');
            respond_json(405, ['error' => ['message' => 'This Sheets request method is not supported.']]);
        }
        if ($method !== 'GET') {
            require_same_origin($config['base_url']);
        }
        if (empty($_SESSION['refresh_token'])
            || empty($_SESSION['expires_at'])
            || (int) $_SESSION['expires_at'] <= time()) {
            respond_json(401, ['error' => ['message' => 'Your one-day Google session expired. Sign in again.']]);
        }

        if (!preg_match('/\Asheets\/v4\/spreadsheets\/([A-Za-z0-9_-]+)(?::batchUpdate|\/values:batch(?:Get|Update))?\z/', $route, $match)) {
            respond_json(404, ['error' => ['message' => 'Unknown Google Sheets API route.']]);
        }
        $spreadsheetRoute = substr($route, strlen('sheets/'));
        $queryParts = [];
        foreach (explode('&', $_SERVER['QUERY_STRING'] ?? '') as $queryPart) {
            if ($queryPart === '') {
                continue;
            }
            $key = explode('=', $queryPart, 2)[0];
            if (rawurldecode($key) !== 'route') {
                $queryParts[] = $queryPart;
            }
        }
        $queryString = implode('&', $queryParts);
        $upstreamUrl = 'https://sheets.googleapis.com/' . $spreadsheetRoute
            . ($queryString !== '' ? '?' . $queryString : '');

        if ((int) ($_SESSION['access_expires_at'] ?? 0) <= time() + 60) {
            $refreshResponse = post_google_form('https://oauth2.googleapis.com/token', [
                'client_id' => $config['client_id'],
                'client_secret' => $config['client_secret'],
                'refresh_token' => $_SESSION['refresh_token'],
                'grant_type' => 'refresh_token',
            ]);
            if ($refreshResponse['status'] < 200 || $refreshResponse['status'] >= 300
                || empty($refreshResponse['body']['access_token'])) {
                $_SESSION = [];
                session_destroy();
                clear_session_cookie();
                respond_json(401, ['error' => ['message' => 'Your Google session could not be renewed. Sign in again.']]);
            }
            $_SESSION['access_token'] = $refreshResponse['body']['access_token'];
            $_SESSION['access_expires_at'] = time() + (int) ($refreshResponse['body']['expires_in'] ?? 3600);
        }

        $body = null;
        $headers = ['Authorization: Bearer ' . $_SESSION['access_token']];
        if ($method === 'POST') {
            $contentLength = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
            if ($contentLength > MAX_REQUEST_BYTES) {
                respond_json(413, ['error' => ['message' => 'The Sheets request is too large.']]);
            }
            $body = file_get_contents('php://input', false, null, 0, MAX_REQUEST_BYTES + 1);
            if ($body === false) {
                respond_json(400, ['error' => ['message' => 'Could not read the Sheets request body.']]);
            }
            if (strlen($body) > MAX_REQUEST_BYTES) {
                respond_json(413, ['error' => ['message' => 'The Sheets request is too large.']]);
            }
            $headers[] = 'Content-Type: application/json';
        }

        $googleResponse = request_json($upstreamUrl, $method, $body, $headers);
        http_response_code($googleResponse['status']);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        echo json_encode($googleResponse['body'], JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
        exit;
    }

    respond_json(404, ['error' => ['message' => 'API route not found.']]);
} catch (Throwable $error) {
    error_log('StockNestio API error: ' . $error->getMessage());
    if (($route ?? '') === 'oauth/callback') {
        if (!empty($_SESSION['oauth_popup']) && isset($config['base_url'])) {
            unset($_SESSION['oauth_popup']);
            finish_oauth_popup($config['base_url'], $error->getMessage());
        }
        redirect_with_error($error->getMessage(), isset($config['base_url']) ? $config['base_url'] : '');
    }
    respond_json(500, ['error' => ['message' => $error->getMessage()]]);
}
