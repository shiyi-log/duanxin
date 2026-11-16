(() => {
  const localUsb = ["localhost", "127.0.0.1"].includes(location.hostname);
  const $ = (selector) => document.querySelector(selector);
  const form = $("#config-form");
  const fieldset = form.querySelector("fieldset");
  const notice = $("#notice");
  const logOutput = $("#log-output");
  let adminPassword = "";
  let port = null;
  let writer = null;
  let reader = null;
  let cleanupPromise = null;
  let serialBuffer = "";
  let sequence = 0;
  const pending = new Map();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function setNotice(message, error = false) {
    notice.textContent = message;
    notice.classList.toggle("error", error);
  }

  function setConnected(connected, message) {
    const badge = $("#connection-state");
    badge.textContent = message || (connected ? "已连接" : "未连接");
    badge.className = `state ${connected ? "state-online" : "state-idle"}`;
    fieldset.disabled = !connected;
    $("#save-button").disabled = !connected;
    $("#export-button").disabled = !connected;
    $("#reboot-button").disabled = !connected;
    $("#reset-button").disabled = !connected;
    $("#disconnect-button").classList.toggle("hidden", !connected || !localUsb);
  }

  async function serialRequest(payload) {
    if (!writer) throw new Error("USB 尚未连接");
    const id = String(++sequence);
    payload.v = 1;
    payload.id = id;
    return new Promise(async (resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("设备响应超时"));
      }, 8000);
      pending.set(id, {resolve, reject, timer});
      try {
        await writer.write(encoder.encode(`${JSON.stringify(payload)}\r\n`));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  async function readSerial() {
    try {
      const textStream = port.readable.pipeThrough(new TextDecoderStream());
      reader = textStream.getReader();
      while (true) {
        const {value, done} = await reader.read();
        if (done) break;
        serialBuffer += value;
        let newline;
        while ((newline = serialBuffer.indexOf("\n")) >= 0) {
          const line = serialBuffer.slice(0, newline).replace(/\r$/, "");
          serialBuffer = serialBuffer.slice(newline + 1);
          if (!line) continue;
          if (line.startsWith("@")) {
            try {
              const response = JSON.parse(line.slice(1));
              const entry = pending.get(String(response.id));
              if (entry) {
                clearTimeout(entry.timer);
                pending.delete(String(response.id));
                response.ok ? entry.resolve(response.data) : entry.reject(new Error(response.error || "命令失败"));
              }
            } catch (_) {
              appendLog(line);
            }
          } else {
            appendLog(line);
          }
        }
      }
    } catch (error) {
      appendLog(`USB 读取结束：${error.message}`);
    } finally {
      await cleanupUsb();
    }
  }

  async function cleanupUsb() {
    if (cleanupPromise) return cleanupPromise;

    const activePort = port;
    const activeReader = reader;
    const activeWriter = writer;
    port = null;
    reader = null;
    writer = null;
    cleanupPromise = (async () => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("USB 已断开"));
      }
      pending.clear();
      serialBuffer = "";

      if (activeReader) {
        try { await activeReader.cancel(); } catch (_) {}
        try { activeReader.releaseLock(); } catch (_) {}
      }
      if (activeWriter) {
        try { activeWriter.releaseLock(); } catch (_) {}
      }
      if (activePort) {
        try { await activePort.close(); } catch (_) {}
      }
      setConnected(false);
    })();

    try {
      await cleanupPromise;
    } finally {
      cleanupPromise = null;
    }
  }

  function appendLog(line) {
    const cleaned = line.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
    logOutput.textContent += `${cleaned}\n`;
    const lines = logOutput.textContent.split("\n");
    if (lines.length > 400) logOutput.textContent = `${lines.slice(-400).join("\n")}`;
    logOutput.scrollTop = logOutput.scrollHeight;
  }

  async function request(payload) {
    if (localUsb) return serialRequest(payload);
    const response = await fetch("/api/maintenance", {
      method: "POST",
      headers: {"Content-Type": "application/json", "X-Admin-Password": adminPassword},
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`);
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || "命令失败");
    return result.data;
  }

  function setFormValue(key, value) {
    const input = form.elements.namedItem(key);
    if (input && value !== null && value !== undefined) input.value = String(value);
  }

  async function loadStatus() {
    try {
      const data = await request({op: "status"});
      $("#status-version").textContent = data.version || "--";
      $("#status-mode").textContent = data.mode === "cellular" ? "4G" : data.mode === "wifi" ? "Wi-Fi" : "--";
      $("#status-wifi").textContent = data.wifi_connected ? "已连接" : "未连接";
      $("#status-safe").textContent = data.safe_mode ? "是" : "否";
      if (!data.config_valid) setNotice(data.reason || "配置尚未完成", true);
      else if (data.safe_mode) setNotice(data.reason || "设备处于救援模式", true);
      return data;
    } catch (error) {
      setNotice(error.message, true);
      throw error;
    }
  }

  async function loadConfig() {
    const data = await request({op: "config.get"});
    for (const [key, value] of Object.entries(data)) {
      if (!key.endsWith("_configured")) setFormValue(key, value);
      if (key.endsWith("_configured")) {
        const input = form.elements.namedItem(key.slice(0, -11));
        if (input && value) input.placeholder = "已保存；留空保持不变";
      }
    }
    fieldset.disabled = false;
    $("#save-button").disabled = false;
    setNotice(`已读取配置 · 第 ${data.generation || 0} 代`);
  }

  async function loadLogs() {
    const data = await request({op: "logs"});
    logOutput.textContent = Array.isArray(data) ? data.join("\n") : "";
    logOutput.scrollTop = logOutput.scrollHeight;
  }

  async function refreshAll() {
    await loadStatus();
    if (localUsb || adminPassword) {
      try { await loadConfig(); await loadLogs(); } catch (error) { setNotice(error.message, true); }
    }
  }

  async function connectUsb() {
    if (!("serial" in navigator)) {
      setNotice("此浏览器不支持 WebSerial；请使用桌面版 Chrome 或 Edge。", true);
      return;
    }
    try {
      port = await navigator.serial.requestPort();
      await port.open({baudRate: 115200});
      writer = port.writable.getWriter();
      setConnected(true, "USB 已连接");
      readSerial();
      await new Promise(resolve => setTimeout(resolve, 250));
      await refreshAll();
    } catch (error) {
      await cleanupUsb();
      setConnected(false, "连接失败");
      setNotice(error.message, true);
    }
  }

  async function disconnectUsb() {
    await cleanupUsb();
  }

  function formValue(key) {
    const input = form.elements.namedItem(key);
    return input ? input.value : "";
  }

  async function saveConfig() {
    const secretKeys = new Set(Array.from(form.querySelectorAll("[data-clear]"), node => node.dataset.clear));
    const fields = Array.from(form.querySelectorAll("[name]")).map(input => input.name);
    for (const key of fields) {
      const value = formValue(key);
      const secret = secretKeys.has(key);
      const clear = form.querySelector(`[data-clear="${key}"]`);
      if (secret && !value && !(clear && clear.checked)) continue;
      await request(clear && clear.checked && !value
        ? {op: "config.clear", key}
        : {op: "config.set", key, value});
    }
    const saved = await request({op: "config.save"});
    if (!localUsb && formValue("web_admin_password")) adminPassword = formValue("web_admin_password");
    setNotice(`配置已保存 · 第 ${saved.generation} 代。重启后应用网络变更。`);
    form.querySelectorAll("[data-clear]").forEach(node => { node.checked = false; });
    await loadStatus();
  }

  async function exportConfig() {
    const data = await request({op: "config.export"});
    const blob = new Blob([JSON.stringify(data, null, 2)], {type: "application/json"});
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "wifi-forwarder-config.json";
    link.click();
    URL.revokeObjectURL(link.href);
    setNotice("配置已导出。导出文件包含密钥，请妥善保管。");
  }

  async function importConfig(file) {
    const config = JSON.parse(await file.text());
    const result = await request({op: "config.import", config});
    await loadConfig();
    setNotice(`配置已导入并保存 · 第 ${result.generation} 代。重启后应用变更。`);
  }

  async function uploadFirmware(file) {
    if (localUsb) throw new Error("固件上传请连接设备配置 AP 后通过网页执行。");
    const response = await fetch("/api/ota", {
      method: "POST",
      headers: {"Content-Type": "application/octet-stream", "X-Admin-Password": adminPassword},
      body: file,
    });
    if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`);
    setNotice("固件已验证，设备正在重启。");
  }

  $("#refresh-button").addEventListener("click", () => refreshAll().catch(error => setNotice(error.message, true)));
  $("#logs-button").addEventListener("click", () => loadLogs().catch(error => setNotice(error.message, true)));
  $("#connect-button").addEventListener("click", connectUsb);
  $("#disconnect-button").addEventListener("click", disconnectUsb);
  $("#save-button").addEventListener("click", () => saveConfig().catch(error => setNotice(error.message, true)));
  $("#export-button").addEventListener("click", () => exportConfig().catch(error => setNotice(error.message, true)));
  $("#reboot-button").addEventListener("click", async () => {
    try { await request({op: "reboot"}); setNotice("设备正在重启。"); }
    catch (error) { setNotice(error.message, true); }
  });
  $("#reset-button").addEventListener("click", async () => {
    if (!confirm("恢复默认配置？此操作会清除当前设置。")) return;
    try { await request({op: "config.reset", confirm: true}); setNotice("默认配置已写入，请重新启动设备。"); }
    catch (error) { setNotice(error.message, true); }
  });
  $("#login-form").addEventListener("submit", async event => {
    event.preventDefault();
    adminPassword = $("#admin-password").value;
    try {
      const status = await loadStatus();
      await loadConfig();
      await loadLogs();
      $("#login-form").classList.add("hidden");
      $("#ota-section").classList.remove("hidden");
      $("#connection-state").textContent = status.safe_mode ? "救援模式" : "已连接";
      $("#connection-state").className = `state ${status.safe_mode ? "state-error" : "state-online"}`;
      setConnected(true);
    } catch (error) { adminPassword = ""; setNotice(error.message, true); }
  });
  $("#import-file").addEventListener("change", event => {
    const file = event.target.files[0];
    if (file) importConfig(file).catch(error => setNotice(error.message, true));
    event.target.value = "";
  });
  $("#ota-form").addEventListener("submit", event => {
    event.preventDefault();
    const file = $("#firmware-file").files[0];
    if (file && confirm(`上传 ${file.name} 并重启？`)) uploadFirmware(file).catch(error => setNotice(error.message, true));
  });

  if (localUsb) {
    $("#usb-transport").classList.remove("hidden");
    $("#login-form").classList.add("hidden");
    $("#ota-section").classList.add("hidden");
    $("#connection-state").textContent = "USB 未连接";
  } else {
    $("#login-form").classList.remove("hidden");
    $("#usb-transport").classList.add("hidden");
    $("#ota-section").classList.remove("hidden");
    loadStatus().catch(() => {});
  }
})();
