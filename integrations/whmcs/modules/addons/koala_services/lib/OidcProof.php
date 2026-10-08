<?php
declare(strict_types=1);

namespace KoalaServices;

require_once __DIR__ . '/ServiceApi.php';

/** Canonical, unpadded base64url only; do not accept alternate token encodings. */
function proofBase64UrlDecode(string $value, int $maxBytes): string
{
    if ($value === '' || strlen($value) > (int) ceil($maxBytes * 4 / 3)
        || !preg_match('/\A[A-Za-z0-9_-]+\z/D', $value)) {
        throw new ApiError('not-signed-in', 401);
    }
    $decoded = base64_decode(strtr($value, '-_', '+/'), true);
    if ($decoded === false || strlen($decoded) > $maxBytes
        || rtrim(strtr(base64_encode($decoded), '+/', '-_'), '=') !== $value) {
        throw new ApiError('not-signed-in', 401);
    }
    return $decoded;
}

function proofDerLength(int $length): string
{
    if ($length < 128) {
        return chr($length);
    }
    $encoded = '';
    while ($length > 0) {
        $encoded = chr($length & 255) . $encoded;
        $length >>= 8;
    }
    return chr(128 | strlen($encoded)) . $encoded;
}

function proofDerInteger(string $unsigned): string
{
    $unsigned = ltrim($unsigned, "\0");
    if ($unsigned === '') {
        $unsigned = "\0";
    } elseif ((ord($unsigned[0]) & 128) !== 0) {
        $unsigned = "\0" . $unsigned;
    }
    return "\x02" . proofDerLength(strlen($unsigned)) . $unsigned;
}

/** Convert the two public RSA parameters, never a URL or embedded private key, to SPKI. */
function proofRsaPublicKey(array $jwk): \OpenSSLAsymmetricKey
{
    try {
        if (!function_exists('openssl_pkey_get_public') || !is_string($jwk['n'] ?? null)
            || !is_string($jwk['e'] ?? null)) {
            throw new \RuntimeException();
        }
        $modulus = proofBase64UrlDecode($jwk['n'], 1024);
        $exponent = proofBase64UrlDecode($jwk['e'], 8);
        $integers = proofDerInteger($modulus) . proofDerInteger($exponent);
        $rsa = "\x30" . proofDerLength(strlen($integers)) . $integers;
        // rsaEncryption OID 1.2.840.113549.1.1.1 with NULL algorithm parameters.
        $algorithm = "\x30\x0d\x06\x09\x2a\x86\x48\x86\xf7\x0d\x01\x01\x01\x05\x00";
        $bitString = "\x03" . proofDerLength(strlen($rsa) + 1) . "\0" . $rsa;
        $spki = "\x30" . proofDerLength(strlen($algorithm . $bitString)) . $algorithm . $bitString;
        $pem = "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($spki), 64, "\n")
            . "-----END PUBLIC KEY-----\n";
        $key = @openssl_pkey_get_public($pem);
        $details = $key === false ? false : openssl_pkey_get_details($key);
        if ($key === false || !is_array($details) || $details['type'] !== OPENSSL_KEYTYPE_RSA
            || $details['bits'] < 2048 || $details['bits'] > 8192) {
            throw new \RuntimeException();
        }
        return $key;
    } catch (\Throwable) {
        throw new ApiError('configuration-error', 503);
    }
}

/**
 * Verify the short-lived login proof before associating an access token with Koala.
 * JWKS must come from the installation's pinned discovery endpoint, never JWT headers.
 * The caller separately verifies the bearer at userinfo and passes that verified subject.
 */
