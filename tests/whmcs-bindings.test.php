<?php
declare(strict_types=1);

// Exercise the production adapter with in-memory WHMCS and transport boundaries.
// This does not claim compatibility with WHMCS's proprietary runtime or its UUID semantics.
namespace KoalaBindingFixtures {
    final class State
    {
        public static int $now = 1800000000;
        public static array $tables = [];
        public static array $requests = [];
        public static array $userInfo = [];
        public static array $jwks = [];
        public static array $clients = [];
        public static array $users = [];
        public static bool $userUuidAvailable = false;
        public static int $bindingReads = 0;
        public static int $writes = 0;
        public static array $countQueries = [];
        public static bool $countFails = false;
        public static ?array $countResults = null;
        public static array $panelResponses = [];
        public static array $mappingReads = [];
        public static ?\Closure $onPanelResponse = null;
    }

    final class Query
    {
        private array $conditions = [];
        private array $joins = [];
        private ?array $columns = null;
        private ?array $order = null;
        private int $maximum = PHP_INT_MAX;
        public function __construct(private readonly string $table) {}
        public function where(string $key, mixed $operator, mixed $value = null): self
        {
            $this->conditions[] = func_num_args() === 2 ? [$key, '=', $operator] : [$key, $operator, $value];
            return $this;
        }
        public function whereIn(string $key, array $values): self
        {
            $this->conditions[] = [$key, 'in', $values];
            return $this;
        }
        public function join(string $table, string $left, string $operator, string $right): self
        {
            if ($operator !== '=') {
                throw new \RuntimeException('Unsupported fixture join');
            }
            $this->joins[] = [$table, $left, $right];
            return $this;
        }
        public function select(array $columns): self { $this->columns = $columns; return $this; }
        public function orderBy(string $field, string $direction): self { $this->order = [$field, $direction]; return $this; }
        public function limit(int $limit): self { $this->maximum = $limit; return $this; }
        public function count(): int
        {
            State::$countQueries[] = ['table' => $this->table, 'conditions' => $this->conditions];
            if (State::$countFails) {
                throw new \RuntimeException('private-database-diagnostic');
            }
            return State::$countResults === null ? $this->get()->count() : array_shift(State::$countResults);
        }
        private function tableRows(string $table): array
        {
            $parts = explode(' as ', $table);
            return array_map(static function (array $row) use ($parts): array {
                if (count($parts) === 1) {
                    return $row;
                }
                return array_combine(array_map(static fn (string $key): string => $parts[1] . '.' . $key, array_keys($row)), array_values($row));
            }, State::$tables[$parts[0]] ?? []);
        }
        public function get(): \ArrayObject
        {
            $rows = $this->tableRows($this->table);
            foreach ($this->joins as [$table, $left, $right]) {
                $joined = [];
                foreach ($rows as $row) {
                    foreach ($this->tableRows($table) as $candidate) {
                        $combined = array_merge($row, $candidate);
                        if (isset($combined[$left], $combined[$right]) && $combined[$left] === $combined[$right]) {
                            $joined[] = $combined;
                        }
                    }
                }
                $rows = $joined;
            }
            $rows = array_values(array_filter($rows, $this->matches(...)));
            if ($this->order !== null) {
                [$field, $direction] = $this->order;
                usort($rows, static fn (array $a, array $b): int => ($a[$field] <=> $b[$field]) * ($direction === 'desc' ? -1 : 1));
            }
            $rows = array_slice($rows, 0, $this->maximum);
            return new \ArrayObject(array_map(function (array $row): object {
                if ($this->columns === null) {
                    return (object) $row;
                }
                $selected = [];
                foreach ($this->columns as $column) {
                    $parts = explode('.', $column);
                    $selected[end($parts)] = $row[$column];
                }
                return (object) $selected;
            }, $rows));
        }
        private function matches(array $row): bool
        {
            foreach ($this->conditions as [$key, $operator, $value]) {
                $matched = match ($operator) {
                    '=' => ($row[$key] ?? null) === $value,
                    // Model common case-insensitive MySQL status matching, not a full SQL collation.
                    'in' => $key === 'c.status' && is_string($row[$key] ?? null)
                        ? in_array(strtolower($row[$key]), array_map('strtolower', $value), true)
                        : in_array($row[$key] ?? null, $value, true),
                    '<=' => ($row[$key] ?? PHP_INT_MAX) <= $value,
                    default => throw new \RuntimeException('Unsupported fixture operator'),
                };
                if (!$matched) {
                    return false;
                }
            }
            return true;
        }
        public function first(): ?object
        {
            if ($this->table === 'mod_koala_services_bindings') {
                ++State::$bindingReads;
            }
            if ($this->table === 'tblhosting') {
                State::$mappingReads[] = $this->conditions;
            }
            foreach (State::$tables[$this->table] ?? [] as $row) {
                if ($this->matches($row)) {
                    return (object) $row;
                }
            }
            return null;
        }
        public function delete(): void
        {
            State::$tables[$this->table] = array_values(array_filter(
                State::$tables[$this->table] ?? [], fn (array $row): bool => !$this->matches($row)
            ));
        }
        public function updateOrInsert(array $identity, array $data): void
        {
            ++State::$writes;
            foreach (State::$tables[$this->table] ?? [] as $index => $row) {
                if (array_intersect_assoc($row, $identity) === $identity) {
                    State::$tables[$this->table][$index] = array_replace($row, $data);
                    return;
                }
            }
            State::$tables[$this->table][] = array_merge($identity, $data);
        }
    }

