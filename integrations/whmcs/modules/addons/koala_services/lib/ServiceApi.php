<?php
declare(strict_types=1);

namespace KoalaServices;

use RuntimeException;

const ADDON_VERSION = '1.0.4';
const DIAGNOSTIC_MESSAGES = [
    'client-uuid-not-found' => 'OIDC 身份已验证，但没有匹配到 WHMCS 客户 UUID。请核实身份映射。',
    'client-uuid-matches-user' => 'OIDC sub 没有匹配客户 UUID，但唯一匹配用户 UUID。请核实并选择 User 身份映射。此探测不授予服务访问权限。',
    'client-uuid-ambiguous' => '同一个 OIDC 身份匹配到多个客户账户。',
    'client-uuid-mismatch' => '数据库匹配结果的 UUID 与已验证身份不完全一致。',
    'client-closed' => '匹配到的客户账户已关闭（Closed），不能访问服务。请检查客户 Profile 中的 Status。',
    'client-status-unknown' => '匹配到的客户账户状态无法识别。请核对客户 Profile 中的 Status 及插件对当前 WHMCS 版本的状态读取。',
    'user-uuid-not-found' => 'OIDC 身份已验证，但没有匹配到 WHMCS 用户 UUID。',
    'user-uuid-ambiguous' => '同一个 OIDC 身份匹配到多个用户。',
    'user-uuid-mismatch' => '用户 UUID 与已验证身份不完全一致。',
    'owned-client-limit' => '关联客户账户数量超过插件上限。',
    'no-owned-accessible-client' => '没有找到该用户作为 owner 拥有的 Active 或 Inactive 客户账户。',
    'invalid-client-mapping' => '身份映射返回了无效客户 ID。',
    'service-owner-mismatch' => '服务查询结果不属于当前已验证客户账户。',
    'service-not-active' => '服务查询结果包含非 Active 服务。',
    'whmcs-service-unavailable' => '导入时 WHMCS 未找到当前账号可访问的 Active 服务，请检查服务状态和商品范围。',
    'whmcs-service-changed' => '查询面板后，WHMCS 服务的归属、状态或用户映射已变化，导入被取消。',
    'whmcs-remnawave-mapping-missing' => 'WHMCS 服务的 Domain 字段尚未保存 Remnawave 数字用户 ID。请检查开通模块写入的映射。',
    'whmcs-remnawave-mapping-invalid' => 'WHMCS 服务的 Domain 字段不是有效的 Remnawave 数字用户 ID。请检查开通模块写入的映射。',
    'remnawave-user-not-found' => 'Remnawave 用户接口返回 404。请核实面板中是否存在对应的数字用户，以及它与 WHMCS 服务 ID 的映射。',
    'remnawave-id-mismatch' => 'Remnawave 返回的数字用户 ID 与 WHMCS 服务 Domain 中保存的用户 ID 不一致。',
    'remnawave-user-inactive' => 'Remnawave 用户状态不是 ACTIVE，不能导入。',
    'remnawave-user-expired' => 'Remnawave 用户的到期时间已过，不能导入。',
    'remnawave-expiry-invalid' => 'Remnawave 用户缺少有效到期时间，无法判断订阅是否可用。',
    'remnawave-response-invalid' => 'Remnawave 返回的用户数据格式无法识别。',
    'remnawave-access-denied' => 'Remnawave 拒绝了接口认证，请检查插件中的面板 Token 及其读取用户权限。',
    'remnawave-subscription-missing' => 'Remnawave 用户数据没有提供订阅地址。',
    'remnawave-subscription-invalid' => 'Remnawave 返回的订阅地址未通过 HTTPS 地址校验。',
    'remnawave-request-failed' => '无法完成 Remnawave 用户查询，请检查面板连接及接口响应状态。',
    'remnawave-configuration-error' => 'Remnawave 连接配置不可用，请检查面板 HTTPS 地址和已保存的 Token。',
];

final class ApiError extends RuntimeException
{
    public function __construct(
        public readonly string $reason,
        public readonly int $status,
        public readonly ?string $diagnostic = null
    )
    {
        parent::__construct($reason);
    }
}

/** Only fixed operator-facing reasons are logged; no token, subject, email or service URL. */
function recordDiagnostic(ApiError $error, string $requestId): void
{
    if (!isset(DIAGNOSTIC_MESSAGES[$error->diagnostic ?? ''])
        || !preg_match('/\A[a-f0-9]{16}\z/D', $requestId) || !function_exists('logActivity')) {
        return;
    }
    try {
        \logActivity('Koala Services code=' . $error->diagnostic . ' request=' . $requestId
            . ' ' . DIAGNOSTIC_MESSAGES[$error->diagnostic], 0);
    } catch (\Throwable) {
        // Logging failure must never change authentication or disclose internal exceptions.
    }
}

