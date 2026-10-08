<?php
declare(strict_types=1);

namespace KoalaServices;

use WHMCS\Database\Capsule;
use WHMCS\User\Client;
use WHMCS\User\User;

require_once __DIR__ . '/ServiceApi.php';
require_once __DIR__ . '/OidcProof.php';

const SETTINGS_TABLE = 'mod_koala_services_settings';
const BINDINGS_TABLE = 'mod_koala_services_bindings';
const DEFAULT_CLIENT_ID = 'COOLGO-NETWORK.e1e6af03fe1090cd698d47a3b3096701';
const DEFAULT_ISSUER = 'https://www.coolgo.network';
// Inactive clients can still log in to WHMCS; individual services must remain Active.
const CLIENT_ACCESS_STATUSES = ['Active', 'Inactive'];

function loadSettings(): array
{
    $row = Capsule::table(SETTINGS_TABLE)->where('id', 1)->first();
    $settings = $row ? json_decode((string) $row->settings, true, 16, JSON_THROW_ON_ERROR) : [];
    return is_array($settings) ? $settings : [];
}

function saveSettings(array $settings): void
{
    Capsule::table(SETTINGS_TABLE)->updateOrInsert(['id' => 1], [
        'settings' => json_encode($settings, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES),
    ]);
}

function configuredSettings(): array
{
    $config = loadSettings();
    if (empty($config['enabled']) || empty($config['product_ids'])
        || empty($config['panel_url']) || empty($config['token_encrypted'])
        || empty($config['oidc_client_id']) || empty($config['oidc_issuer'])
        || !in_array($config['subject_kind'] ?? '', ['client_uuid', 'user_uuid'], true)) {
        throw new ApiError('configuration-error', 503);
    }
    return $config;
}

/** The mapping is an explicit installation setting, never guessed from email or numeric IDs. */
function subjectClientIds(string $subject, string $kind): array
{
    if ($kind === 'client_uuid') {
        $matches = Client::where('uuid', $subject)->limit(2)->get();
        if ($matches->count() === 0) {
            $diagnostic = 'client-uuid-not-found';
            try {
                // Explain a mapping mismatch without guessing an authorization fallback.
                if (Capsule::schema()->hasColumn('tblusers', 'uuid')) {
                    $users = User::where('uuid', $subject)->limit(2)->get();
                    if ($users->count() === 1 && hash_equals((string) $users[0]->uuid, $subject)) {
                        $diagnostic = 'client-uuid-matches-user';
                    }
                }
            } catch (\Throwable) {
                // An optional diagnostic must not change the original access decision.
            }
            throw new ApiError('access-denied', 403, $diagnostic);
        }
        if ($matches->count() !== 1) {
            throw new ApiError('access-denied', 403, 'client-uuid-ambiguous');
        }
        if (!hash_equals((string) $matches[0]->uuid, $subject)) {
            throw new ApiError('access-denied', 403, 'client-uuid-mismatch');
        }
        $status = $matches[0]->status;
        if (!in_array($status, CLIENT_ACCESS_STATUSES, true)) {
            throw new ApiError('access-denied', 403,
                $status === 'Closed' ? 'client-closed' : 'client-status-unknown');
        }
        return [(int) $matches[0]->id];
    }
    if ($kind !== 'user_uuid') {
        throw new ApiError('configuration-error', 503);
    }
    $matches = User::where('uuid', $subject)->limit(2)->get();
    if ($matches->count() === 0) {
        throw new ApiError('access-denied', 403, 'user-uuid-not-found');
    }
    if ($matches->count() !== 1) {
        throw new ApiError('access-denied', 403, 'user-uuid-ambiguous');
    }
    if (!hash_equals((string) $matches[0]->uuid, $subject)) {
        throw new ApiError('access-denied', 403, 'user-uuid-mismatch');
    }
    $user = $matches[0];
    $clients = Client::whereIn('status', CLIENT_ACCESS_STATUSES)
        ->whereHas('users', static function ($query) use ($user): void {
            $query->whereKey($user->id);
        })->limit(101)->get();
    if ($clients->count() > 100) {
        throw new ApiError('access-denied', 403, 'owned-client-limit');
    }
    $ids = [];
    foreach ($clients as $client) {
        // An invitation alone does not confer access to subscription credentials.
        // SQL collations may match differently cased states; enforce the same exact allowlist.
        if (in_array($client->status, CLIENT_ACCESS_STATUSES, true) && $client->isOwnedBy($user)) {
            $ids[] = (int) $client->id;
        }
    }
    return $ids;
}

