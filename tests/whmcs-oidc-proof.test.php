<?php
declare(strict_types=1);

require_once __DIR__ . '/../integrations/whmcs/modules/addons/koala_services/lib/OidcProof.php';

use KoalaServices\ApiError;
use function KoalaServices\verifyIdentityProof;

function encodeProofPart(string $data): string
{
    return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
}

$privateKey = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
if ($privateKey === false) {
    throw new RuntimeException('OpenSSL could not create a fixture key');
}
$keyDetails = openssl_pkey_get_details($privateKey);
$jwk = ['kty' => 'RSA', 'use' => 'sig', 'alg' => 'RS256', 'kid' => 'test-key',
    'n' => encodeProofPart($keyDetails['rsa']['n']), 'e' => encodeProofPart($keyDetails['rsa']['e'])];
$jwks = ['keys' => [$jwk]];
$now = 1800000000;
$issuer = 'https://whmcs.example.com';
$clientId = 'KOALA.example';
$subject = '92920eca-f9c3-4e05-adf3-6413e18b70b7';
$claims = ['iss' => $issuer, 'aud' => $clientId, 'sub' => $subject, 'iat' => $now - 5, 'exp' => $now + 95];
$sign = static function (array $payload, array $header = ['alg' => 'RS256', 'kid' => 'test-key']) use ($privateKey): string {
    $input = encodeProofPart(json_encode($header, JSON_THROW_ON_ERROR)) . '.'
        . encodeProofPart(json_encode($payload, JSON_THROW_ON_ERROR));
    if (!openssl_sign($input, $signature, $privateKey, OPENSSL_ALGO_SHA256)) {
        throw new RuntimeException('Cannot sign fixture');
    }
    return $input . '.' . encodeProofPart($signature);
};
$verify = static function (string $token, ?array $keys = null) use ($jwks, $issuer, $clientId, $subject, $now): void {
    verifyIdentityProof($token, $keys ?? $jwks, $issuer, $clientId, $subject, $now);
};
$count = 0;
$test = static function (string $name, Closure $run, ?string $error = null) use (&$count): void {
    try {
        $run();
        if ($error !== null) {
            throw new RuntimeException('Expected controlled rejection: ' . $error);
        }
    } catch (ApiError $actual) {
        if ($error !== $actual->reason || $actual->status !== ($error === 'configuration-error' ? 503 : 401)) {
            throw new RuntimeException($name . ': unexpected controlled error');
        }
    }
    ++$count;
    echo 'ok ' . $count . ' - ' . $name . PHP_EOL;
};

$test('valid signed Koala proof', fn () => $verify($sign($claims)));
$test('single public key supports provider without kid', fn () => $verify($sign($claims, ['alg' => 'RS256'])));
$test('multi audience explicitly designates Koala', fn () => $verify($sign(array_replace($claims, [
    'aud' => [$clientId, 'other'], 'azp' => $clientId,
]))));
$test('valid nbf with clock skew', fn () => $verify($sign(array_replace($claims, ['nbf' => $now + 30]))));
foreach ([
    'wrong issuer' => ['iss' => $issuer . '/'],
    'wrong subject' => ['sub' => 'someone-else'],
    'other application audience' => ['aud' => 'OTHER-APP'],
    'audience substring rejected' => ['aud' => $clientId . '.attacker'],
    'mixed audience types' => ['aud' => [$clientId, 10], 'azp' => $clientId],
    'multi audience needs authorized party' => ['aud' => [$clientId, 'other']],
    'single audience with wrong authorized party' => ['azp' => 'other'],
    'null authorized party rejected' => ['azp' => null],
    'multiple audiences with wrong authorized party' => ['aud' => [$clientId, 'other'], 'azp' => 'other'],
    'expired proof' => ['iat' => $now - 200, 'exp' => $now - 61],
    'issued in the future' => ['iat' => $now + 61, 'exp' => $now + 1000],
    'not yet valid' => ['nbf' => $now + 61],
    'null not before rejected' => ['nbf' => null],
    'expiration must follow issuance' => ['exp' => $now - 5],
    'numeric string time rejected' => ['iat' => (string) ($now - 5)],
    'fractional expiration rejected' => ['exp' => $now + 95.5],
] as $name => $override) {
    $test($name, fn () => $verify($sign(array_replace($claims, $override))), 'not-signed-in');
}
foreach ([
    'unsigned algorithm forbidden' => ['alg' => 'none'],
    'HMAC confusion forbidden' => ['alg' => 'HS256', 'kid' => 'test-key'],
    'unknown key id rejected' => ['alg' => 'RS256', 'kid' => 'attacker-key'],
    'token cannot choose JWKS URL' => ['alg' => 'RS256', 'jku' => 'https://attacker.example/jwks'],
    'token cannot choose certificate URL' => ['alg' => 'RS256', 'x5u' => 'https://attacker.example/cert'],
    'unsupported critical header rejected' => ['alg' => 'RS256', 'crit' => ['custom']],
    'unencoded payload forbidden' => ['alg' => 'RS256', 'b64' => false],
] as $name => $header) {
    $test($name, fn () => $verify($sign($claims, $header)), 'not-signed-in');
}
$token = $sign($claims);
$parts = explode('.', $token);
$parts[1] = encodeProofPart(json_encode(array_replace($claims, ['sub' => 'someone-else']), JSON_THROW_ON_ERROR));
$test('tampered payload rejected', fn () => $verify(implode('.', $parts)), 'not-signed-in');
$parts = explode('.', $token);
$signature = base64_decode(strtr($parts[2], '-_', '+/'), true);
$signature[0] = chr(ord($signature[0]) ^ 1);
$parts[2] = encodeProofPart($signature);
$test('tampered signature rejected', fn () => $verify(implode('.', $parts)), 'not-signed-in');
$test('padded base64 encoding rejected', fn () => $verify($token . '='), 'not-signed-in');
$test('non JWT input rejected', fn () => $verify('not-a-token'), 'not-signed-in');
$test('oversized JWT rejected', fn () => $verify(str_repeat('a', 32769)), 'not-signed-in');
$test('ambiguous key id rejected', fn () => $verify($token, ['keys' => [$jwk, $jwk]]), 'not-signed-in');
$test('empty key set is a configuration error', fn () => $verify($token, ['keys' => []]), 'configuration-error');
$test('malformed RSA public parameters rejected', fn () => $verify($token, [
    'keys' => [array_replace($jwk, ['n' => 'invalid-modulus'])],
]), 'configuration-error');
$test('encryption key cannot verify signing token', fn () => $verify($token, [
    'keys' => [array_replace($jwk, ['use' => 'enc'])],
]), 'not-signed-in');
$test('key operations must permit signature verification', fn () => $verify($token, [
    'keys' => [array_replace($jwk, ['key_ops' => ['encrypt']])],
]), 'not-signed-in');
$test('too many provider keys rejected', fn () => $verify($token, ['keys' => array_fill(0, 33, $jwk)]), 'configuration-error');
echo 'Passed ' . $count . ' OIDC proof tests.' . PHP_EOL;
