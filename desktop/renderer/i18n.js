// Renderer-side i18n: dictionary lookup + static DOM translation.
// Language preference persists in localStorage and defaults to the OS locale.
const I18N = (() => {
  const STORAGE_KEY = "codex-auth-language";
  const SUPPORTED = ["en", "zh", "ja"];

  const translations = {
    en: {
      "app.title": "Codex Accounts",
      "btn.addAccount": "Add Account",
      "btn.addAccount.tip": "Sign in via browser and add the account",
      "btn.addApi": "Add API",
      "btn.addApi.tip": "Add an API provider account (custom endpoint + API key)",
      "btn.refresh": "Refresh Usage",
      "btn.refresh.tip": "Refresh usage from API",
      "btn.import": "Import",
      "btn.import.tip": "Import accounts from a JSON export file",
      "btn.export": "Export",
      "btn.export.tip": "Export all accounts to a JSON file for migration",
      "btn.cancel": "Cancel",
      "btn.switch": "Switch",
      "lang.tip": "Language",

      "login.waiting": "Waiting for browser sign-in… complete the login in your browser.",

      "apiForm.title": "Add API provider account",
      "apiForm.endpoint": "Endpoint",
      "apiForm.apiKey": "API key",
      "apiForm.name": "Name",
      "apiForm.model": "Model",
      "apiForm.name.placeholder": "optional, e.g. apiz",
      "apiForm.model.placeholder": "optional, e.g. gpt-5.5",
      "apiForm.test": "Test Endpoint",
      "apiForm.save": "Add & Switch",

      "empty.title": "No accounts found",
      "empty.hint": "Click <code>Add Account</code> to sign in with your browser and add your first account.",

      "summary.accountOne": "1 account",
      "summary.accountMany": "{count} accounts",
      "summary.expired": "{count} expired",
      "summary.active": "active: {email}",
      "summary.none": "none",
      "summary.noAccounts": "no accounts",

      "reset.soon": "resets soon",
      "reset.minutes": "resets in {m}m",
      "reset.hours": "resets in {h}h {m}m",
      "reset.days": "resets in {d}d",

      "ago.justNow": "just now",
      "ago.minutes": "{m}m ago",
      "ago.hours": "{h}h ago",
      "ago.days": "{d}d ago",

      "usage.fiveHour": "5 hour",
      "usage.weekly": "Weekly",
      "usage.updated": "usage updated {ago}",
      "usage.none": "No usage data — click Refresh Usage",

      "badge.expired": "✕ Expired",
      "badge.active": "● Active",
      "card.refreshOne.tip": "Refresh usage for this account",
      "card.testApi": "Test",
      "card.testApi.tip": "Test this saved API endpoint",
      "card.remove.tip": "Remove account",
      "card.apiProvider": "API provider{base} — usage tracking is not available",
      "card.sessionExpired": "Session expired — sign in again with Add Account.",

      "confirm.ok": "OK",
      "confirm.removeTitle": "Remove {email}?",
      "confirm.removeMessage": "The stored auth file for this account will be deleted.",
      "confirm.remove": "Remove",
      "confirm.importTitle": "Import accounts?",
      "confirm.importMessage": "Accounts from the file will be added. If an account already exists, its stored auth will be overwritten by the imported one.",
      "confirm.import": "Choose File…",
      "confirm.testFailedTitle": "Endpoint test failed",
      "confirm.testFailedMessage": "{error}\n\nAdd this API provider account anyway?",
      "confirm.addAnyway": "Add Anyway",

      "toast.usageRefreshedFor": "Usage refreshed for {email}",
      "toast.switched": "Switched to {email}",
      "toast.removed": "Removed {email}",
      "toast.accountAdded": "Account added",
      "toast.usageRefreshed": "Usage refreshed",
      "toast.refreshedExpiredOne": "Usage refreshed — 1 account expired",
      "toast.refreshedExpiredMany": "Usage refreshed — {count} accounts expired",
      "toast.checkFailed": "Account check failed",
      "toast.apiRequired": "Endpoint URL and API key are required",
      "toast.apiAdded": "API provider account added and activated",

      "api.enterFirst": "Enter the endpoint URL and API key first.",
      "api.testing": "Testing endpoint…",
      "api.testingBeforeAdd": "Testing endpoint before adding…",
      "api.ok": "✓ Endpoint OK (HTTP {status})",
      "api.okAdding": "✓ Endpoint OK (HTTP {status}) — adding account…",

      "toast.exported": "Exported {count} accounts",
      "toast.exportedPartial": "Exported {count} accounts — {missing} skipped (no stored auth)",
      "toast.exportFailed": "Export failed",
      "toast.imported": "Import complete — {added} added, {updated} updated",
      "toast.importFailed": "Import failed",
    },
    zh: {
      "app.title": "Codex 账户",
      "btn.addAccount": "添加账户",
      "btn.addAccount.tip": "通过浏览器登录并添加账户",
      "btn.addApi": "添加 API",
      "btn.addApi.tip": "添加 API 提供商账户（自定义接入点 + API 密钥）",
      "btn.refresh": "刷新用量",
      "btn.refresh.tip": "从 API 刷新用量",
      "btn.import": "导入",
      "btn.import.tip": "从 JSON 导出文件导入账户",
      "btn.export": "导出",
      "btn.export.tip": "将全部账户导出为 JSON 文件，便于迁移",
      "btn.cancel": "取消",
      "btn.switch": "切换",
      "lang.tip": "语言",

      "login.waiting": "等待浏览器登录……请在浏览器中完成登录。",

      "apiForm.title": "添加 API 提供商账户",
      "apiForm.endpoint": "接入点",
      "apiForm.apiKey": "API 密钥",
      "apiForm.name": "名称",
      "apiForm.model": "模型",
      "apiForm.name.placeholder": "可选，例如 apiz",
      "apiForm.model.placeholder": "可选，例如 gpt-5.5",
      "apiForm.test": "测试接入点",
      "apiForm.save": "添加并切换",

      "empty.title": "未找到账户",
      "empty.hint": "点击「添加账户」通过浏览器登录，添加第一个账户。",

      "summary.accountOne": "1 个账户",
      "summary.accountMany": "{count} 个账户",
      "summary.expired": "{count} 个已过期",
      "summary.active": "当前账户：{email}",
      "summary.none": "无",
      "summary.noAccounts": "暂无账户",

      "reset.soon": "即将重置",
      "reset.minutes": "{m} 分钟后重置",
      "reset.hours": "{h} 小时 {m} 分钟后重置",
      "reset.days": "{d} 天后重置",

      "ago.justNow": "刚刚",
      "ago.minutes": "{m} 分钟前",
      "ago.hours": "{h} 小时前",
      "ago.days": "{d} 天前",

      "usage.fiveHour": "5 小时",
      "usage.weekly": "每周",
      "usage.updated": "用量更新于 {ago}",
      "usage.none": "暂无用量数据——点击「刷新用量」",

      "badge.expired": "✕ 已过期",
      "badge.active": "● 当前",
      "card.refreshOne.tip": "刷新该账户的用量",
      "card.testApi": "测试",
      "card.testApi.tip": "测试这个已保存的 API 接入点",
      "card.remove.tip": "移除账户",
      "card.apiProvider": "API 提供商{base}——不支持用量统计",
      "card.sessionExpired": "会话已过期——请通过「添加账户」重新登录。",

      "confirm.ok": "确定",
      "confirm.removeTitle": "移除 {email}？",
      "confirm.removeMessage": "该账户存储的认证文件将被删除。",
      "confirm.remove": "移除",
      "confirm.importTitle": "导入账户？",
      "confirm.importMessage": "文件中的账户将被添加。若账户已存在，其本地存储的认证信息将被导入内容覆盖。",
      "confirm.import": "选择文件……",
      "confirm.testFailedTitle": "接入点测试失败",
      "confirm.testFailedMessage": "{error}\n\n仍然添加该 API 提供商账户？",
      "confirm.addAnyway": "仍然添加",

      "toast.usageRefreshedFor": "已刷新 {email} 的用量",
      "toast.switched": "已切换到 {email}",
      "toast.removed": "已移除 {email}",
      "toast.accountAdded": "账户已添加",
      "toast.usageRefreshed": "用量已刷新",
      "toast.refreshedExpiredOne": "用量已刷新——1 个账户已过期",
      "toast.refreshedExpiredMany": "用量已刷新——{count} 个账户已过期",
      "toast.checkFailed": "账户检查失败",
      "toast.apiRequired": "接入点 URL 和 API 密钥为必填项",
      "toast.apiAdded": "API 提供商账户已添加并激活",

      "api.enterFirst": "请先输入接入点 URL 和 API 密钥。",
      "api.testing": "正在测试接入点……",
      "api.testingBeforeAdd": "添加前正在测试接入点……",
      "api.ok": "✓ 接入点正常（HTTP {status}）",
      "api.okAdding": "✓ 接入点正常（HTTP {status}）——正在添加账户……",

      "toast.exported": "已导出 {count} 个账户",
      "toast.exportedPartial": "已导出 {count} 个账户——{missing} 个已跳过（无认证数据）",
      "toast.exportFailed": "导出失败",
      "toast.imported": "导入完成——新增 {added} 个，更新 {updated} 个",
      "toast.importFailed": "导入失败",
    },
    ja: {
      "app.title": "Codex アカウント",
      "btn.addAccount": "アカウント追加",
      "btn.addAccount.tip": "ブラウザでサインインしてアカウントを追加",
      "btn.addApi": "API 追加",
      "btn.addApi.tip": "API プロバイダーアカウントを追加（カスタムエンドポイント + API キー）",
      "btn.refresh": "使用量を更新",
      "btn.refresh.tip": "API から使用量を更新",
      "btn.import": "インポート",
      "btn.import.tip": "JSON エクスポートファイルからアカウントをインポート",
      "btn.export": "エクスポート",
      "btn.export.tip": "移行用にすべてのアカウントを JSON ファイルへエクスポート",
      "btn.cancel": "キャンセル",
      "btn.switch": "切替",
      "lang.tip": "言語",

      "login.waiting": "ブラウザでのサインインを待っています…ブラウザでログインを完了してください。",

      "apiForm.title": "API プロバイダーアカウントを追加",
      "apiForm.endpoint": "エンドポイント",
      "apiForm.apiKey": "API キー",
      "apiForm.name": "名前",
      "apiForm.model": "モデル",
      "apiForm.name.placeholder": "任意、例: apiz",
      "apiForm.model.placeholder": "任意、例: gpt-5.5",
      "apiForm.test": "エンドポイントをテスト",
      "apiForm.save": "追加して切替",

      "empty.title": "アカウントが見つかりません",
      "empty.hint": "「アカウント追加」をクリックしてブラウザでサインインし、最初のアカウントを追加してください。",

      "summary.accountOne": "アカウント 1 件",
      "summary.accountMany": "アカウント {count} 件",
      "summary.expired": "{count} 件期限切れ",
      "summary.active": "アクティブ: {email}",
      "summary.none": "なし",
      "summary.noAccounts": "アカウントなし",

      "reset.soon": "まもなくリセット",
      "reset.minutes": "{m} 分後にリセット",
      "reset.hours": "{h} 時間 {m} 分後にリセット",
      "reset.days": "{d} 日後にリセット",

      "ago.justNow": "たった今",
      "ago.minutes": "{m} 分前",
      "ago.hours": "{h} 時間前",
      "ago.days": "{d} 日前",

      "usage.fiveHour": "5 時間",
      "usage.weekly": "週間",
      "usage.updated": "使用量の更新: {ago}",
      "usage.none": "使用量データなし——「使用量を更新」をクリック",

      "badge.expired": "✕ 期限切れ",
      "badge.active": "● アクティブ",
      "card.refreshOne.tip": "このアカウントの使用量を更新",
      "card.testApi": "テスト",
      "card.testApi.tip": "保存済み API エンドポイントをテスト",
      "card.remove.tip": "アカウントを削除",
      "card.apiProvider": "API プロバイダー{base}——使用量の取得はできません",
      "card.sessionExpired": "セッションの有効期限が切れました——「アカウント追加」で再ログインしてください。",

      "confirm.ok": "OK",
      "confirm.removeTitle": "{email} を削除しますか？",
      "confirm.removeMessage": "このアカウントの保存済み認証ファイルが削除されます。",
      "confirm.remove": "削除",
      "confirm.importTitle": "アカウントをインポートしますか？",
      "confirm.importMessage": "ファイル内のアカウントが追加されます。既存のアカウントは、保存済みの認証情報がインポート内容で上書きされます。",
      "confirm.import": "ファイルを選択…",
      "confirm.testFailedTitle": "エンドポイントのテストに失敗しました",
      "confirm.testFailedMessage": "{error}\n\nこの API プロバイダーアカウントをそのまま追加しますか？",
      "confirm.addAnyway": "そのまま追加",

      "toast.usageRefreshedFor": "{email} の使用量を更新しました",
      "toast.switched": "{email} に切り替えました",
      "toast.removed": "{email} を削除しました",
      "toast.accountAdded": "アカウントを追加しました",
      "toast.usageRefreshed": "使用量を更新しました",
      "toast.refreshedExpiredOne": "使用量を更新しました——1 件のアカウントが期限切れです",
      "toast.refreshedExpiredMany": "使用量を更新しました——{count} 件のアカウントが期限切れです",
      "toast.checkFailed": "アカウントの確認に失敗しました",
      "toast.apiRequired": "エンドポイント URL と API キーは必須です",
      "toast.apiAdded": "API プロバイダーアカウントを追加して有効化しました",

      "api.enterFirst": "先にエンドポイント URL と API キーを入力してください。",
      "api.testing": "エンドポイントをテスト中…",
      "api.testingBeforeAdd": "追加前にエンドポイントをテスト中…",
      "api.ok": "✓ エンドポイント OK（HTTP {status}）",
      "api.okAdding": "✓ エンドポイント OK（HTTP {status}）——アカウントを追加中…",

      "toast.exported": "{count} 件のアカウントをエクスポートしました",
      "toast.exportedPartial": "{count} 件をエクスポート——{missing} 件をスキップ（認証データなし）",
      "toast.exportFailed": "エクスポートに失敗しました",
      "toast.imported": "インポート完了——追加 {added} 件、更新 {updated} 件",
      "toast.importFailed": "インポートに失敗しました",
    },
  };

  function detectLanguage() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (SUPPORTED.includes(stored)) return stored;
    const locale = (navigator.language || "en").toLowerCase();
    if (locale.startsWith("zh")) return "zh";
    if (locale.startsWith("ja")) return "ja";
    return "en";
  }

  let current = detectLanguage();

  function t(key, params) {
    let str = translations[current]?.[key] ?? translations.en[key] ?? key;
    if (params) {
      for (const [name, value] of Object.entries(params)) {
        str = str.replaceAll(`{${name}}`, String(value));
      }
    }
    return str;
  }

  // Translates every element carrying a data-i18n* attribute.
  function apply() {
    document.documentElement.lang = current;
    for (const el of document.querySelectorAll("[data-i18n]")) {
      el.textContent = t(el.dataset.i18n);
    }
    for (const el of document.querySelectorAll("[data-i18n-html]")) {
      el.innerHTML = t(el.dataset.i18nHtml);
    }
    for (const el of document.querySelectorAll("[data-i18n-title]")) {
      el.title = t(el.dataset.i18nTitle);
    }
    for (const el of document.querySelectorAll("[data-i18n-placeholder]")) {
      el.placeholder = t(el.dataset.i18nPlaceholder);
    }
  }

  function set(lang) {
    if (!SUPPORTED.includes(lang)) return;
    current = lang;
    localStorage.setItem(STORAGE_KEY, lang);
    apply();
  }

  return { t, apply, set, get: () => current, supported: SUPPORTED };
})();

const t = I18N.t;