function authenticate(string $token, array $config, string $identityToken): array
{
    $systemUrl = (string) \WHMCS\Config\Setting::getValue('SystemURL');
    $result = getJson(httpsUrl($systemUrl, true) . '/oauth/userinfo.php', $token);
    if (in_array($result['status'], [400, 401, 403], true)) {
        throw new ApiError('not-signed-in', 401);
    }
    if ($result['status'] !== 200) {
        throw new ApiError('network-error', 502);
    }
    $subject = $result['body']['sub'] ?? null;
    if (!is_string($subject) || !preg_match('/\A[\x21-\x7e]{1,255}\z/D', $subject)) {
        throw new ApiError('not-signed-in', 401);
    }
    verifyClientBinding($token, $identityToken, $subject, $systemUrl, $config);
    return subjectClientIds($subject, $config['subject_kind']);
}

/** Preserve a short-lived ID token's client binding, never bypass live access-token validation. */
function verifyClientBinding(string $token, string $identityToken, string $subject, string $systemUrl, array $config): void
{
    $key = hash('sha256', $config['oidc_issuer'] . "\0" . $config['oidc_client_id'] . "\0" . $token);
    $subjectHash = hash('sha256', $subject);
    $now = time();
    $binding = Capsule::table(BINDINGS_TABLE)->where('token_hash', $key)->first();
    if ($binding && (int) $binding->expires_at > $now && hash_equals((string) $binding->subject_hash, $subjectHash)) {
        return;
    }
    if ($identityToken === '' || strlen($identityToken) > 32768) {
        throw new ApiError('not-signed-in', 401);
    }
    $keys = getJson(httpsUrl($systemUrl, true) . '/oauth/certs.php');
    if ($keys['status'] !== 200) {
        throw new ApiError('network-error', 502);
    }
    verifyIdentityProof($identityToken, $keys['body'], $config['oidc_issuer'], $config['oidc_client_id'], $subject, $now);
    Capsule::table(BINDINGS_TABLE)->where('expires_at', '<=', $now)->delete();
    Capsule::table(BINDINGS_TABLE)->updateOrInsert(['token_hash' => $key], [
        'subject_hash' => $subjectHash,
        'expires_at' => $now + 86400,
    ]);
}

function findServices(array $clients, array $productIds, ?int $id): array
{
    $query = Capsule::table('tblhosting as h')
        ->join('tblproducts as p', 'p.id', '=', 'h.packageid')
        ->join('tblclients as c', 'c.id', '=', 'h.userid')
        ->whereIn('h.userid', $clients)
        ->whereIn('h.packageid', $productIds)
        ->where('h.domainstatus', 'Active')
        ->whereIn('c.status', CLIENT_ACCESS_STATUSES);
    if ($id !== null) {
        $query->where('h.id', $id);
    }
    $rows = $query->select(['h.id', 'h.userid', 'h.domainstatus', 'h.nextduedate', 'p.name', 'c.status'])
        ->orderBy('h.id', 'desc')->limit(501)->get();
    if ($rows->count() > 500) {
        throw new ApiError('invalid-response', 503);
    }
    $result = [];
    foreach ($rows as $row) {
        if (!in_array($row->status, CLIENT_ACCESS_STATUSES, true)) {
            continue;
        }
        $name = trim(preg_replace('/[\x00-\x1f\x7f]/u', ' ', strip_tags((string) $row->name)) ?? '');
        $result[] = [
            'id' => (int) $row->id,
            'clientId' => (int) $row->userid,
            'status' => (string) $row->domainstatus,
            'name' => $name === '' ? 'Service #' . $row->id : mb_substr($name, 0, 256),
            'nextDueDate' => (string) $row->nextduedate,
        ];
    }
    return $result;
}

