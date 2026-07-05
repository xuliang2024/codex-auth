const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexAuth", {
  platform: process.platform,
  getRegistry: () => ipcRenderer.invoke("get-registry"),
  switchAccount: (email) => ipcRenderer.invoke("switch-account", email),
  checkAccounts: () => ipcRenderer.invoke("check-accounts"),
  refreshAccountUsage: (accountKey) => ipcRenderer.invoke("refresh-account-usage", accountKey),
  loginStart: () => ipcRenderer.invoke("login-start"),
  loginApi: (opts) => ipcRenderer.invoke("login-api", opts),
  testApiEndpoint: (opts) => ipcRenderer.invoke("test-api-endpoint", opts),
  loginCancel: () => ipcRenderer.invoke("login-cancel"),
  removeAccount: (email) => ipcRenderer.invoke("remove-account", email),
  onRegistryChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("registry-changed", listener);
    return () => ipcRenderer.removeListener("registry-changed", listener);
  },
});