/** Public API boundary; identity and service ownership are resolved exclusively on the server. */
final class ServiceApi
{
    public function __construct(
        private readonly \Closure $authenticate,
        private readonly \Closure $findServices,
        private readonly \Closure $resolveSubscription,
        private readonly ?\Closure $diagnoseEmpty = null,
        private readonly ?\Closure $readMapping = null
    ) {}

    public function handle(array $request, string $authorization): array
    {
        if (!preg_match('/\ABearer ([\x21-\x7e]{1,8192})\z/D', $authorization, $matches)) {
            throw new ApiError('not-signed-in', 401);
        }
        $action = $request['action'] ?? null;
        if (!in_array($action, ['bind', 'list', 'resolve'], true)
            || array_diff(array_keys($request), $action === 'resolve' ? ['action', 'serviceId'] : ['action'])) {
            throw new ApiError('invalid-response', 400);
        }
        $id = $request['serviceId'] ?? null;
        if ($action === 'resolve' && (!is_int($id) || $id < 1 || $id > 9007199254740991)) {
            throw new ApiError('service-unavailable', 400);
        }
        $clients = ($this->authenticate)($matches[1]);
        if (!is_array($clients) || !$clients) {
            throw new ApiError('access-denied', 403, 'no-owned-accessible-client');
        }
        foreach ($clients as $client) {
            if (!is_int($client) || $client < 1) {
                throw new ApiError('access-denied', 403, 'invalid-client-mapping');
            }
        }
        if ($action === 'bind') {
            return ['version' => 1, 'bound' => true];
        }
        $rows = ($this->findServices)($clients, $action === 'resolve' ? $id : null);
        $services = [];
        foreach ($rows as $row) {
            // Keep this check even when the database adapter already filters ownership.
            if (!in_array($row['clientId'] ?? null, $clients, true)) {
                throw new ApiError('access-denied', 403, 'service-owner-mismatch');
            }
            if (($row['status'] ?? null) !== 'Active') {
                throw new ApiError('access-denied', 403, 'service-not-active');
            }
            $service = ['id' => $row['id'], 'name' => $row['name']];
            $date = $row['nextDueDate'] ?? '';
            if (preg_match('/\A[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}\z/D', $date)) {
                $service['nextDueDate'] = $date;
            }
            $services[] = $service;
        }
        if ($action === 'list') {
            $result = ['version' => 1, 'services' => $services];
            if ($services === [] && $this->diagnoseEmpty !== null) {
                try {
                    $result['diagnostics'] = emptyListDiagnostics(($this->diagnoseEmpty)($clients));
                } catch (\Throwable) {
                    // An optional probe must not turn a successful list into an error.
                    $result['diagnostics'] = ['version' => 1, 'reason' => 'unavailable'];
                }
            }
            return $result;
        }
        if (count($services) !== 1 || $services[0]['id'] !== $id) {
            throw new ApiError('service-unavailable', 404, 'whmcs-service-unavailable');
        }
        if ($this->readMapping === null) {
            throw new ApiError('configuration-error', 503, 'whmcs-remnawave-mapping-missing');
        }
        // The caller supplies only a WHMCS service ID. Resolve the remote ID after ownership checks.
        $remoteUserId = ($this->readMapping)($rows[0]);
        if (!is_int($remoteUserId) || $remoteUserId < 1 || $remoteUserId > 9007199254740991) {
            throw new ApiError('configuration-error', 503, 'whmcs-remnawave-mapping-invalid');
        }
        $url = ($this->resolveSubscription)($remoteUserId);
        // Recheck after upstream I/O so a service suspended during lookup is not imported.
        $current = ($this->findServices)($clients, $id);
        if (count($current) !== 1 || $current[0]['id'] !== $id
            || !in_array($current[0]['clientId'], $clients, true)
            || $current[0]['clientId'] !== $rows[0]['clientId']
            || $current[0]['status'] !== 'Active') {
            throw new ApiError('service-unavailable', 404, 'whmcs-service-changed');
        }
        try {
            $currentRemoteUserId = ($this->readMapping)($current[0]);
        } catch (\Throwable) {
            throw new ApiError('service-unavailable', 404, 'whmcs-service-changed');
        }
        if ($currentRemoteUserId !== $remoteUserId) {
            throw new ApiError('service-unavailable', 404, 'whmcs-service-changed');
        }
        return ['version' => 1, 'service' => $services[0], 'subscriptionUrl' => $url];
    }
}