    final class ModelQuery
    {
        private int $maximum = PHP_INT_MAX;
        private ?int $linkedUser = null;
        public function __construct(private readonly string $field, private readonly mixed $value, private readonly string $model = 'clients', private readonly bool $multiple = false) {}
        public function limit(int $limit): self { $this->maximum = $limit; return $this; }
        public function whereHas(string $relation, \Closure $filter): self
        {
            if ($relation !== 'users') {
                throw new \RuntimeException('Unsupported fixture relationship');
            }
            $query = new class {
                public ?int $id = null;
                public function whereKey(int $id): self { $this->id = $id; return $this; }
            };
            $filter($query);
            $this->linkedUser = $query->id;
            return $this;
        }
        public function get(): \ArrayObject
        {
            // Status WHERE IN may match mixed-case strings before PHP validates exact states.
            $foldStatus = $this->multiple && $this->field === 'status';
            $values = $foldStatus ? array_map('strtolower', $this->value) : $this->value;
            $rows = array_values(array_filter($this->model === 'users' ? State::$users : State::$clients,
                fn (object $row): bool => ($this->multiple
                    ? in_array($foldStatus ? strtolower((string) ($row->{$this->field} ?? '')) : ($row->{$this->field} ?? null), $values, true)
                    : ($row->{$this->field} ?? null) === $this->value)
                    && ($this->linkedUser === null || in_array($this->linkedUser, $row->userIds ?? [], true))));
            return new \ArrayObject(array_slice($rows, 0, $this->maximum));
        }
    }

    final class ClientRecord
    {
        public function __construct(public int $id, public string $uuid, public string $status, public int $ownerId, public array $userIds) {}
        public function isOwnedBy(object $user): bool { return $this->ownerId === $user->id; }
    }

    final class HttpRequest
    {
        public array $options = [];
        public int $status = 0;
        public function __construct(public readonly string $url) {}
    }
}

namespace WHMCS\Database {
    final class Capsule
    {
        public static function schema(): object
        {
            return new class {
                public function hasColumn(string $table, string $column): bool
                {
                    if ($table !== 'tblusers' || $column !== 'uuid') {
                        throw new \RuntimeException('Unexpected schema probe');
                    }
                    return \KoalaBindingFixtures\State::$userUuidAvailable;
                }
            };
        }
        public static function table(string $table): \KoalaBindingFixtures\Query
        {
            return new \KoalaBindingFixtures\Query($table);
        }
    }
}

namespace WHMCS\Config {
    final class Setting
    {
        public static function getValue(string $key): string
        {
            if ($key !== 'SystemURL') {
                throw new \RuntimeException('Unexpected setting');
            }
            return 'https://whmcs.example.com';
        }
    }
}

namespace WHMCS\User {
    final class User
    {
        public static function where(string $field, mixed $value): \KoalaBindingFixtures\ModelQuery
        {
            return new \KoalaBindingFixtures\ModelQuery($field, $value, 'users');
        }
    }
    final class Client
    {
        public static function where(string $field, mixed $value): \KoalaBindingFixtures\ModelQuery
        {
            return new \KoalaBindingFixtures\ModelQuery($field, $value);
        }
        public static function whereIn(string $field, array $values): \KoalaBindingFixtures\ModelQuery
        {
            return new \KoalaBindingFixtures\ModelQuery($field, $values, 'clients', true);
        }
    }
}

