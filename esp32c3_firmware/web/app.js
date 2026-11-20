(() => {
  const localUsb = ["localhost", "127.0.0.1"].includes(location.hostname);
  const $ = (selector) => document.querySelector(selector);
  const form = $("#config-form");
  const fieldset = form.querySelector("fieldset");
  const notice = $("#notice");
  const logOutput = $("#log-output");
  const usbSelect = $("#usb-devices");
  const configuredSecrets = new Set();
  let adminPassword = "";
  let usbSession = null;
  let usbBusy = false;
  let sequence = 0;
  let wizardStep = 0;
  let remoteDeviceReady = false;
  let usbPorts = [];
  const encoder = new TextEncoder();

  function setNotice(message, error = false) {
    notice.textContent = message;
    notice.classList.toggle("error", error);
  }

  function setConnected(connected, message) {
    const badge = $("#connection-state");
    badge.textContent = message || (connected ? "设备已连接" : localUsb ? "等待 USB 设备" : "未登录");
    badge.className = `state ${connected ? "state-online" : "state-idle"}`;
    $("#sidebar-connection").textContent = connected ? "设备已连接" : "等待设备连接";
    $("#device-ready").textContent = connected ? "USB 已连接" : "未连接";
    $("#device-ready").className = `state ${connected ? "state-online" : "state-idle"}`;
    $("#selected-device-name").textContent = connected ? "ESP32 维护控制台" : "尚未连接";
    fieldset.disabled = !connected;
    $("#save-button").disabled = !connected;
    $("#export-button").disabled = !connected;
    $("#reboot-button").disabled = !connected;
    $("#reset-button").disabled = !connected;
    $("#wizard-next").disabled = wizardStep === 0 && (localUsb ? !connected : !remoteDeviceReady);
    $("#disconnect-button").classList.toggle("hidden", !connected || !localUsb);
    $("#connect-button").disabled = connected || usbBusy || !selectedPort();
  }

  function selectedPort() {
    const selected = Number.parseInt(usbSelect.value, 10);
    return Number.isInteger(selected) ? usbPorts[selected] || null : null;
  }

  function describePort(device, index) {
    const info = device.getInfo ? device.getInfo() : {};
    const vendor = Number.isInteger(info.usbVendorId) ? info.usbVendorId.toString(16).padStart(4, "0").toUpperCase() : "????";
    const product = Number.isInteger(info.usbProductId) ? info.usbProductId.toString(16).padStart(4, "0").toUpperCase() : "????";
    const knownEsp = vendor === "303A";
    const label = knownEsp ? `ESP32 · USB ${vendor}:${product}` : `USB 串口 · ${vendor}:${product}`;
    return {value: String(index), label};
  }

  async function scanUsb() {
    if (!navigator.serial || typeof navigator.serial.getPorts !== "function") {
      setNotice("当前浏览器不支持 Web Serial。请使用桌面版 Chrome 或 Edge，并从 localhost 打开。", true);
      return;
    }
    usbPorts = await navigator.serial.getPorts();
    usbSelect.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = usbPorts.length ? "选择已授权的 USB 设备" : "未发现已授权设备";
    usbSelect.append(placeholder);
    usbPorts.forEach((device, index) => {
      const option = document.createElement("option");
      const descriptor = describePort(device, index);
      option.value = descriptor.value;
      option.textContent = descriptor.label;
      usbSelect.append(option);
    });
    if (usbPorts.length === 1) usbSelect.value = "0";
    $("#connect-button").disabled = !selectedPort() || Boolean(usbSession) || usbBusy;
    if (usbPorts.length) setNotice(`发现 ${usbPorts.length} 个已授权串口设备。选择设备后连接。`);
    else setNotice("没有已授权的 USB 设备。请点击“选择新设备”并在浏览器弹窗中授权。");
  }

  async function serialRequest(payload) {
    const session = usbSession;
    if (!session || !session.writer || session.closing) throw new Error("USB 尚未连接");
    const id = String(++sequence);
    payload.v = 1;
    payload.id = id;
    let resolveResponse;
    let rejectResponse;
    const responsePromise = new Promise((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    const responseOutcome = responsePromise.then(
      value => ({value}),
      error => ({error}),
    );
    const timer = setTimeout(() => {
      session.pending.delete(id);
      rejectResponse(new Error("设备响应超时"));
    }, 12000);
    session.pending.set(id, {resolve: resolveResponse, reject: rejectResponse, timer});
    try {
      const writePromise = Promise.resolve(session.writer.write(encoder.encode(`${JSON.stringify(payload)}\r\n`)));
      session.writes.add(writePromise);
      try {
        await writePromise;
      } finally {
        session.writes.delete(writePromise);
      }
    } catch (error) {
      clearTimeout(timer);
      session.pending.delete(id);
      rejectResponse(error);
    }
    const outcome = await responseOutcome;
    if (outcome.error) throw outcome.error;
    return outcome.value;
  }

  async function waitForWrites(session) {
    if (!session.writes.size) return;
    let timeout;
    try {
      await Promise.race([
        Promise.allSettled(Array.from(session.writes)),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error("USB 写入未能停止")), 3000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  function consumeSerialText(session, text) {
    session.buffer += text;
    let newline;
    while ((newline = session.buffer.indexOf("\n")) >= 0) {
      const line = session.buffer.slice(0, newline).replace(/\r$/, "");
      session.buffer = session.buffer.slice(newline + 1);
      if (!line) continue;
      if (line.startsWith("@")) {
        try {
          const response = JSON.parse(line.slice(1));
          const entry = session.pending.get(String(response.id));
          if (entry) {
            clearTimeout(entry.timer);
            session.pending.delete(String(response.id));
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

  async function readSerial(session) {
    const decoder = new TextDecoder();
    try {
      while (true) {
        const {value, done} = await session.reader.read();
        if (done) break;
        consumeSerialText(session, decoder.decode(value, {stream: true}));
      }
    } catch (error) {
      if (!session.closing) appendLog(`USB 读取结束：${error.message}`);
    } finally {
      try {
        session.reader.releaseLock();
        session.reader = null;
      } catch (error) {
        session.readError = error;
      }
      if (usbSession === session && !session.closing) {
        setTimeout(() => cleanupUsb(session).catch(() => {}), 0);
      }
    }
  }

  async function cleanupUsb(session = usbSession) {
    if (!session) {
      setConnected(false);
      return;
    }
    if (session.closePromise) return session.closePromise;
    usbBusy = true;
    session.closing = true;
    $("#connection-state").textContent = "正在断开 USB";
    $("#connect-button").disabled = true;
    $("#disconnect-button").disabled = true;
    session.closePromise = (async () => {
      for (const entry of session.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("USB 已断开"));
      }
      session.pending.clear();
      session.buffer = "";
      if (session.reader) {
        try { await session.reader.cancel(); } catch (_) {}
      }
      if (session.readPromise) {
        let timeout;
        try {
          await Promise.race([
            session.readPromise,
            new Promise((_, reject) => {
              timeout = setTimeout(() => reject(new Error("USB 读取流未能停止")), 3000);
            }),
          ]);
        } finally {
          clearTimeout(timeout);
        }
      }
      if (session.readError) throw new Error(`USB 读取锁未释放：${session.readError.message}`);
      await waitForWrites(session);
      if (session.reader) {
        session.reader.releaseLock();
        session.reader = null;
      }
      if (session.writer) {
        session.writer.releaseLock();
        session.writer = null;
      }
      if (session.opened) await session.port.close();
      session.opened = false;
      if (usbSession === session) usbSession = null;
      usbBusy = false;
      setConnected(false);
    })();
    try {
      await session.closePromise;
    } catch (error) {
      session.closePromise = null;
      session.closing = false;
      usbBusy = true;
      setConnected(false, "USB 关闭失败，请重试断开");
      $("#disconnect-button").classList.remove("hidden");
      $("#disconnect-button").disabled = false;
      setNotice(`USB 端口未能关闭：${error.message}`, true);
      throw error;
    }
  }

  function appendLog(line) {
    const cleaned = line.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
    logOutput.textContent += `${cleaned}\n`;
    const lines = logOutput.textContent.split("\n");
    if (lines.length > 400) logOutput.textContent = lines.slice(-400).join("\n");
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

  function setWizardValue(selector, value) {
    const input = $(selector);
    if (value !== null && value !== undefined) input.value = String(value);
  }

  function setMode(mode) {
    const cellularDisabled = mode !== "cellular";
    $("#cellular-disabled").checked = cellularDisabled;
    $("#wifi-setup-fields").classList.toggle("hidden", !cellularDisabled);
    $("#cellular-notice").classList.toggle("hidden", cellularDisabled);
  }

  function renderWizardStep() {
    document.querySelectorAll("[data-step-panel]").forEach(panel => {
      const active = Number(panel.dataset.stepPanel) === wizardStep;
      panel.classList.toggle("active", active);
      panel.hidden = !active;
    });
    document.querySelectorAll("[data-step-indicator]").forEach(item => {
      const step = Number(item.dataset.stepIndicator);
      item.classList.toggle("active", step === wizardStep);
      item.classList.toggle("complete", step < wizardStep);
    });
    $("#wizard-back").disabled = wizardStep === 0;
    $("#wizard-next").classList.toggle("hidden", wizardStep === 2);
    $("#setup-save").classList.toggle("hidden", wizardStep !== 2);
    $("#wizard-step-label").textContent = `第 ${wizardStep + 1} 步，共 3 步`;
    $("#wizard-next").disabled = wizardStep === 0 && (localUsb ? !usbSession : !remoteDeviceReady);
    $("#setup-save").disabled = wizardStep === 2 && !$("#setup-confirm").checked;
  }

  function showInitialization(reason) {
    $("#initialize-view").classList.remove("hidden");
    $("#management-view").classList.add("hidden");
    $("#management-nav").classList.add("hidden");
    $("#page-heading").textContent = "设备初始化";
    $("#setup-reason").textContent = reason || "首次配置或故障恢复";
    if (!localUsb) {
      $("#selected-device-name").textContent = "设备配网 AP";
      $("#device-detail").textContent = "手机已连接设备的 Wi-Fi 配网入口";
      $("#login-form").classList.add("hidden");
    }
    wizardStep = 0;
    renderWizardStep();
  }

  function showManagement() {
    $("#initialize-view").classList.add("hidden");
    $("#management-view").classList.remove("hidden");
    $("#management-nav").classList.remove("hidden");
    $("#page-heading").textContent = "设备管理";
  }

  function updateStatusView(data) {
    $("#status-version").textContent = data.version || "--";
    $("#status-mode").textContent = data.mode === "cellular" ? "4G" : data.mode === "wifi" ? "Wi-Fi" : "--";
    $("#status-wifi").textContent = data.wifi_connected ? "已连接" : "未连接";
    $("#status-cellular").textContent = data.modem_available ? "蜂窝模块可用" : "蜂窝模块未启用";
    $("#status-ap").textContent = data.ap_active === true ? (data.ap_ssid || "广播中") : data.ap_active === false ? "已关闭" : "按网络状态切换";
    if (!data.config_valid) {
      showInitialization(data.reason || "配置尚未完成");
      if (!localUsb && data.ap_active) remoteDeviceReady = true;
      setNotice(data.reason || "设备尚未完成初始化，请设置网络与管理凭据。", true);
    } else if (data.safe_mode) {
      showInitialization(data.reason || "设备进入故障恢复模式");
      if (!localUsb && data.ap_active) remoteDeviceReady = true;
      setNotice(data.reason || "设备处于故障恢复模式，请通过 USB 或配网 AP 重新初始化。", true);
    } else {
      remoteDeviceReady = false;
      showManagement();
    }
    return data;
  }

  async function loadStatus() {
    try {
      const data = await request({op: "status"});
      return updateStatusView(data);
    } catch (error) {
      if (localUsb) showInitialization("请检查 USB 连接并重试");
      setNotice(error.message, true);
      throw error;
    }
  }

  async function loadConfig() {
    const data = await request({op: "config.get"});
    configuredSecrets.clear();
    for (const [key, value] of Object.entries(data)) {
      if (key.endsWith("_configured")) {
        const secretKey = key.slice(0, -11);
        if (value) configuredSecrets.add(secretKey);
        const input = form.elements.namedItem(secretKey);
        if (input && value) input.placeholder = "已保存；留空保持不变";
      } else {
        setFormValue(key, value);
      }
    }
    setWizardValue("#setup-wifi-ssid", data.wifi_ssid || "");
    setWizardValue("#setup-wifi2-ssid", data.wifi2_ssid || "");
    setWizardValue("#setup-admin-phone", data.admin_phone || "");
    setMode(data.mode || "wifi");
    $("#setup-wifi-password").placeholder = data.wifi_password_configured ? "已保存密码留空表示不更改" : "Wi-Fi 密码（开放网络可留空）";
    $("#setup-wifi2-password").placeholder = data.wifi2_password_configured ? "已保存密码留空表示不更改" : "备用 Wi-Fi 密码";
    $("#setup-ap-password").placeholder = data.ap_password_configured ? "已设置密码留空表示不更改" : "首次设置至少 8 位";
    $("#setup-admin-password").placeholder = data.web_admin_password_configured ? "已设置密码留空表示不更改" : "首次设置至少 12 位";
    setNotice(`已读取配置 · 第 ${data.generation || 0} 代`);
    return data;
  }

  async function loadLogs() {
    const data = await request({op: "logs"});
    logOutput.textContent = Array.isArray(data) ? data.join("\n") : "";
    logOutput.scrollTop = logOutput.scrollHeight;
  }

  async function refreshAll() {
    const status = await loadStatus();
    await loadConfig();
    if (localUsb || adminPassword || (status.config_valid && !status.safe_mode)) await loadLogs();
  }

  async function connectUsb(selected = selectedPort()) {
    if (!("serial" in navigator)) {
      setNotice("此浏览器不支持 Web Serial；请使用桌面版 Chrome 或 Edge。", true);
      return;
    }
    if (!selected) {
      setNotice("请先扫描并选择 USB 设备，或选择新设备完成浏览器授权。", true);
      return;
    }
    if (usbSession || usbBusy) {
      setNotice("USB 端口仍在连接或关闭，请等待完成后重试。", true);
      return;
    }
    const session = {port: selected, reader: null, writer: null, readPromise: null, pending: new Map(), writes: new Set(), buffer: "", opened: false, closing: false, closePromise: null};
    usbSession = session;
    usbBusy = true;
    setConnected(false, "正在连接 USB");
    try {
      await session.port.open({baudRate: 115200});
      session.opened = true;
      session.reader = session.port.readable.getReader();
      session.writer = session.port.writable.getWriter();
      usbBusy = false;
      setConnected(true, "USB 已连接");
      session.readPromise = readSerial(session);
      await new Promise(resolve => setTimeout(resolve, 180));
      await refreshAll();
    } catch (error) {
      if (session.opened) await cleanupUsb(session).catch(() => {});
      else {
        if (usbSession === session) usbSession = null;
        usbBusy = false;
        setConnected(false, "连接失败");
      }
      setNotice(error.message, true);
    }
  }

  async function pairUsb() {
    if (!("serial" in navigator) || typeof navigator.serial.requestPort !== "function") {
      setNotice("此浏览器不支持 Web Serial；请使用桌面版 Chrome 或 Edge。", true);
      return;
    }
    try {
      const selected = await navigator.serial.requestPort();
      await scanUsb();
      await connectUsb(selected);
    } catch (error) {
      if (error.name !== "NotFoundError") setNotice(error.message, true);
    }
  }

  async function disconnectUsb() {
    await cleanupUsb(usbSession);
  }

  async function scanWifi() {
    const data = await request({op: "wifi.scan"});
    const list = $("#wifi-scan-results");
    list.replaceChildren();
    if (!Array.isArray(data) || data.length === 0) {
      const empty = document.createElement("option");
      empty.textContent = "未发现 Wi-Fi 网络";
      empty.disabled = true;
      list.append(empty);
      list.hidden = false;
      setNotice("附近没有扫描到可用 Wi-Fi，请检查路由器或手动输入网络名称。", true);
      return;
    }
    data.forEach(network => {
      const option = document.createElement("option");
      option.value = network.ssid || "";
      const signal = network.rssi <= -75 ? "弱" : network.rssi <= -60 ? "中" : "强";
      const secured = network.authmode === 0 ? "开放" : "需密码";
      option.textContent = `${network.ssid || "（隐藏网络）"} · 信号${signal} · ${secured} · CH ${network.channel}`;
      list.append(option);
    });
    list.hidden = false;
    setNotice(`扫描到 ${data.length} 个 Wi-Fi 网络，选择网络后填写密码。`);
  }

  function setFormValueIfPresent(key, value) {
    const input = form.elements.namedItem(key);
    if (input) input.value = value;
  }

  function validateSetup() {
    const cellularDisabled = $("#cellular-disabled").checked;
    if (!$("#setup-confirm").checked) throw new Error("请确认设备及配置内容后继续。");
    if (cellularDisabled && !$("#setup-wifi-ssid").value.trim()) throw new Error("Wi-Fi 模式需要填写上游 Wi-Fi 名称。");
    if (!$("#setup-admin-phone").value.trim()) throw new Error("请先设置管理员手机号，作为短信管理授权号码。");
    const apPassword = $("#setup-ap-password").value;
    if (!configuredSecrets.has("ap_password") && apPassword.length < 8) throw new Error("首次初始化需要设置至少 8 位的配网 AP 密码。");
    if (apPassword && (apPassword.length < 8 || apPassword.length > 63)) throw new Error("配网 AP 密码长度应为 8 至 63 位。");
    const webPassword = $("#setup-admin-password").value;
    if (!configuredSecrets.has("web_admin_password") && webPassword.length < 12) throw new Error("首次初始化需要设置至少 12 位的网页管理员密码。");
    if (webPassword && webPassword.length < 12) throw new Error("网页管理员密码至少需要 12 位。");
    if (!localUsb && webPassword.length < 12) throw new Error("手机恢复配置时请重新设置至少 12 位网页管理员密码，以便进入正式管理端。");
  }

  async function saveSetup() {
    validateSetup();
    const mode = $("#cellular-disabled").checked ? "wifi" : "cellular";
    setFormValueIfPresent("mode", mode);
    setFormValueIfPresent("wifi_ssid", $("#setup-wifi-ssid").value.trim());
    setFormValueIfPresent("wifi2_ssid", $("#setup-wifi2-ssid").value.trim());
    setFormValueIfPresent("admin_phone", $("#setup-admin-phone").value.trim());
    setFormValueIfPresent("wifi_password", $("#setup-wifi-password").value);
    setFormValueIfPresent("wifi2_password", $("#setup-wifi2-password").value);
    setFormValueIfPresent("ap_password", $("#setup-ap-password").value);
    setFormValueIfPresent("web_admin_password", $("#setup-admin-password").value);
    await saveConfig();
    $("#setup-wifi-password").value = "";
    $("#setup-wifi2-password").value = "";
    $("#setup-ap-password").value = "";
    $("#setup-admin-password").value = "";
    $("#setup-confirm").checked = false;
    showManagement();
    setNotice("初始化已完成，已进入正式管理端。请重启设备以应用网络设置。");
  }

  function formValue(key) {
    const input = form.elements.namedItem(key);
    return input ? input.value : "";
  }

  async function saveConfig() {
    const fields = Array.from(form.querySelectorAll("[name]"));
    for (const input of fields) {
      const key = input.name;
      const value = input.value;
      const clear = form.querySelector(`[data-clear="${key}"]`);
      const secret = Boolean(clear);
      if (secret && !value && !(clear && clear.checked)) continue;
      await request(clear && clear.checked && !value
        ? {op: "config.clear", key}
        : {op: "config.set", key, value});
    }
    const saved = await request({op: "config.save"});
    if (!localUsb && formValue("web_admin_password")) adminPassword = formValue("web_admin_password");
    form.querySelectorAll("[data-clear]").forEach(node => { node.checked = false; });
    await loadStatus();
    setNotice(`配置已保存 · 第 ${saved.generation} 代。重启后应用网络变更。`);
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
    updateStatusView(await loadStatus());
    setNotice(`配置已导入并保存 · 第 ${result.generation} 代。重启后应用网络变更。`);
  }

  async function uploadFirmware(file) {
    if (localUsb) throw new Error("固件上传请连接设备配网 AP 后通过网页执行。");
    const response = await fetch("/api/ota", {
      method: "POST",
      headers: {"Content-Type": "application/octet-stream", "X-Admin-Password": adminPassword},
      body: file,
    });
    if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`);
    setNotice("固件已验证，设备正在重启。");
  }

  $("#refresh-button").addEventListener("click", () => refreshAll().catch(error => setNotice(error.message, true)));
  $("#scan-usb-button").addEventListener("click", () => scanUsb().catch(error => setNotice(error.message, true)));
  usbSelect.addEventListener("change", () => { $("#connect-button").disabled = !selectedPort() || Boolean(usbSession) || usbBusy; });
  $("#pair-usb-button").addEventListener("click", pairUsb);
  $("#connect-button").addEventListener("click", () => connectUsb().catch(error => setNotice(error.message, true)));
  $("#disconnect-button").addEventListener("click", () => disconnectUsb().catch(() => {}));
  $("#scan-wifi-button").addEventListener("click", () => scanWifi().catch(error => setNotice(`Wi-Fi 扫描失败：${error.message}`, true)));
  $("#scan-wifi-manage").addEventListener("click", () => scanWifi().catch(error => setNotice(`Wi-Fi 扫描失败：${error.message}`, true)));
  $("#wifi-scan-results").addEventListener("change", event => { $("#setup-wifi-ssid").value = event.target.value; });
  $("#cellular-disabled").addEventListener("change", () => setMode($("#cellular-disabled").checked ? "wifi" : "cellular"));
  $("#wizard-back").addEventListener("click", () => { wizardStep = Math.max(0, wizardStep - 1); renderWizardStep(); });
  $("#wizard-next").addEventListener("click", () => {
    if (localUsb && !usbSession) return setNotice("请先连接 USB 设备。", true);
    if (!localUsb && !remoteDeviceReady) return setNotice("设备配网 AP 尚未就绪。", true);
    if (wizardStep === 1 && $("#cellular-disabled").checked && !$("#setup-wifi-ssid").value.trim()) return setNotice("Wi-Fi 模式需要填写上游 Wi-Fi 名称。", true);
    wizardStep = Math.min(2, wizardStep + 1);
    renderWizardStep();
  });
  $("#setup-confirm").addEventListener("change", renderWizardStep);
  $("#setup-save").addEventListener("click", () => saveSetup().catch(error => setNotice(error.message, true)));
  $("#reinitialize-button").addEventListener("click", () => showInitialization("重新配置设备，不会清除现有设置"));
  $("#save-button").addEventListener("click", () => saveConfig().catch(error => setNotice(error.message, true)));
  $("#export-button").addEventListener("click", () => exportConfig().catch(error => setNotice(error.message, true)));
  $("#logs-button").addEventListener("click", () => loadLogs().catch(error => setNotice(error.message, true)));
  $("#reboot-button").addEventListener("click", async () => {
    try { await request({op: "reboot"}); setNotice("设备正在重启。Wi-Fi 恢复后可重新连接管理页。"); }
    catch (error) { setNotice(error.message, true); }
  });
  $("#reset-button").addEventListener("click", async () => {
    if (!confirm("恢复默认配置？此操作会清除当前设置。")) return;
    try {
      await request({op: "config.reset", confirm: true});
      showInitialization("配置已恢复默认值");
      setNotice("默认配置已写入，请重新初始化并保存。", true);
    } catch (error) { setNotice(error.message, true); }
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
      $("#connection-state").textContent = status.safe_mode ? "故障恢复" : "管理端已连接";
      $("#connection-state").className = `state ${status.safe_mode ? "state-error" : "state-online"}`;
      fieldset.disabled = false;
      $("#save-button").disabled = false;
      $("#export-button").disabled = false;
      $("#reboot-button").disabled = false;
      $("#reset-button").disabled = false;
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
    showInitialization("连接 USB 后开始首次配置或故障恢复");
    setConnected(false);
    scanUsb().catch(error => setNotice(error.message, true));
    if (navigator.serial) navigator.serial.addEventListener("disconnect", event => {
      if (event.target === usbSession?.port) cleanupUsb(usbSession).catch(() => {});
    });
  } else {
    $("#login-form").classList.remove("hidden");
    $("#usb-transport").classList.add("hidden");
    $("#ota-section").classList.remove("hidden");
    loadStatus().then(async status => {
      if (!status.config_valid || status.safe_mode) {
        if (status.ap_active) remoteDeviceReady = true;
        renderWizardStep();
        try { await loadConfig(); } catch (error) { setNotice(error.message, true); }
      }
    }).catch(() => {});
  }
})();