/** Copy only the agreed aggregate fields; internal diagnostic data must not become public. */
function emptyListDiagnostics(mixed $data): array
{
    $unavailable = ['version' => 1, 'reason' => 'unavailable'];
    if (!is_array($data) || ($data['version'] ?? null) !== 1
        || !in_array($data['reason'] ?? null, ['no-owned-services', 'no-active-services', 'product-not-enabled', 'account-or-product-filtered'], true)) {
        return $unavailable;
    }
    $result = ['version' => 1, 'reason' => $data['reason']];
    foreach (['clientCount', 'ownedServices', 'activeServices', 'allowedServices'] as $field) {
        if (!is_int($data[$field] ?? null) || $data[$field] < 0 || $data[$field] > 9007199254740991) {
            return $unavailable;
        }
        $result[$field] = $data[$field];
    }
    $products = $data['allowedProductIds'] ?? null;
    if (!is_array($products) || !array_is_list($products) || count($products) > 100) {
        return $unavailable;
    }
    foreach ($products as $id) {
        if (!is_int($id) || $id < 1 || $id > 9007199254740991) {
            return $unavailable;
        }
    }
    $result['allowedProductIds'] = $products;
    return $result;
}

/** Strict URLs for credentials-bearing HTTP calls and returned subscription downloads. */
function httpsUrl(string $value, bool $base = false): string
{
    $parts = parse_url($value);
    if (strlen($value) > 4096 || preg_match('/[\x00-\x20\x7f\\\\]/', $value)
        || !is_array($parts) || ($parts['scheme'] ?? '') !== 'https'
        || empty($parts['host']) || isset($parts['user']) || isset($parts['pass'])
        || isset($parts['fragment']) || ($base && isset($parts['query']))) {
        throw new ApiError('configuration-error', 503);
    }
    return $base ? rtrim($value, '/') : $value;
}

/** No redirects, no raw upstream errors, no credential logging, bounded response and time. */
function getJson(string $url, ?string $token = null): array
{
    httpsUrl($url);
    if (!function_exists('curl_init') || ($token !== null && !preg_match('/\A[\x21-\x7e]{1,8192}\z/D', $token))) {
        throw new ApiError('configuration-error', 503);
    }
    $handle = curl_init($url);
    $body = '';
    curl_setopt_array($handle, [
        CURLOPT_HTTPHEADER => array_filter(['Accept: application/json', $token === null ? null : 'Authorization: Bearer ' . $token]),
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_CONNECTTIMEOUT => 4,
        CURLOPT_TIMEOUT => 10,
        CURLOPT_USERAGENT => 'Koala-Services/1.0',
        CURLOPT_WRITEFUNCTION => static function ($curl, string $chunk) use (&$body): int {
            if (strlen($body) + strlen($chunk) > 262144) {
                return 0;
            }
            $body .= $chunk;
            return strlen($chunk);
        },
    ]);
    $success = curl_exec($handle);
    $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
    curl_close($handle);
    if ($success === false) {
        throw new ApiError('network-error', 502);
    }
    // The caller distinguishes provider authentication from panel authentication.
    if ($status !== 200) {
        return ['status' => $status, 'body' => []];
    }
    try {
        $data = json_decode($body, true, 32, JSON_THROW_ON_ERROR);
    } catch (\Throwable) {
        throw new ApiError('invalid-response', 502);
    }
    if (!is_array($data) || array_is_list($data)) {
        throw new ApiError('invalid-response', 502);
    }
    return ['status' => $status, 'body' => $data];
}

function remnawaveSubscription(array $result, int $remoteUserId, int $now): string
{
    $status = $result['status'];
    if (in_array($status, [401, 403], true)) {
        throw new ApiError('configuration-error', 503, 'remnawave-access-denied');
    }
    if ($status === 404) {
        throw new ApiError('service-unavailable', 404, 'remnawave-user-not-found');
    }
    if ($status !== 200) {
        throw new ApiError('network-error', 502, 'remnawave-request-failed');
    }
    $user = $result['body']['response'] ?? null;
    if (!is_array($user)) {
        throw new ApiError('invalid-response', 502, 'remnawave-response-invalid');
    }
    if (($user['id'] ?? null) !== $remoteUserId) {
        throw new ApiError('invalid-response', 502, 'remnawave-id-mismatch');
    }
    $expires = is_string($user['expireAt'] ?? null) ? strtotime($user['expireAt']) : false;
    if (($user['status'] ?? null) !== 'ACTIVE') {
        throw new ApiError('service-unavailable', 409, 'remnawave-user-inactive');
    }
    if ($expires === false) {
        throw new ApiError('service-unavailable', 409, 'remnawave-expiry-invalid');
    }
    if ($expires <= $now) {
        throw new ApiError('service-unavailable', 409, 'remnawave-user-expired');
    }
    if (!is_string($user['subscriptionUrl'] ?? null)) {
        throw new ApiError('invalid-response', 502, 'remnawave-subscription-missing');
    }
    try {
        return httpsUrl($user['subscriptionUrl']);
    } catch (ApiError $error) {
        throw new ApiError($error->reason, $error->status, 'remnawave-subscription-invalid');
    }
}