namespace KoalaServices {
    function time(): int { return \KoalaBindingFixtures\State::$now; }
    function decrypt(string $value): string { return $value === 'encrypted-fixture' ? 'fixture-remnawave-token' : ''; }
    function curl_init(string $url): \KoalaBindingFixtures\HttpRequest
    {
        return new \KoalaBindingFixtures\HttpRequest($url);
    }
    function curl_setopt_array(\KoalaBindingFixtures\HttpRequest $request, array $options): bool
    {
        $request->options = $options;
        return true;
    }
    function curl_exec(\KoalaBindingFixtures\HttpRequest $request): bool
    {
        \KoalaBindingFixtures\State::$requests[] = $request->url;
        $response = match ($request->url) {
            'https://whmcs.example.com/oauth/userinfo.php' => \KoalaBindingFixtures\State::$userInfo,
            'https://whmcs.example.com/oauth/certs.php' => ['status' => 200, 'body' => \KoalaBindingFixtures\State::$jwks],
            default => \KoalaBindingFixtures\State::$panelResponses[$request->url] ?? throw new \RuntimeException('Unexpected upstream URL'),
        };
        if (isset(\KoalaBindingFixtures\State::$panelResponses[$request->url]) && \KoalaBindingFixtures\State::$onPanelResponse !== null) {
            (\KoalaBindingFixtures\State::$onPanelResponse)();
        }
        if (!empty($response['networkFailure'])) {
            return false;
        }
        $request->status = $response['status'];
        ($request->options[CURLOPT_WRITEFUNCTION])($request, $response['rawBody'] ?? json_encode($response['body'] ?? [], JSON_THROW_ON_ERROR));
        return true;
    }
    function curl_getinfo(\KoalaBindingFixtures\HttpRequest $request, int $field): int { return $request->status; }
    function curl_close(\KoalaBindingFixtures\HttpRequest $request): void {}
}

namespace {
    require_once __DIR__ . '/../integrations/whmcs/modules/addons/koala_services/lib/WhmcsAdapter.php';

    use KoalaBindingFixtures\State;
    use KoalaServices\ApiError;
    use function KoalaServices\authenticate;

    function assertBinding(bool $condition): void
    {
        if (!$condition) {
            throw new RuntimeException('Binding assertion failed');
        }
    }
    function deniesBinding(string $reason, int $status, Closure $run): void
    {
        try {
            $run();
        } catch (ApiError $error) {
            assertBinding($error->reason === $reason && $error->status === $status);
            return;
        }
        throw new RuntimeException('Expected authentication rejection');
    }
    function encodeBindingPart(string $input): string
    {
        return rtrim(strtr(base64_encode($input), '+/', '-_'), '=');
    }

    $privateKey = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
    assertBinding($privateKey !== false);
    $publicKey = openssl_pkey_get_details($privateKey);
    $jwks = ['keys' => [['kty' => 'RSA', 'alg' => 'RS256', 'kid' => 'fixture-key',
        'n' => encodeBindingPart($publicKey['rsa']['n']), 'e' => encodeBindingPart($publicKey['rsa']['e'])]]];
    $subject = '967749ec-caa2-48c4-8c79-d6b88b5aacb1';
    $config = ['oidc_issuer' => 'https://whmcs.example.com', 'oidc_client_id' => 'KOALA.example',
        'subject_kind' => 'client_uuid'];
    $token = 'fixture-access-token';
    $sign = static function (array $override = []) use ($subject, $config, $privateKey): string {
        $claims = array_replace(['iss' => $config['oidc_issuer'], 'aud' => $config['oidc_client_id'],
            'sub' => $subject, 'iat' => State::$now - 5, 'exp' => State::$now + 95], $override);
        $input = encodeBindingPart(json_encode(['alg' => 'RS256', 'kid' => 'fixture-key'], JSON_THROW_ON_ERROR))
            . '.' . encodeBindingPart(json_encode($claims, JSON_THROW_ON_ERROR));
        assertBinding(openssl_sign($input, $signature, $privateKey, OPENSSL_ALGO_SHA256));
        return $input . '.' . encodeBindingPart($signature);
    };
    $passed = 0;
    $test = static function (string $name, Closure $run) use (&$passed, $jwks, $subject): void {
        State::$now = 1800000000;
        State::$tables = [];
        State::$requests = [];
        State::$bindingReads = 0;
        State::$writes = 0;
        State::$countQueries = [];
        State::$countFails = false;
        State::$countResults = null;
        State::$panelResponses = [];
        State::$mappingReads = [];
        State::$onPanelResponse = null;
        State::$jwks = $jwks;
        State::$userInfo = ['status' => 200, 'body' => ['sub' => $subject]];
        State::$clients = [(object) ['id' => 19, 'uuid' => $subject, 'status' => 'Active']];
        State::$users = [];
        State::$userUuidAvailable = false;
        $run();
        ++$passed;
        echo 'ok - ' . $name . PHP_EOL;
    };

