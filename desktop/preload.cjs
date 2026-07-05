const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexAuth", {
  platform: process.platform,
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  getRegistry: () => ipcRenderer.invoke("get-registry"),
  switchAccount: (email) => ipcRenderer.invoke("switch-account", email),
  checkAccounts: () => ipcRenderer.invoke("check-accounts"),
  refreshAccountUsage: (accountKey) => ipcRenderer.invoke("refresh-account-usage", accountKey),
  loginStart: () => ipcRenderer.invoke("login-start"),
  loginApi: (opts) => ipcRenderer.invoke("login-api", opts),
  testApiEndpoint: (opts) => ipcRenderer.invoke("test-api-endpoint", opts),
  testProviderAccount: (accountKey) => ipcRenderer.invoke("test-provider-account", accountKey),
  loginCancel: () => ipcRenderer.invoke("login-cancel"),
  removeAccount: (email) => ipcRenderer.invoke("remove-account", email),
  exportAccounts: () => ipcRenderer.invoke("export-accounts"),
  importAccounts: () => ipcRenderer.invoke("import-accounts"),
  onRegistryChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("registry-changed", listener);
    return () => ipcRenderer.removeListener("registry-changed", listener);
  },
});