/** Three aggregate queries scoped to authenticated clients; never search other customers. */
function diagnoseEmptyServices(array $clients, array $productIds): array
{
    $owned = Capsule::table('tblhosting as h')->whereIn('h.userid', $clients);
    $ownedServices = (int) (clone $owned)->count();
    $active = (clone $owned)->where('h.domainstatus', 'Active');
    $activeServices = (int) (clone $active)->count();
    $allowedServices = (int) (clone $active)->whereIn('h.packageid', $productIds)->count();
    // Counts are observations, not an atomic snapshot. Inconsistent or newly eligible rows
    // cannot identify which account/product filter (or concurrent change) caused the empty list.
    $reason = match (true) {
        $activeServices > $ownedServices || $allowedServices > $activeServices => 'account-or-product-filtered',
        $ownedServices === 0 => 'no-owned-services',
        $activeServices === 0 => 'no-active-services',
        $allowedServices === 0 => 'product-not-enabled',
        default => 'account-or-product-filtered',
    };
    return ['version' => 1, 'reason' => $reason, 'clientCount' => count(array_unique($clients)),
        'ownedServices' => $ownedServices, 'activeServices' => $activeServices,
        'allowedServices' => $allowedServices, 'allowedProductIds' => array_values(array_unique($productIds))];
}

/** Read only the authorized service's module-maintained mapping; never infer it from service ID. */
function readRemnawaveMapping(array $service): int
{
    $row = Capsule::table('tblhosting')->where('id', $service['id'])
        ->where('userid', $service['clientId'])->select(['domain'])->first();
    $domain = $row->domain ?? null;
    if ($domain === null || $domain === '') {
        throw new ApiError('configuration-error', 503, 'whmcs-remnawave-mapping-missing');
    }
    if (!is_string($domain) || !preg_match('/\A[1-9][0-9]{0,15}\z/D', $domain)
        || (strlen($domain) === 16 && strcmp($domain, '9007199254740991') > 0)) {
        throw new ApiError('configuration-error', 503, 'whmcs-remnawave-mapping-invalid');
    }
    $remoteUserId = (int) $domain;
    if ($remoteUserId < 1 || (string) $remoteUserId !== $domain) {
        throw new ApiError('configuration-error', 503, 'whmcs-remnawave-mapping-invalid');
    }
    return $remoteUserId;
}

/** Query the configured Remnawave 3.4+ numeric user route without guessing another lookup. */
function resolveRemnawaveSubscription(int $remoteUserId, array $config): string
{
    try {
        $token = decrypt($config['token_encrypted']);
        if (!is_string($token) || $token === '') {
            throw new ApiError('configuration-error', 503, 'remnawave-configuration-error');
        }
        $base = httpsUrl($config['panel_url'], true);
        $result = getJson($base . '/api/users/' . $remoteUserId, $token);
        return remnawaveSubscription($result, $remoteUserId, time());
    } catch (ApiError $error) {
        if ($error->diagnostic !== null) {
            throw $error;
        }
        $diagnostic = match ($error->reason) {
            'network-error' => 'remnawave-request-failed',
            'invalid-response' => 'remnawave-response-invalid',
            default => 'remnawave-configuration-error',
        };
        throw new ApiError($error->reason, $error->status, $diagnostic);
    } catch (\Throwable) {
        throw new ApiError('configuration-error', 503, 'remnawave-configuration-error');
    }
}

function api(array $config, string $identityToken = ''): ServiceApi
{
    return new ServiceApi(
        static fn (string $token): array => authenticate($token, $config, $identityToken),
        static fn (array $clients, ?int $id): array => findServices($clients, $config['product_ids'], $id),
        static fn (int $remoteUserId): string => resolveRemnawaveSubscription($remoteUserId, $config),
        static fn (array $clients): array => diagnoseEmptyServices($clients, $config['product_ids']),
        static fn (array $service): int => readRemnawaveMapping($service)
    );
}