    $test('first use requires a signed proof for this app and stores only hashes', function () use ($config, $token, $sign, $subject): void {
        $proof = $sign();
        assertBinding(authenticate($token, $config, $proof) === [19]);
        $rows = State::$tables[KoalaServices\BINDINGS_TABLE];
        assertBinding(count($rows) === 1 && $rows[0]['expires_at'] === State::$now + 86400);
        $stored = json_encode($rows, JSON_THROW_ON_ERROR);
        foreach ([$token, $proof, $subject] as $sensitive) {
            assertBinding(!str_contains($stored, $sensitive));
        }
    });
    $test('new bearer without identity proof is rejected', function () use ($config, $token): void {
        deniesBinding('not-signed-in', 401, fn () => authenticate($token, $config, ''));
        assertBinding(State::$writes === 0);
    });
    $test('verified login without a matching client UUID reports the mapping failure, not a login failure', function () use ($config, $token, $sign): void {
        State::$clients = [];
        try {
            authenticate($token, $config, $sign());
        } catch (ApiError $error) {
            assertBinding($error->reason === 'access-denied' && $error->status === 403);
            assertBinding(($error->diagnostic ?? null) === 'client-uuid-not-found');
            return;
        }
        throw new RuntimeException('Expected missing-client rejection');
    });
    $test('a verified Inactive client can access its own services', function () use ($config, $token, $sign): void {
        State::$clients[0]->status = 'Inactive';
        assertBinding(authenticate($token, $config, $sign()) === [19]);
    });
    $test('Closed and unknown client states deny access with distinct diagnostics', function () use ($config, $token, $sign): void {
        foreach (['Closed' => 'client-closed', 'Suspended' => 'client-status-unknown', '' => 'client-status-unknown', 'active' => 'client-status-unknown', 'inactive' => 'client-status-unknown'] as $status => $diagnostic) {
            State::$clients[0]->status = $status;
            try {
                authenticate($token, $config, $sign());
            } catch (ApiError $error) {
                assertBinding($error->reason === 'access-denied' && $error->status === 403);
                assertBinding($error->diagnostic === $diagnostic);
                continue;
            }
            throw new RuntimeException('Expected closed/unknown client rejection');
        }
    });
    $test('User UUID grants only owned Active or Inactive clients, excluding invitations and closed accounts', function () use ($config, $token, $sign, $subject): void {
        State::$users = [(object) ['id' => 88, 'uuid' => $subject]];
        State::$clients = [
            new KoalaBindingFixtures\ClientRecord(19, 'owned-active', 'Active', 88, [88]),
            new KoalaBindingFixtures\ClientRecord(20, 'owned-inactive', 'Inactive', 88, [88]),
            new KoalaBindingFixtures\ClientRecord(21, 'owned-closed', 'Closed', 88, [88]),
            new KoalaBindingFixtures\ClientRecord(22, 'owned-unknown', 'Suspended', 88, [88]),
            new KoalaBindingFixtures\ClientRecord(23, 'invited', 'Active', 90, [88, 90]),
            new KoalaBindingFixtures\ClientRecord(24, 'unrelated', 'Active', 90, [90]),
            new KoalaBindingFixtures\ClientRecord(25, 'owned-lowercase', 'active', 88, [88]),
            new KoalaBindingFixtures\ClientRecord(26, 'owned-uppercase', 'INACTIVE', 88, [88]),
        ];
        assertBinding(authenticate($token, array_replace($config, ['subject_kind' => 'user_uuid']), $sign()) === [19, 20]);
    });
    $test('service listing keeps ownership, product and service-state filters while permitting Inactive clients', function () use ($config, $token, $sign): void {
        State::$clients[0]->status = 'Inactive';
        State::$tables['tblclients'] = [
            ['id' => 19, 'status' => 'Inactive'],
            ['id' => 20, 'status' => 'Active'],
            ['id' => 21, 'status' => 'Closed'],
            ['id' => 22, 'status' => 'Suspended'],
            ['id' => 23, 'status' => 'active'],
            ['id' => 24, 'status' => 'INACTIVE'],
        ];
        State::$tables['tblproducts'] = [
            ['id' => 12, 'name' => 'Allowed service'],
            ['id' => 13, 'name' => 'Other product'],
        ];
        $row = static fn (int $id, int $client, string $status = 'Active', int $product = 12): array => [
            'id' => $id, 'userid' => $client, 'packageid' => $product,
            'domainstatus' => $status, 'nextduedate' => '2027-01-01',
        ];
        State::$tables['tblhosting'] = [
            $row(101, 19), $row(102, 20), $row(103, 21), $row(104, 22),
            $row(105, 19, 'Suspended'), $row(106, 19, 'Terminated'), $row(107, 19, 'Pending'),
            $row(108, 19, 'Active', 13),
            $row(109, 23), $row(110, 24),
        ];
        $clients = authenticate($token, $config, $sign());
        $mine = KoalaServices\findServices($clients, [12], null);
        assertBinding(array_column($mine, 'id') === [101]);
        $response = KoalaServices\api(array_replace($config, ['product_ids' => [12]]), $sign())
            ->handle(['action' => 'list'], 'Bearer ' . $token);
        assertBinding($response === ['version' => 1, 'services' => [
            ['id' => 101, 'name' => 'Allowed service', 'nextDueDate' => '2027-01-01'],
        ]]);
        // Even previously authorized IDs cannot expose Closed or noncanonical account states.
        $eligible = KoalaServices\findServices([19, 20, 21, 22, 23, 24], [12], null);
        assertBinding(array_column($eligible, 'id') === [102, 101]);
        assertBinding(KoalaServices\findServices($clients, [12], 102) === []);
        assertBinding(array_column(KoalaServices\findServices($clients, [12], 101), 'id') === [101]);
    });
    $mappingFixture = static function () use ($config): array {
        State::$tables['tblclients'] = [['id' => 19, 'status' => 'Active']];
        State::$tables['tblproducts'] = [['id' => 12, 'name' => 'Nano']];
        State::$tables['tblhosting'] = [['id' => 2330, 'userid' => 19, 'packageid' => 12,
            'domainstatus' => 'Active', 'domain' => '3079', 'nextduedate' => '2027-01-01']];
        State::$panelResponses = ['https://panel.example.com/api/users/2330' => ['status' => 404],
            'https://panel.example.com/api/users/3079' => ['status' => 200, 'body' => ['response' => [
            'id' => 3079, 'status' => 'ACTIVE', 'expireAt' => '2035-01-01T00:00:00Z',
            'subscriptionUrl' => 'https://sub.example.com/mapped-fixture',
        ]]]];
        return array_replace($config, ['product_ids' => [12], 'panel_url' => 'https://panel.example.com', 'token_encrypted' => 'encrypted-fixture']);
    };
    $test('service 2330 resolves domain 3079 only after authorization and keeps its public service ID', function () use ($mappingFixture, $token, $sign): void {
        $config = $mappingFixture();
        $response = KoalaServices\api($config, $sign())->handle(['action' => 'resolve', 'serviceId' => 2330], 'Bearer ' . $token);
        assertBinding($response === ['version' => 1, 'service' => ['id' => 2330, 'name' => 'Nano', 'nextDueDate' => '2027-01-01'],
            'subscriptionUrl' => 'https://sub.example.com/mapped-fixture']);
        assertBinding(State::$requests === ['https://whmcs.example.com/oauth/userinfo.php',
            'https://whmcs.example.com/oauth/certs.php', 'https://panel.example.com/api/users/3079']);
        assertBinding(count(State::$mappingReads) === 2);
        foreach (State::$mappingReads as $conditions) {
            assertBinding(in_array(['id', '=', 2330], $conditions, true));
            assertBinding(in_array(['userid', '=', 19], $conditions, true));
        }
    });
    $test('missing or invalid domain mappings never call Remnawave or fall back to the WHMCS service ID', function () use ($mappingFixture, $token, $sign): void {
        $config = $mappingFixture();
        foreach ([null, '', ' ', ' 3079', '3079 ', '03079', '0', '-1', '3079.0', '3e3', 'user.example.com', '9007199254740992', 3079] as $domain) {
            State::$requests = [];
            State::$tables['tblhosting'][0]['domain'] = $domain;
            try {
                KoalaServices\api($config, $sign())->handle(['action' => 'resolve', 'serviceId' => 2330], 'Bearer ' . $token);
                throw new RuntimeException('Expected invalid mapping rejection');
            } catch (ApiError $error) {
                assertBinding($error->reason === 'configuration-error' && $error->status === 503);
                assertBinding($error->diagnostic === ($domain === null || $domain === ''
                    ? 'whmcs-remnawave-mapping-missing' : 'whmcs-remnawave-mapping-invalid'));
            }
            assertBinding(!array_filter(State::$requests, static fn (string $url): bool => str_starts_with($url, 'https://panel.example.com/')));
        }
    });
    $test('listing ignores missing mappings and caller overrides cannot select a different remote user', function () use ($mappingFixture, $token, $sign): void {
        $config = $mappingFixture();
        State::$tables['tblhosting'][0]['domain'] = '';
        $api = KoalaServices\api($config, $sign());
        $response = $api->handle(['action' => 'list'], 'Bearer ' . $token);
        assertBinding(count($response['services']) === 1 && $response['services'][0]['id'] === 2330);
        foreach (['remoteUserId', 'domain', 'remnawaveUserId'] as $field) {
            deniesBinding('invalid-response', 400, fn () => $api->handle(['action' => 'resolve', 'serviceId' => 2330, $field => 3079], 'Bearer ' . $token));
        }
        State::$tables['tblhosting'][0]['userid'] = 20;
        deniesBinding('service-unavailable', 404, fn () => $api->handle(['action' => 'resolve', 'serviceId' => 2330], 'Bearer ' . $token));
        assertBinding(State::$mappingReads === []);
        assertBinding(!array_filter(State::$requests, static fn (string $url): bool => str_starts_with($url, 'https://panel.example.com/')));
    });
    $test('a wrong remote response ID and any mapping change during lookup prevent import', function () use ($mappingFixture, $token, $sign): void {
        $config = $mappingFixture();
        State::$panelResponses['https://panel.example.com/api/users/3079']['body']['response']['id'] = 2330;
        try {
            KoalaServices\api($config, $sign())->handle(['action' => 'resolve', 'serviceId' => 2330], 'Bearer ' . $token);
            throw new RuntimeException('Expected mapped ID mismatch');
        } catch (ApiError $error) {
            assertBinding($error->diagnostic === 'remnawave-id-mismatch');
        }
        foreach (['3080', '', 'invalid'] as $changed) {
            $config = $mappingFixture();
            State::$onPanelResponse = static function () use ($changed): void { State::$tables['tblhosting'][0]['domain'] = $changed; };
            try {
                KoalaServices\api($config, $sign())->handle(['action' => 'resolve', 'serviceId' => 2330], 'Bearer ' . $token);
                throw new RuntimeException('Expected mapping change rejection');
            } catch (ApiError $error) {
                assertBinding($error->reason === 'service-unavailable' && $error->diagnostic === 'whmcs-service-changed');
            }
        }
    });
    $test('numeric Remnawave lookup uses the v3 route in the configured deployment path', function (): void {
        $config = ['panel_url' => 'https://panel.example.com/remna', 'token_encrypted' => 'encrypted-fixture'];
        $modern = 'https://panel.example.com/remna/api/users/2326';
        $success = ['status' => 200, 'body' => ['response' => ['id' => 2326, 'status' => 'ACTIVE',
            'expireAt' => '2035-01-01T00:00:00Z', 'subscriptionUrl' => 'https://sub.example.com/fixture']]];
        State::$requests = [];
        State::$panelResponses = [$modern => $success];
        assertBinding(KoalaServices\resolveRemnawaveSubscription(2326, $config) === 'https://sub.example.com/fixture');
        assertBinding(State::$requests === [$modern]);
    });
    $test('Remnawave HTTP errors, network failures and invalid responses never trigger an alternative route', function (): void {
        $config = ['panel_url' => 'https://panel.example.com', 'token_encrypted' => 'encrypted-fixture'];
        $modern = 'https://panel.example.com/api/users/2326';
        foreach ([
            [['status' => 400], 'network-error', 502, 'remnawave-request-failed'],
            [['status' => 404], 'service-unavailable', 404, 'remnawave-user-not-found'],
            [['status' => 401], 'configuration-error', 503, 'remnawave-access-denied'],
            [['status' => 403], 'configuration-error', 503, 'remnawave-access-denied'],
            [['status' => 500], 'network-error', 502, 'remnawave-request-failed'],
            [['networkFailure' => true], 'network-error', 502, 'remnawave-request-failed'],
            [['status' => 200, 'rawBody' => 'malformed-fixture'], 'invalid-response', 502, 'remnawave-response-invalid'],
            [['status' => 200, 'body' => ['response' => ['id' => 9999]]], 'invalid-response', 502, 'remnawave-id-mismatch'],
        ] as [$response, $reason, $status, $diagnostic]) {
            State::$requests = [];
            State::$panelResponses = [$modern => $response];
            try {
                KoalaServices\resolveRemnawaveSubscription(2326, $config);
                throw new RuntimeException('Expected panel rejection');
            } catch (ApiError $error) {
                assertBinding($error->reason === $reason && $error->status === $status && $error->diagnostic === $diagnostic);
            }
            assertBinding(State::$requests === [$modern]);
        }
    });
    $test('invalid Remnawave configuration fails before sending a credential-bearing request', function (): void {
        foreach ([
            ['panel_url' => 'https://panel.example.com', 'token_encrypted' => 'invalid-fixture'],
            ['panel_url' => 'http://panel.example.com', 'token_encrypted' => 'encrypted-fixture'],
        ] as $config) {
            try {
                KoalaServices\resolveRemnawaveSubscription(2326, $config);
                throw new RuntimeException('Expected configuration rejection');
            } catch (ApiError $error) {
                assertBinding($error->reason === 'configuration-error' && $error->status === 503
                    && $error->diagnostic === 'remnawave-configuration-error');
            }
        }
        assertBinding(State::$requests === []);
    });
    $test('Inactive clients without services receive an empty list through the complete API adapter', function () use ($config, $token, $sign): void {
        State::$clients[0]->status = 'Inactive';
        State::$tables['tblclients'] = [['id' => 19, 'status' => 'Inactive']];
        $response = KoalaServices\api(array_replace($config, ['product_ids' => [12]]), $sign())
            ->handle(['action' => 'list'], 'Bearer ' . $token);
        assertBinding($response === ['version' => 1, 'services' => [], 'diagnostics' => [
            'version' => 1, 'reason' => 'no-owned-services', 'clientCount' => 1,
            'ownedServices' => 0, 'activeServices' => 0, 'allowedServices' => 0, 'allowedProductIds' => [12],
        ]]);
        assertBinding(State::$requests === [
            'https://whmcs.example.com/oauth/userinfo.php',
            'https://whmcs.example.com/oauth/certs.php',
        ]);
    });
    $test('empty-list diagnostics use exactly three counts scoped only to verified clients', function () use ($config, $token, $sign): void {
        $row = static fn (int $id, int $client, string $status = 'Active', int $product = 12): array => [
            'id' => $id, 'userid' => $client, 'packageid' => $product,
            'domainstatus' => $status, 'nextduedate' => '2027-01-01',
        ];
        State::$tables['tblclients'] = [['id' => 19, 'status' => 'Active'], ['id' => 20, 'status' => 'Active']];
        // No product rows: allowed services, if any, cannot survive the actual list's inner join.
        $cases = [
            [[], 'no-owned-services', [0, 0, 0]],
            [[$row(101, 19, 'Suspended')], 'no-active-services', [1, 0, 0]],
            [[$row(102, 19, 'Active', 13), $row(103, 19, 'Suspended')], 'product-not-enabled', [2, 1, 0]],
            [[$row(104, 19)], 'account-or-product-filtered', [1, 1, 1]],
        ];
        foreach ($cases as [$owned, $reason, [$total, $active, $allowed]]) {
            State::$tables['tblhosting'] = array_merge($owned, [$row(999, 20)]);
            State::$countQueries = [];
            $response = KoalaServices\api(array_replace($config, ['product_ids' => [12]]), $sign())
                ->handle(['action' => 'list'], 'Bearer ' . $token);
            assertBinding($response === ['version' => 1, 'services' => [], 'diagnostics' => [
                'version' => 1, 'reason' => $reason, 'clientCount' => 1,
                'ownedServices' => $total, 'activeServices' => $active, 'allowedServices' => $allowed,
                'allowedProductIds' => [12],
            ]]);
            assertBinding(count(State::$countQueries) === 3);
            foreach (State::$countQueries as $query) {
                assertBinding($query['table'] === 'tblhosting as h');
                assertBinding(in_array(['h.userid', 'in', [19]], $query['conditions'], true));
            }
            assertBinding(in_array(['h.domainstatus', '=', 'Active'], State::$countQueries[1]['conditions'], true));
            assertBinding(in_array(['h.packageid', 'in', [12]], State::$countQueries[2]['conditions'], true));
        }
    });
    $test('concurrent count changes and diagnostic failures never reject the original empty list', function () use ($config, $token, $sign): void {
        $api = KoalaServices\api(array_replace($config, ['product_ids' => [12]]), $sign());
        State::$countResults = [0, 1, 1];
        $response = $api->handle(['action' => 'list'], 'Bearer ' . $token);
        assertBinding($response['services'] === [] && $response['diagnostics']['reason'] === 'account-or-product-filtered');
        State::$countFails = true;
        $response = $api->handle(['action' => 'list'], 'Bearer ' . $token);
        assertBinding($response === ['version' => 1, 'services' => [], 'diagnostics' => ['version' => 1, 'reason' => 'unavailable']]);
    });
    $test('unauthenticated and resolve requests do not run aggregate service diagnostics', function () use ($config, $token, $sign): void {
        $api = KoalaServices\api(array_replace($config, ['product_ids' => [12]]), $sign());
        deniesBinding('not-signed-in', 401, fn () => $api->handle(['action' => 'list'], ''));
        deniesBinding('service-unavailable', 404, fn () => $api->handle(['action' => 'resolve', 'serviceId' => 2326], 'Bearer ' . $token));
        assertBinding(State::$countQueries === []);
    });
    $test('a unique User UUID match is diagnostic only and never grants access under Client mapping', function () use ($config, $token, $sign, $subject): void {
        State::$clients = [];
        State::$userUuidAvailable = true;
        State::$users = [(object) ['id' => 88, 'uuid' => $subject]];
        try {
            authenticate($token, $config, $sign());
        } catch (ApiError $error) {
            assertBinding($error->reason === 'access-denied' && $error->status === 403);
            assertBinding(($error->diagnostic ?? null) === 'client-uuid-matches-user');
            return;
        }
        throw new RuntimeException('Diagnostic probe must not grant authorization');
    });
    $test('valid profile-only proof issued to another app cannot create a binding', function () use ($config, $token, $sign): void {
        deniesBinding('not-signed-in', 401, fn () => authenticate($token, $config, $sign(['aud' => 'UNRELATED-APP'])));
        assertBinding(State::$writes === 0);
    });
    $test('expired proof works only after a prior successful binding and never extends its TTL', function () use ($config, $token, $sign): void {
        $proof = $sign();
        authenticate($token, $config, $proof);
        $binding = State::$tables[KoalaServices\BINDINGS_TABLE];
        State::$now += 1000;
        State::$requests = [];
        assertBinding(authenticate($token, $config, $proof) === [19]);
        assertBinding(State::$tables[KoalaServices\BINDINGS_TABLE] === $binding);
        assertBinding(State::$requests === ['https://whmcs.example.com/oauth/userinfo.php']);
        assertBinding(State::$writes === 1);
    });
    $test('expired proof without prior successful binding is rejected', function () use ($config, $token, $sign): void {
        $proof = $sign();
        State::$now += 1000;
        deniesBinding('not-signed-in', 401, fn () => authenticate($token, $config, $proof));
        assertBinding(State::$writes === 0);
    });
    $test('binding cannot be reused by a different bearer', function () use ($config, $token, $sign): void {
        $proof = $sign();
        authenticate($token, $config, $proof);
        State::$now += 1000;
        deniesBinding('not-signed-in', 401, fn () => authenticate('different-access-token', $config, $proof));
        assertBinding(State::$writes === 1);
    });
    $test('cached subject mismatch requires a fresh matching proof', function () use ($config, $token, $sign): void {
        $proof = $sign();
        authenticate($token, $config, $proof);
        State::$userInfo['body']['sub'] = 'another-verified-subject';
        deniesBinding('not-signed-in', 401, fn () => authenticate($token, $config, $proof));
        assertBinding(State::$writes === 1);
    });
    $test('revoked or expired access token cannot use a cached binding', function () use ($config, $token, $sign): void {
        authenticate($token, $config, $sign());
        foreach ([400, 401, 403] as $status) {
            State::$userInfo = ['status' => $status, 'body' => []];
            State::$bindingReads = 0;
            deniesBinding('not-signed-in', 401, fn () => authenticate($token, $config, ''));
            assertBinding(State::$bindingReads === 0);
        }
    });
    $test('userinfo failure never falls back to cached authorization', function () use ($config, $token, $sign): void {
        authenticate($token, $config, $sign());
        State::$userInfo = ['status' => 500, 'body' => []];
        State::$bindingReads = 0;
        deniesBinding('network-error', 502, fn () => authenticate($token, $config, ''));
        assertBinding(State::$bindingReads === 0);
    });
    $test('userinfo missing or malformed subject cannot use a cached binding', function () use ($config, $token, $sign): void {
        authenticate($token, $config, $sign());
        foreach ([['name' => 'Fixture'], ['sub' => ''], ['sub' => 19]] as $body) {
            State::$userInfo = ['status' => 200, 'body' => $body];
            State::$bindingReads = 0;
            deniesBinding('not-signed-in', 401, fn () => authenticate($token, $config, ''));
            assertBinding(State::$bindingReads === 0);
        }
    });
    $test('24 hour boundary requires reauthentication with a fresh proof', function () use ($config, $token, $sign): void {
        $oldProof = $sign();
        authenticate($token, $config, $oldProof);
        State::$now += 86400;
        deniesBinding('not-signed-in', 401, fn () => authenticate($token, $config, $oldProof));
        assertBinding(State::$writes === 1);
        assertBinding(authenticate($token, $config, $sign()) === [19]);
        assertBinding(State::$writes === 2 && count(State::$tables[KoalaServices\BINDINGS_TABLE]) === 1);
    });
    $test('changed client ID or issuer cannot reuse a binding', function () use ($config, $token, $sign): void {
        $proof = $sign();
        authenticate($token, $config, $proof);
        foreach (['oidc_client_id' => 'OTHER-APP', 'oidc_issuer' => 'https://other.example.com'] as $field => $value) {
            deniesBinding('not-signed-in', 401, fn () => authenticate($token, array_replace($config, [$field => $value]), $proof));
        }
        assertBinding(State::$writes === 1);
    });
    $test('closing an account denies access despite valid cached proof', function () use ($config, $token, $sign): void {
        authenticate($token, $config, $sign());
        State::$clients[0]->status = 'Closed';
        deniesBinding('access-denied', 403, fn () => authenticate($token, $config, ''));
    });
    $test('deactivating addon closes the API and clears existing attestations', function () use ($config, $token, $sign): void {
        define('WHMCS', true);
        require_once __DIR__ . '/../integrations/whmcs/modules/addons/koala_services/koala_services.php';
        KoalaServices\saveSettings(array_replace($config, ['enabled' => true,
            'product_ids' => [12], 'panel_url' => 'https://panel.example.com', 'token_encrypted' => 'encrypted-fixture']));
        authenticate($token, $config, $sign());
        assertBinding(koala_services_deactivate()['status'] === 'success');
        assertBinding(State::$tables[KoalaServices\BINDINGS_TABLE] === []);
        deniesBinding('configuration-error', 503, fn () => KoalaServices\configuredSettings());
    });
    echo 'Passed ' . $passed . ' WHMCS binding adapter tests.' . PHP_EOL;
}
