<?php
declare(strict_types=1);

require_once __DIR__ . '/../integrations/whmcs/modules/addons/koala_services/lib/ServiceApi.php';

use KoalaServices\ApiError;
use KoalaServices\ServiceApi;
use function KoalaServices\httpsUrl;
use function KoalaServices\remnawaveSubscription;
use function KoalaServices\recordDiagnostic;

$activityMessages = [];
function logActivity(string $message, int $clientId): void
{
    global $activityMessages;
    check($clientId === 0);
    $activityMessages[] = $message;
}

// No WHMCS licence, database or panel credential is required for these boundary tests.
$passed = 0;
function check(bool $condition): void
{
    if (!$condition) {
        throw new RuntimeException('Assertion failed');
    }
}
function test(string $name, Closure $run): void
{
    global $passed;
    $run();
    ++$passed;
    echo "ok - $name\n";
}
function denies(string $reason, int $status, Closure $run): void
{
    try {
        $run();
    } catch (ApiError $error) {
        check($error->reason === $reason && $error->status === $status);
        return;
    }
    throw new RuntimeException('Expected denial');
}
function diagnoses(string $reason, int $status, string $diagnostic, Closure $run): void
{
    try {
        $run();
    } catch (ApiError $error) {
        check($error->reason === $reason && $error->status === $status && $error->diagnostic === $diagnostic);
        check(isset(KoalaServices\DIAGNOSTIC_MESSAGES[$diagnostic]));
        return;
    }
    throw new RuntimeException('Expected diagnosed rejection');
}
function service(int $id = 2326, int $client = 19): array
{
    return ['id' => $id, 'clientId' => $client, 'name' => 'Testing', 'status' => 'Active',
        'nextDueDate' => '0000-00-00', 'password' => 'must-not-be-returned'];
}
function panel(array $override = []): array
{
    return ['status' => 200, 'body' => ['response' => array_replace([
        'id' => 2326, 'status' => 'ACTIVE', 'expireAt' => '2030-01-01T00:00:00Z',
        'subscriptionUrl' => 'https://sub.example.com/sub/example',
        'trojanPassword' => 'must-not-be-returned',
    ], $override)]];
}
function api(?Closure $find = null, ?Closure $resolve = null, ?Closure $authenticate = null, ?Closure $diagnoseEmpty = null, ?Closure $readMapping = null): ServiceApi
{
    return new ServiceApi(
        $authenticate ?? static function (string $token): array {
            check($token === 'test-access-token');
            return [19];
        },
        $find ?? static fn (): array => [service()],
        $resolve ?? static fn (): string => 'https://sub.example.com/sub/example',
        $diagnoseEmpty,
        $readMapping ?? static fn (array $row): int => 2326
    );
}
$bearer = 'Bearer test-access-token';

