<?php
declare(strict_types=1);

if (!defined('WHMCS')) {
    http_response_code(403);
    exit;
}

use WHMCS\Database\Capsule;

require_once __DIR__ . '/lib/WhmcsAdapter.php';

function koala_services_config(): array
{
    return [
        'name' => 'Koala Services',
        'description' => '在 Koala 账号弹窗中列出本人的可用服务，并从 Remnawave 导入订阅。启用后在 Addons → Koala Services 配置。',
        'version' => KoalaServices\ADDON_VERSION,
        'author' => 'COOLGO',
        'language' => 'english',
        'fields' => [],
    ];
}

function koala_services_activate(): array
{
    try {
        if (!Capsule::schema()->hasTable(KoalaServices\SETTINGS_TABLE)) {
            Capsule::schema()->create(KoalaServices\SETTINGS_TABLE, static function ($table): void {
                $table->integer('id')->primary();
                $table->text('settings');
            });
        }
        if (!Capsule::schema()->hasTable(KoalaServices\BINDINGS_TABLE)) {
            Capsule::schema()->create(KoalaServices\BINDINGS_TABLE, static function ($table): void {
                $table->string('token_hash', 64)->primary();
                $table->string('subject_hash', 64);
                $table->unsignedBigInteger('expires_at')->index();
            });
        }
        return ['status' => 'success', 'description' => '已启用。请为管理员角色授权访问，然后到 Addons → Koala Services 完成设置。'];
    } catch (Throwable) {
        return ['status' => 'error', 'description' => '无法初始化插件设置表，请检查数据库建表权限。'];
    }
}

function koala_services_deactivate(): array
{
    try {
        $settings = KoalaServices\loadSettings();
        $settings['enabled'] = false;
        KoalaServices\saveSettings($settings);
        Capsule::table(KoalaServices\BINDINGS_TABLE)->delete();
        return ['status' => 'success', 'description' => '接口已关闭；设置保留，重新启用后需手动开启接口。'];
    } catch (Throwable) {
        return ['status' => 'error', 'description' => '无法关闭接口，请检查数据库连接后重试。'];
    }
}

