(() => {
  const DOWNLOAD_OPTIONS = {
    macos: {
      href: "/downloads/codex-auth-desktop-0.1.5-universal.dmg",
      label: "下载 macOS 应用",
      title: "下载 macOS Universal DMG",
    },
    windowsX64: {
      href: "/downloads/codex-auth-desktop-0.1.5-win-x64.exe",
      label: "下载 Windows 应用",
      title: "下载 Windows x64 安装包",
    },
    windowsArm64: {
      href: "/downloads/codex-auth-desktop-0.1.5-win-arm64.exe",
      label: "下载 Windows ARM 应用",
      title: "下载 Windows ARM64 安装包",
    },
    allDownloads: {
      href: "#downloads",
      label: "查看全部下载",
      title: "查看全部下载选项",
    },
  };

  function pickDownloadOption(platform, architecture, userAgent) {
    const platformText = `${platform || ""} ${userAgent || ""}`;
    const architectureText = `${architecture || ""}`.toLowerCase();

    if (/windows|win32|win64|wow64/i.test(platformText)) {
      if (/arm|aarch64/i.test(architectureText) || /arm64/i.test(platformText)) {
        return DOWNLOAD_OPTIONS.windowsArm64;
      }

      return DOWNLOAD_OPTIONS.windowsX64;
    }

    if (/mac|darwin/i.test(platformText)) {
      return DOWNLOAD_OPTIONS.macos;
    }

    return DOWNLOAD_OPTIONS.allDownloads;
  }

  function applyDownloadOption(link, option) {
    link.href = option.href;
    link.textContent = option.label;
    link.setAttribute("aria-label", option.title);
    link.title = option.title;
  }

  async function resolveDownloadOption() {
    const userAgentData = navigator.userAgentData;
    const userAgent = navigator.userAgent || "";

    if (userAgentData && typeof userAgentData.getHighEntropyValues === "function") {
      try {
        const hints = await userAgentData.getHighEntropyValues(["architecture", "platform"]);
        return pickDownloadOption(hints.platform || userAgentData.platform, hints.architecture, userAgent);
      } catch {
        return pickDownloadOption(userAgentData.platform, "", userAgent);
      }
    }

    return pickDownloadOption(navigator.platform, "", userAgent);
  }

  async function initPrimaryDownload() {
    const primaryDownload = document.querySelector("[data-primary-download]");
    if (!primaryDownload) return;

    applyDownloadOption(primaryDownload, pickDownloadOption(navigator.platform, "", navigator.userAgent));
    applyDownloadOption(primaryDownload, await resolveDownloadOption());
  }

  initPrimaryDownload();
})();
