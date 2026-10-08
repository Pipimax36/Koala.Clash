<?php
declare(strict_types=1);

use KoalaServices\ApiError;

ini_set('display_errors', '0');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, private');
header('Pragma: no-cache');
header('X-Content-Type-Options: nosniff');

require_once __DIR__ . '/lib/ServiceApi.php';
$requestId = bin2hex(random_bytes(8));
header('X-Koala-Services-Version: ' . KoalaServices\ADDON_VERSION);
header('X-Koala-Request-Id: ' . $requestId);

try {
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
        header('Allow: POST');
        throw new ApiError('invalid-response', 405);
    }
    if (strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0])) !== 'application/json') {
        throw new ApiError('invalid-response', 415);
    }
    $authorization = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
    if (!preg_match('/\ABearer [\x21-\x7e]{1,8192}\z/D', $authorization)) {
        throw new ApiError('not-signed-in', 401);
    }
    $body = file_get_contents('php://input', false, null, 0, 32769);
    if ($body === false || strlen($body) > 32768) {
        throw new ApiError('invalid-response', 413);
    }
    try {
        $request = json_decode($body, true, 8, JSON_THROW_ON_ERROR);
    } catch (Throwable) {
        throw new ApiError('invalid-response', 400);
    }
    if (!is_array($request) || array_is_list($request)) {
        throw new ApiError('invalid-response', 400);
    }
    // Keep the proof out of custom headers: standard access logs often record those verbatim.
    $identityToken = $request['identityToken'] ?? '';
    if (!is_string($identityToken) || strlen($identityToken) > 16384) {
        throw new ApiError('not-signed-in', 401);
    }
    unset($request['identityToken']);
    // Use the installation's own bootstrap and database; no admin API credential is needed.
    ob_start();
    require_once dirname(__DIR__, 3) . '/init.php';
    ob_end_clean();
    if (session_status() === PHP_SESSION_ACTIVE) {
        session_write_close();
    }
    require_once __DIR__ . '/lib/WhmcsAdapter.php';
    // WHMCS bootstrap may replace response headers. Restore the API's JSON/no-cache contract.
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store, private');
    header('Pragma: no-cache');
    $result = KoalaServices\api(KoalaServices\configuredSettings(), $identityToken)->handle($request, $authorization);
    echo json_encode($result, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
} catch (Throwable $error) {
    // Never send PHP diagnostics, provider bodies, tokens or subscription URLs in an error.
    while (ob_get_level() > 0) {
        ob_end_clean();
    }
    $status = $error instanceof ApiError ? $error->status : 503;
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store, private');
    header('Pragma: no-cache');
    http_response_code($status);
    if ($status === 401) {
        header('WWW-Authenticate: Bearer');
    }
    $payload = ['error' => $error instanceof ApiError ? $error->reason : 'configuration-error'];
    if ($error instanceof ApiError && isset(KoalaServices\DIAGNOSTIC_MESSAGES[$error->diagnostic ?? ''])) {
        KoalaServices\recordDiagnostic($error, $requestId);
        $payload['diagnostic'] = $error->diagnostic;
        $payload['requestId'] = $requestId;
    }
    echo json_encode($payload);
}