function koala_services_output(array $vars): void
{
    if (empty($_SESSION['adminid'])) {
        http_response_code(403);
        return;
    }
    $escape = static fn (mixed $value): string => htmlspecialchars((string) $value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    if (empty($_SESSION['koala_services_csrf'])) {
        $_SESSION['koala_services_csrf'] = bin2hex(random_bytes(32));
    }
    $message = '';
    $failed = false;
    try {
        $settings = KoalaServices\loadSettings();
        if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST' && ($_POST['koala_action'] ?? '') === 'save') {
            if (!is_string($_POST['koala_csrf'] ?? null)
                || !hash_equals($_SESSION['koala_services_csrf'], $_POST['koala_csrf'])) {
                throw new RuntimeException('页面已过期，请刷新后重试。');
            }
            $panel = KoalaServices\httpsUrl(trim((string) ($_POST['panel_url'] ?? '')), true);
            $productText = trim((string) ($_POST['product_ids'] ?? ''));
            if (!preg_match('/\A[1-9][0-9]*(?:\s*,\s*[1-9][0-9]*)*\z/D', $productText) || strlen($productText) > 2000) {
                throw new RuntimeException('请输入允许导入的 WHMCS 商品 ID，多个用英文逗号分隔。');
            }
            $products = array_values(array_unique(array_map('intval', explode(',', $productText))));
            if (count($products) > 100) {
                throw new RuntimeException('最多配置 100 个商品。');
            }
            foreach ($products as $productId) {
                if ($productId < 1 || $productId > 9007199254740991) {
                    throw new RuntimeException('商品 ID 必须是有效的正整数。');
                }
            }
            $kind = $_POST['subject_kind'] ?? '';
            if (!in_array($kind, ['client_uuid', 'user_uuid'], true)) {
                throw new RuntimeException('请先核实 OIDC sub 的对应字段，再选择身份映射。');
            }
            if (!Capsule::schema()->hasColumn($kind === 'client_uuid' ? 'tblclients' : 'tblusers', 'uuid')) {
                throw new RuntimeException('此实例没有所选身份类型的 UUID 字段，请核实映射。');
            }
            $oidcClientId = trim((string) ($_POST['oidc_client_id'] ?? ''));
            if (!preg_match('/\A[\x21-\x7e]{1,255}\z/D', $oidcClientId)) {
                throw new RuntimeException('请填写 Koala 的 OpenID Connect Client ID。');
            }
            $oidcIssuer = trim((string) ($_POST['oidc_issuer'] ?? ''));
            KoalaServices\httpsUrl($oidcIssuer, true);
            $token = trim((string) ($_POST['panel_token'] ?? ''));
            $encrypted = $settings['token_encrypted'] ?? '';
            if ($token !== '') {
                if (!preg_match('/\A[\x21-\x7e]{1,8192}\z/D', $token)) {
                    throw new RuntimeException('API Token 格式无效。');
                }
                $encrypted = encrypt($token);
            }
            if ($encrypted === '') {
                throw new RuntimeException('首次配置请填写 Remnawave API Token。');
            }
            $settings = [
                'enabled' => isset($_POST['enabled']),
                'panel_url' => $panel,
                'product_ids' => $products,
                'subject_kind' => $kind,
                'oidc_client_id' => $oidcClientId,
                'oidc_issuer' => $oidcIssuer,
                'token_encrypted' => $encrypted,
            ];
            KoalaServices\saveSettings($settings);
            $message = '设置已保存。';
        }
    } catch (Throwable $error) {
        $settings ??= [];
        $failed = true;
        // Only locally authored validation messages may be shown; database/HTTP errors are hidden.
        $message = get_class($error) === RuntimeException::class
            ? $error->getMessage() : '无法保存设置，请检查 HTTPS 地址与插件数据库状态。';
    }
    if ($message !== '') {
        echo '<div class="alert alert-' . ($failed ? 'danger' : 'success') . '">' . $escape($message) . '</div>';
    }
    echo '<div style="max-width:760px"><h2>Koala Services</h2>';
    echo '<div class="alert alert-info">版本 ' . $escape(KoalaServices\ADDON_VERSION)
        . '：若 Koala 无法获取服务或导入失败，请在客户端重试一次，然后到 Configuration → System Logs → Activity Log 搜索 <code>Koala Services</code>。'
        . '日志会显示身份验证或导入失败的诊断码，不记录令牌、邮箱或订阅链接。</div>';
    echo '<p>每次打开 Koala 的已登录弹窗时读取服务，用户点击导入后取得对应 Remnawave 订阅。</p>';
    echo '<form method="post" action="' . $escape($vars['modulelink']) . '">';
    if (function_exists('generate_token')) {
        echo generate_token('form');
    }
    echo '<input type="hidden" name="koala_action" value="save">';
    echo '<input type="hidden" name="koala_csrf" value="' . $escape($_SESSION['koala_services_csrf']) . '">';
    echo '<div class="checkbox"><label><input type="checkbox" name="enabled" value="1"'
        . (!empty($settings['enabled']) ? ' checked' : '') . '>开启 Koala 服务接口</label></div>';
    echo '<div class="form-group"><label>Remnawave 面板地址（HTTPS，不含 /api）</label>';
    echo '<input class="form-control" type="url" name="panel_url" required value="' . $escape($settings['panel_url'] ?? '') . '" placeholder="https://panel.example.com"></div>';
    echo '<div class="form-group"><label>Remnawave API Token</label>';
    echo '<input class="form-control" type="password" name="panel_token" autocomplete="new-password" value="">';
    echo '<p class="help-block">' . (!empty($settings['token_encrypted']) ? '已配置，留空保留原值。' : '首次配置必填。')
        . ' 使用 WHMCS 加密保存；只需查询用户权限，永不发送给 Koala。</p></div>';
    echo '<div class="form-group"><label>允许导入的 WHMCS 商品 ID</label>';
    echo '<input class="form-control" name="product_ids" required value="' . $escape(implode(',', $settings['product_ids'] ?? [])) . '" placeholder="例如 12,15">';
    echo '<p class="help-block">填写商品定义的 ID（pid），不是某位客户的服务 ID。仅这些商品下状态 Active 的服务可导入。</p></div>';
    echo '<div class="form-group"><label>OIDC 身份映射</label><select class="form-control" name="subject_kind" required>';
    foreach (['' => '请选择已核实的映射', 'client_uuid' => 'sub 对应 WHMCS 客户 UUID（Client）', 'user_uuid' => 'sub 对应 WHMCS 用户 UUID（User，仅本人拥有的客户账户）'] as $value => $label) {
        echo '<option value="' . $escape($value) . '"' . (($settings['subject_kind'] ?? '') === $value ? ' selected' : '') . '>' . $escape($label) . '</option>';
    }
    echo '</select><p class="help-block">WHMCS 未公开保证 sub 与数据库 UUID 的对应方式。请核实本实例后选择；无法匹配时拒绝访问，不按邮箱或数字 ID 猜测。</p></div>';
    echo '<div class="form-group"><label>Koala OpenID Connect Client ID</label>';
    echo '<input class="form-control" name="oidc_client_id" required value="' . $escape($settings['oidc_client_id'] ?? KoalaServices\DEFAULT_CLIENT_ID) . '">';
    echo '<p class="help-block">只接受签发给此应用的身份凭证。这里不需要填写 Client Secret。</p></div>';
    echo '<div class="form-group"><label>OpenID Connect Issuer</label>';
    echo '<input class="form-control" name="oidc_issuer" required value="' . $escape($settings['oidc_issuer'] ?? KoalaServices\DEFAULT_ISSUER) . '">';
    echo '<p class="help-block">须与 WHMCS 发现文档中的 issuer 完全一致，当前 COOLGO 实例公布的是 https://www.coolgo.network。</p></div>';
    echo '<p>映射规则：WHMCS 服务的 <code>Domain</code> 字段保存 Remnawave 数字用户 ID，由开通模块或管理员维护。例如服务 2330 的 Domain 为 3079，则查询面板用户 3079。使用 Remnawave 3.4+ 的 <code>GET /api/users/{userId}</code>，核对返回的用户 ID 后取得订阅地址；未配置有效 Domain 的服务不能导入。</p>';
    echo '<button type="submit" class="btn btn-primary">保存设置</button></form></div>';
}