function verifyIdentityProof(
    string $jwt,
    array $jwks,
    string $issuer,
    string $clientId,
    string $subject,
    int $now
): void {
    if ($issuer === '' || $clientId === '' || $subject === '' || $now < 1) {
        throw new ApiError('configuration-error', 503);
    }
    if (strlen($jwt) > 32768) {
        throw new ApiError('not-signed-in', 401);
    }
    $segments = explode('.', $jwt);
    if (count($segments) !== 3) {
        throw new ApiError('not-signed-in', 401);
    }
    try {
        $header = json_decode(proofBase64UrlDecode($segments[0], 2048), true, 8, JSON_THROW_ON_ERROR);
        $claims = json_decode(proofBase64UrlDecode($segments[1], 16384), true, 16, JSON_THROW_ON_ERROR);
        $signature = proofBase64UrlDecode($segments[2], 1024);
    } catch (\Throwable) {
        throw new ApiError('not-signed-in', 401);
    }
    if (!is_array($header) || array_is_list($header) || ($header['alg'] ?? null) !== 'RS256'
        || isset($header['jku']) || isset($header['x5u']) || isset($header['b64'])
        || (isset($header['crit']) && $header['crit'] !== [])
        || !is_array($claims) || array_is_list($claims)) {
        throw new ApiError('not-signed-in', 401);
    }
    $kid = $header['kid'] ?? null;
    if (array_key_exists('kid', $header) && (!is_string($kid) || $kid === '' || strlen($kid) > 256)) {
        throw new ApiError('not-signed-in', 401);
    }
    $keys = $jwks['keys'] ?? null;
    if (!is_array($keys) || !array_is_list($keys) || count($keys) < 1 || count($keys) > 32) {
        throw new ApiError('configuration-error', 503);
    }
    $matches = [];
    foreach ($keys as $key) {
        if (!is_array($key) || ($key['kty'] ?? null) !== 'RSA'
            || (isset($key['alg']) && $key['alg'] !== 'RS256')
            || (isset($key['use']) && $key['use'] !== 'sig')
            || (isset($key['key_ops']) && (!is_array($key['key_ops'])
                || !in_array('verify', $key['key_ops'], true)))) {
            continue;
        }
        if ($kid === null || (is_string($key['kid'] ?? null) && hash_equals($key['kid'], $kid))) {
            $matches[] = $key;
        }
    }
    if (count($matches) !== 1) {
        // An unknown kid may be an old login proof; ambiguity must never select the first key.
        throw new ApiError('not-signed-in', 401);
    }
    $key = proofRsaPublicKey($matches[0]);
    if (@openssl_verify($segments[0] . '.' . $segments[1], $signature, $key, OPENSSL_ALGO_SHA256) !== 1) {
        throw new ApiError('not-signed-in', 401);
    }
    if (!is_string($claims['iss'] ?? null) || !hash_equals($issuer, $claims['iss'])
        || !is_string($claims['sub'] ?? null) || !hash_equals($subject, $claims['sub'])) {
        throw new ApiError('not-signed-in', 401);
    }
    $audience = $claims['aud'] ?? null;
    $audiences = is_string($audience) ? [$audience] : $audience;
    if (!is_array($audiences) || !array_is_list($audiences) || !$audiences
        || count($audiences) > 32 || !in_array($clientId, $audiences, true)) {
        throw new ApiError('not-signed-in', 401);
    }
    foreach ($audiences as $aud) {
        if (!is_string($aud) || $aud === '') {
            throw new ApiError('not-signed-in', 401);
        }
    }
    if ((count($audiences) > 1 && !isset($claims['azp']))
        || (array_key_exists('azp', $claims) && (!is_string($claims['azp']) || !hash_equals($clientId, $claims['azp'])))) {
        throw new ApiError('not-signed-in', 401);
    }
    // Sixty seconds covers ordinary clock skew without accepting stale login proofs indefinitely.
    $issued = $claims['iat'] ?? null;
    $expires = $claims['exp'] ?? null;
    $notBefore = $claims['nbf'] ?? null;
    if (!is_int($issued) || !is_int($expires) || $issued < 1 || $expires < 1
        || $issued > $now + 60 || $expires <= $now - 60 || $expires <= $issued
        || (array_key_exists('nbf', $claims) && (!is_int($notBefore) || $notBefore < 1
            || $notBefore > $now + 60 || $notBefore >= $expires))) {
        throw new ApiError('not-signed-in', 401);
    }
}