test('diagnostics log only fixed codes and a server-generated request ID', function (): void {
    global $activityMessages;
    $activityMessages = [];
    recordDiagnostic(new ApiError('sensitive-error-content', 403, 'client-uuid-not-found'), '0123456789abcdef');
    check(count($activityMessages) === 1);
    check(str_contains($activityMessages[0], 'code=client-uuid-not-found request=0123456789abcdef'));
    check(!str_contains($activityMessages[0], 'sensitive-error-content'));
    recordDiagnostic(new ApiError('not-signed-in', 401), '0123456789abcdef');
    recordDiagnostic(new ApiError('access-denied', 403, 'untrusted-diagnostic'), '0123456789abcdef');
    recordDiagnostic(new ApiError('access-denied', 403, 'client-closed'), "fake\nrequest");
    check(count($activityMessages) === 1);
});
test('closed and unrecognized client states have distinct fixed diagnostics', function (): void {
    global $activityMessages;
    $activityMessages = [];
    foreach (['client-closed', 'client-status-unknown', 'no-owned-accessible-client'] as $code) {
        recordDiagnostic(new ApiError('access-denied', 403, $code), '0123456789abcdef');
    }
    check(count($activityMessages) === 3);
    check(str_contains($activityMessages[0], 'code=client-closed'));
    check(str_contains($activityMessages[1], 'code=client-status-unknown'));
    check(str_contains($activityMessages[2], 'code=no-owned-accessible-client'));
});
test('resolve distinguishes WHMCS service filtering from a change during panel lookup', function () use ($bearer): void {
    diagnoses('service-unavailable', 404, 'whmcs-service-unavailable', static fn () => api(find: static fn (): array => [])
        ->handle(['action' => 'resolve', 'serviceId' => 2326], $bearer));
    $rows = [service()];
    $api = api(find: static function () use (&$rows): array { return $rows; }, resolve: static function () use (&$rows): string {
        $rows = [];
        return 'https://sub.example.com/sub/example';
    });
    diagnoses('service-unavailable', 404, 'whmcs-service-changed', static fn () => $api->handle(['action' => 'resolve', 'serviceId' => 2326], $bearer));
});
test('an absent mapping dependency denies resolve while list does not need a mapping', function () use ($bearer): void {
    $api = new ServiceApi(static fn (): array => [19], static fn (): array => [service()],
        static fn () => throw new RuntimeException('Must not resolve without a mapping'));
    check(count($api->handle(['action' => 'list'], $bearer)['services']) === 1);
    diagnoses('configuration-error', 503, 'whmcs-remnawave-mapping-missing', static fn () => $api->handle(['action' => 'resolve', 'serviceId' => 2326], $bearer));
});
test('mapping is read after authorization and a changed mapping is rejected after lookup', function () use ($bearer): void {
    $reads = 0;
    $remoteId = 3079;
    $readMapping = static function (array $row) use (&$reads, &$remoteId): int {
        ++$reads;
        check($row['id'] === 2330 && $row['clientId'] === 19 && $row['status'] === 'Active');
        return $remoteId;
    };
    $api = api(find: static fn (): array => [service(2330)], readMapping: $readMapping,
        resolve: static function (int $id) use (&$remoteId): string {
            check($id === 3079);
            $remoteId = 3080;
            return 'https://sub.example.com/sub/example';
        });
    diagnoses('service-unavailable', 404, 'whmcs-service-changed', static fn () => $api->handle(['action' => 'resolve', 'serviceId' => 2330], $bearer));
    check($reads === 2);
    $reads = 0;
    denies('access-denied', 403, static fn () => api(find: static fn (): array => [service(2330, 20)], readMapping: $readMapping)
        ->handle(['action' => 'resolve', 'serviceId' => 2330], $bearer));
    check($reads === 0);
});
test('panel failures have fixed diagnostics without disclosing provider bodies', function (): void {
    global $activityMessages;
    $activityMessages = [];
    $cases = [
        [['status' => 404, 'body' => ['secret' => 'must-not-leak']], 'service-unavailable', 404, 'remnawave-user-not-found'],
        [['status' => 401], 'configuration-error', 503, 'remnawave-access-denied'],
        [['status' => 403], 'configuration-error', 503, 'remnawave-access-denied'],
        [['status' => 500], 'network-error', 502, 'remnawave-request-failed'],
        [['status' => 200, 'body' => ['response' => null]], 'invalid-response', 502, 'remnawave-response-invalid'],
        [panel(['id' => 2327]), 'invalid-response', 502, 'remnawave-id-mismatch'],
        [panel(['status' => 'DISABLED']), 'service-unavailable', 409, 'remnawave-user-inactive'],
        [panel(['expireAt' => '2020-01-01T00:00:00Z']), 'service-unavailable', 409, 'remnawave-user-expired'],
        [panel(['expireAt' => 'invalid']), 'service-unavailable', 409, 'remnawave-expiry-invalid'],
        [panel(['subscriptionUrl' => null]), 'invalid-response', 502, 'remnawave-subscription-missing'],
        [panel(['subscriptionUrl' => 'http://unsafe.example.com/private']), 'configuration-error', 503, 'remnawave-subscription-invalid'],
    ];
    foreach ($cases as [$response, $reason, $status, $diagnostic]) {
        diagnoses($reason, $status, $diagnostic, static fn () => remnawaveSubscription($response, 2326, 1700000000));
        try {
            remnawaveSubscription($response, 2326, 1700000000);
        } catch (ApiError $error) {
            recordDiagnostic($error, '0123456789abcdef');
        }
    }
    check(count($activityMessages) === count($cases));
    $logged = implode("\n", $activityMessages);
    foreach (['must-not-leak', 'http://unsafe.example.com/private', '2326', '2327', 'DISABLED', '2020-01-01'] as $value) {
        check(!str_contains($logged, $value));
    }
});
test('binding verifies identity without querying or resolving services', function () use ($bearer): void {
    $result = api(
        find: static fn () => throw new RuntimeException('Unexpected service query'),
        resolve: static fn () => throw new RuntimeException('Unexpected panel request')
    )->handle(['action' => 'bind'], $bearer);
    check($result === ['version' => 1, 'bound' => true]);
});
test('list exposes only service display fields, without resolving subscriptions', function () use ($bearer): void {
    $result = api(resolve: static fn () => throw new RuntimeException('Unexpected panel request'))
        ->handle(['action' => 'list'], $bearer);
    check($result === ['version' => 1, 'services' => [['id' => 2326, 'name' => 'Testing']]]);
});
test('list is fetched again on every request', function () use ($bearer): void {
    $rows = [service()];
    $api = api(find: static function () use (&$rows): array { return $rows; });
    check(count($api->handle(['action' => 'list'], $bearer)['services']) === 1);
    $rows = [];
    check($api->handle(['action' => 'list'], $bearer)['services'] === []);
});
test('only successful empty lists request scoped aggregate diagnostics', function () use ($bearer): void {
    $calls = 0;
    $diagnostics = ['version' => 1, 'reason' => 'product-not-enabled', 'clientCount' => 1,
        'ownedServices' => 3, 'activeServices' => 2, 'allowedServices' => 0, 'allowedProductIds' => [1, 2]];
    $result = api(find: static fn (): array => [], diagnoseEmpty: static function (array $clients) use (&$calls, $diagnostics): array {
        ++$calls;
        check($clients === [19]);
        return $diagnostics + ['sub' => 'must-not-leak', 'serviceId' => 2326, 'name' => 'must-not-leak'];
    })->handle(['action' => 'list'], $bearer);
    check($calls === 1 && $result === ['version' => 1, 'services' => [], 'diagnostics' => $diagnostics]);
    $unexpectedCalls = 0;
    $unexpected = static function () use (&$unexpectedCalls): never {
        ++$unexpectedCalls;
        throw new RuntimeException('Unexpected diagnostic query');
    };
    check(count(api(diagnoseEmpty: $unexpected)->handle(['action' => 'list'], $bearer)['services']) === 1);
    check(api(diagnoseEmpty: $unexpected)->handle(['action' => 'bind'], $bearer)['bound'] === true);
    check(api(diagnoseEmpty: $unexpected)->handle(['action' => 'resolve', 'serviceId' => 2326], $bearer)['service']['id'] === 2326);
    denies('service-unavailable', 404, static fn () => api(find: static fn (): array => [], diagnoseEmpty: $unexpected)
        ->handle(['action' => 'resolve', 'serviceId' => 9999], $bearer));
    denies('not-signed-in', 401, static fn () => api(diagnoseEmpty: $unexpected)->handle(['action' => 'list'], ''));
    denies('not-signed-in', 401, static fn () => api(authenticate: static fn () => throw new ApiError('not-signed-in', 401), diagnoseEmpty: $unexpected)
        ->handle(['action' => 'list'], $bearer));
    check($unexpectedCalls === 0);
});
test('failed or malformed diagnostics never change successful empty-list behavior or expose details', function () use ($bearer): void {
    foreach ([
        static fn () => throw new RuntimeException('private-database-error'),
        static fn (): array => ['version' => 1, 'reason' => 'untrusted-detail'],
        static fn (): array => ['version' => 1, 'reason' => 'unavailable', 'token' => 'private-token'],
        static fn (): array => ['version' => 1, 'reason' => 'no-owned-services', 'ownedServices' => -1],
    ] as $diagnose) {
        $result = api(find: static fn (): array => [], diagnoseEmpty: $diagnose)->handle(['action' => 'list'], $bearer);
        check($result === ['version' => 1, 'services' => [], 'diagnostics' => ['version' => 1, 'reason' => 'unavailable']]);
    }
});
test('missing and malformed bearer cannot access database', function (): void {
    foreach (['', 'Basic password', "Bearer token\r\nX-Test: injected", 'Bearer a b'] as $token) {
        denies('not-signed-in', 401, static fn () => api(
            authenticate: static fn () => throw new RuntimeException('Unexpected authentication')
        )->handle(['action' => 'list'], $token));
    }
});
test('expired bearer cannot access services', function () use ($bearer): void {
    denies('not-signed-in', 401, static fn () => api(
        find: static fn () => throw new RuntimeException('Unexpected database request'),
        authenticate: static fn () => throw new ApiError('not-signed-in', 401)
    )->handle(['action' => 'list'], $bearer));
});
test('client IDs and URL overrides supplied by the caller are rejected', function () use ($bearer): void {
    foreach (['clientId' => 20, 'panelUrl' => 'https://evil.example.com', 'token' => 'other'] as $key => $value) {
        denies('invalid-response', 400, static fn () => api()->handle(['action' => 'list', $key => $value], $bearer));
    }
});
test('resolve rejects unsafe or ambiguous IDs before upstream lookup', function () use ($bearer): void {
    foreach ([null, '2326', -1, 0, 2.5, true, 9007199254740992] as $id) {
        denies('service-unavailable', 400, static fn () => api()->handle(['action' => 'resolve', 'serviceId' => $id], $bearer));
    }
});
test('missing owned account is denied', function () use ($bearer): void {
    denies('access-denied', 403, static fn () => api(authenticate: static fn (): array => [])
        ->handle(['action' => 'list'], $bearer));
});
test('another client service cannot be listed or resolved', function () use ($bearer): void {
    foreach (['list', 'resolve'] as $action) {
        $request = $action === 'list' ? ['action' => $action] : ['action' => $action, 'serviceId' => 2326];
        denies('access-denied', 403, static fn () => api(find: static fn (): array => [service(client: 20)])
            ->handle($request, $bearer));
    }
});
test('suspended services cannot be resolved', function () use ($bearer): void {
    denies('access-denied', 403, static fn () => api(find: static fn (): array => [array_replace(service(), ['status' => 'Suspended'])])
        ->handle(['action' => 'resolve', 'serviceId' => 2326], $bearer));
});
test('unowned and missing service IDs do not call Remnawave', function () use ($bearer): void {
    denies('service-unavailable', 404, static fn () => api(
        find: static fn (): array => [],
        resolve: static fn () => throw new RuntimeException('Unexpected panel request')
    )->handle(['action' => 'resolve', 'serviceId' => 2327], $bearer));
});
test('a successful resolve uses the service ID and returns only its subscription', function () use ($bearer): void {
    $calls = 0;
    $result = api(resolve: static function (int $id) use (&$calls): string {
        ++$calls;
        check($id === 2326);
        return remnawaveSubscription(panel(), $id, 1700000000);
    })->handle(['action' => 'resolve', 'serviceId' => 2326], $bearer);
    check($calls === 1 && $result === [
        'version' => 1, 'service' => ['id' => 2326, 'name' => 'Testing'],
        'subscriptionUrl' => 'https://sub.example.com/sub/example',
    ]);
});
test('a service revoked during panel lookup cannot be imported', function () use ($bearer): void {
    foreach (['ownership', 'status', 'deleted'] as $change) {
        $row = service();
        $api = api(
            find: static function () use (&$row): array { return $row === null ? [] : [$row]; },
            resolve: static function () use (&$row, $change): string {
                $row = match ($change) {
                    'ownership' => service(client: 20),
                    'status' => array_replace(service(), ['status' => 'Suspended']),
                    'deleted' => null,
                };
                return 'https://sub.example.com/sub/example';
            }
        );
        denies('service-unavailable', 404, static fn () => $api->handle(['action' => 'resolve', 'serviceId' => 2326], $bearer));
    }
});
test('Remnawave must return exactly the requested numeric ID', function (): void {
    foreach ([2327, '2326', null] as $id) {
        denies('invalid-response', 502, static fn () => remnawaveSubscription(panel(['id' => $id]), 2326, 1700000000));
    }
});
test('inactive and expired panel users cannot be imported', function (): void {
    foreach ([['status' => 'DISABLED'], ['expireAt' => '2020-01-01T00:00:00Z'], ['expireAt' => 'invalid'], ['expireAt' => null]] as $user) {
        denies('service-unavailable', 409, static fn () => remnawaveSubscription(panel($user), 2326, 1700000000));
    }
});
test('panel credentials and raw upstream errors are never reflected', function (): void {
    foreach ([401, 403] as $status) {
        denies('configuration-error', 503, static fn () => remnawaveSubscription(['status' => $status, 'body' => ['error' => 'secret']], 2326, 1700000000));
    }
    denies('network-error', 502, static fn () => remnawaveSubscription(['status' => 500], 2326, 1700000000));
    denies('service-unavailable', 404, static fn () => remnawaveSubscription(['status' => 404], 2326, 1700000000));
});
test('subscription URLs cannot carry userinfo, fragments or malformed schemes', function (): void {
    foreach (['http://sub.example.com/a', 'https://u:p@sub.example.com/a', 'https://sub.example.com/a#token', '//sub.example.com/a', "https://sub.example.com/\na", 'https://sub.example.com\\@evil.example.com/a'] as $url) {
        denies('configuration-error', 503, static fn () => remnawaveSubscription(panel(['subscriptionUrl' => $url]), 2326, 1700000000));
    }
});
test('base URL keeps deployment subpath but forbids a query', function (): void {
    check(httpsUrl('https://panel.example.com/remna/', true) === 'https://panel.example.com/remna');
    denies('configuration-error', 503, static fn () => httpsUrl('https://panel.example.com/?next=evil', true));
});
echo "$passed PHP boundary tests passed\n";
