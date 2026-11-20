const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function makeHarness({ports = [], requestPort, onWrite, hostname = "localhost", fetchImpl, formFields = [], clearFields = []} = {}) {
  const listeners = new Map();
  const elements = new Map();
  const form = element("#config-form");
  const fieldset = element("#config-fieldset");
  form.querySelector = selector => {
    if (selector === "fieldset") return fieldset;
    const match = selector.match(/^\[data-clear="([^"]+)"\]$/);
    return match ? clearFields.find(node => node.dataset.clear === match[1]) || null : element(selector);
  };
  form.querySelectorAll = selector => {
    if (selector === "[name]") return formFields;
    if (selector === "[data-clear]") return clearFields;
    return [];
  };
  form.elements = {namedItem: name => formFields.find(input => input.name === name) || null};

  function element(selector) {
    if (!elements.has(selector)) {
      const classes = new Set();
      const node = {
        className: "",
        classList: {
          add(name) { classes.add(name); },
          remove(name) { classes.delete(name); },
          toggle(name, force) {
            if (force === undefined ? !classes.has(name) : force) classes.add(name);
            else classes.delete(name);
          },
          contains(name) { return classes.has(name); },
        },
        children: [],
        dataset: {},
        hidden: false,
        addEventListener(type, callback) { listeners.set(`${selector}:${type}`, callback); },
        querySelector() { return element(`${selector}:child`); },
        querySelectorAll() { return []; },
        replaceChildren(...children) { this.children = children; },
        append(child) { this.children.push(child); },
        textContent: "",
        value: "",
        disabled: false,
        scrollHeight: 0,
        scrollTop: 0,
        placeholder: "",
        files: [],
      };
      elements.set(selector, node);
    }
    return elements.get(selector);
  }

  const script = fs.readFileSync(path.join(__dirname, "..", "web", "app.js"), "utf8");
  const context = {
    document: {
      querySelector: element,
      querySelectorAll: () => [],
      createElement: tag => element(`created:${tag}:${Math.random()}`),
    },
    location: {hostname},
    navigator: {
      serial: {
        async getPorts() { return ports; },
        async requestPort() {
          if (requestPort) return requestPort();
          return ports[0];
        },
        addEventListener() {},
      },
    },
    TextEncoder,
    TextDecoder,
    TextDecoderStream,
    ReadableStream,
    setTimeout,
    clearTimeout,
    console,
    confirm: () => true,
    onWrite,
    fetch: fetchImpl,
  };
  vm.runInNewContext(script, context);
  return {elements, listeners, element};
}

test("failed first-time USB pairing releases streams and closes the port", async () => {
  const state = {opened: false, cancelled: false, readerReleased: false, writerReleased: false, closed: false, requested: 0};
  let readFinished;
  const mockPort = {
    getInfo() { return {usbVendorId: 0x303a, usbProductId: 0x1001}; },
    readable: {getReader() {
      return {
        read() { return new Promise(resolve => { readFinished = resolve; }); },
        async cancel() {
          state.cancelled = true;
          if (readFinished) readFinished({done: true});
        },
        releaseLock() { state.readerReleased = true; },
      };
    }},
    writable: {getWriter() {
      return {
        async write() { throw new Error("readiness failed"); },
        releaseLock() { state.writerReleased = true; },
      };
    }},
    async open() { state.opened = true; },
    async close() { state.closed = true; },
  };
  const harness = makeHarness({
    ports: [mockPort],
    requestPort: async () => { state.requested++; return mockPort; },
  });

  await harness.listeners.get("#pair-usb-button:click")();

  assert.equal(state.requested, 1);
  assert.equal(state.opened, true);
  assert.equal(state.cancelled, true);
  assert.equal(state.readerReleased, true);
  assert.equal(state.writerReleased, true);
  assert.equal(state.closed, true);
});

test("USB disconnect waits for close and permits a clean reconnect", async () => {
  const state = {opened: false, readerLocked: false, writerLocked: false, opens: 0, closes: 0, failNextClose: true};
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let controller;
  let stream;
  const requests = [];
  const mockPort = {
    getInfo() { return {usbVendorId: 0x303a, usbProductId: 0x1001}; },
    get readable() { return stream; },
    get writable() {
      return {
        getWriter() {
          state.writerLocked = true;
          return {
            async write(bytes) {
              const request = JSON.parse(decoder.decode(bytes).trim());
              requests.push(request.op);
              const data = request.op === "status"
                ? {config_valid: false, safe_mode: true, mode: "wifi", reason: "first setup"}
                : request.op === "config.get"
                  ? {mode: "wifi", wifi_ssid: "", wifi_password_configured: false, ap_password_configured: false, web_admin_password_configured: false}
                  : [];
              controller.enqueue(encoder.encode(`@${JSON.stringify({id: request.id, ok: true, data})}\r\n`));
            },
            releaseLock() { state.writerLocked = false; },
          };
        },
      };
    },
    async open() {
      if (state.opened) throw new DOMException("Port is already open", "InvalidStateError");
      state.opened = true;
      state.opens++;
      stream = new ReadableStream({
        start(value) { controller = value; },
      });
      const originalGetReader = stream.getReader.bind(stream);
      stream.getReader = (...args) => {
        state.readerLocked = true;
        const reader = originalGetReader(...args);
        const releaseLock = reader.releaseLock.bind(reader);
        reader.releaseLock = () => {
          releaseLock();
          state.readerLocked = false;
        };
        return reader;
      };
    },
    async close() {
      state.closes++;
      if (!state.opened) throw new DOMException("Port is not open", "InvalidStateError");
      if (state.readerLocked || state.writerLocked) throw new DOMException("Port stream is locked", "InvalidStateError");
      if (state.failNextClose) {
        state.failNextClose = false;
        throw new DOMException("Injected close failure", "NetworkError");
      }
      state.opened = false;
    },
  };
  const harness = makeHarness({ports: [mockPort], requestPort: async () => mockPort});

  await harness.listeners.get("#pair-usb-button:click")();
  assert.deepEqual(requests, ["status", "config.get", "logs"]);
  assert.equal(state.opened, true);
  assert.equal(state.readerLocked, true);
  assert.equal(state.writerLocked, true);

  await harness.listeners.get("#disconnect-button:click")();
  assert.match(harness.elements.get("#connection-state").textContent, /关闭失败/);
  assert.match(harness.elements.get("#notice").textContent, /Injected close failure/);
  assert.equal(harness.elements.get("#connect-button").disabled, true);
  assert.equal(harness.elements.get("#disconnect-button").classList.contains("hidden"), false);
  assert.equal(state.opened, true);
  assert.equal(state.readerLocked, false);
  assert.equal(state.writerLocked, false);

  await harness.listeners.get("#disconnect-button:click")();
  assert.equal(state.opened, false);
  assert.equal(harness.elements.get("#connect-button").disabled, false);

  await harness.listeners.get("#pair-usb-button:click")();
  assert.equal(state.opened, true);
  assert.equal(state.opens, 2);
  assert.deepEqual(requests, ["status", "config.get", "logs", "status", "config.get", "logs"]);
  await harness.listeners.get("#disconnect-button:click")();

  assert.equal(state.opened, false);
  assert.equal(state.closes, 3);
  assert.equal(state.readerLocked, false);
  assert.equal(state.writerLocked, false);
});

test("USB disconnect waits for an in-flight write before releasing locks or closing", async () => {
  const state = {opened: false, readerLocked: false, writerLocked: false, opens: 0, closes: 0, writes: 0};
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let controller;
  let stream;
  let finishFirstWrite;
  let signalFirstWrite;
  const firstWriteStarted = new Promise(resolve => { signalFirstWrite = resolve; });
  const requests = [];
  const mockPort = {
    getInfo() { return {usbVendorId: 0x303a, usbProductId: 0x1001}; },
    get readable() { return stream; },
    get writable() {
      return {
        getWriter() {
          state.writerLocked = true;
          return {
            async write(bytes) {
              const request = JSON.parse(decoder.decode(bytes).trim());
              requests.push(request.op);
              state.writes++;
              if (state.opens === 1 && state.writes === 1) {
                signalFirstWrite();
                await new Promise(resolve => { finishFirstWrite = resolve; });
                return;
              }
              const data = request.op === "status"
                ? {config_valid: false, safe_mode: true, mode: "wifi", reason: "first setup"}
                : request.op === "config.get"
                  ? {mode: "wifi", wifi_ssid: "", wifi_password_configured: false, ap_password_configured: false, web_admin_password_configured: false}
                  : [];
              controller.enqueue(encoder.encode(`@${JSON.stringify({id: request.id, ok: true, data})}\r\n`));
            },
            releaseLock() { state.writerLocked = false; },
          };
        },
      };
    },
    async open() {
      if (state.opened) throw new DOMException("Port is already open", "InvalidStateError");
      state.opened = true;
      state.opens++;
      stream = new ReadableStream({start(value) { controller = value; }});
      const originalGetReader = stream.getReader.bind(stream);
      stream.getReader = (...args) => {
        state.readerLocked = true;
        const reader = originalGetReader(...args);
        const releaseLock = reader.releaseLock.bind(reader);
        reader.releaseLock = () => {
          releaseLock();
          state.readerLocked = false;
        };
        return reader;
      };
    },
    async close() {
      state.closes++;
      if (state.readerLocked || state.writerLocked) throw new DOMException("Port stream is locked", "InvalidStateError");
      state.opened = false;
    },
  };
  const harness = makeHarness({ports: [mockPort], requestPort: async () => mockPort});

  const connecting = harness.listeners.get("#pair-usb-button:click")();
  await firstWriteStarted;
  let disconnected = false;
  const disconnecting = harness.listeners.get("#disconnect-button:click")().then(() => { disconnected = true; });
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(disconnected, false);
  assert.equal(state.closes, 0);
  assert.equal(state.opened, true);
  assert.equal(state.writerLocked, true);
  assert.equal(harness.elements.get("#connect-button").disabled, true);

  finishFirstWrite();
  await disconnecting;
  await connecting;
  assert.equal(state.opened, false);
  assert.equal(state.readerLocked, false);
  assert.equal(state.writerLocked, false);
  assert.equal(state.closes, 1);

  await harness.listeners.get("#pair-usb-button:click")();
  assert.equal(state.opened, true);
  assert.equal(state.opens, 2);
  assert.deepEqual(requests, ["status", "status", "config.get", "logs"]);
  await harness.listeners.get("#disconnect-button:click")();
  assert.equal(state.opened, false);
  assert.equal(state.closes, 2);
});

test("USB scan lists already-authorized devices and enables connection selection", async () => {
  const mockPort = {getInfo() { return {usbVendorId: 0x303a, usbProductId: 0x1001}; }};
  const harness = makeHarness({ports: [mockPort]});
  await new Promise(resolve => setTimeout(resolve, 0));

  const select = harness.elements.get("#usb-devices");
  assert.equal(select.children.length, 2);
  assert.match(select.children[1].textContent, /ESP32/);
  assert.equal(select.value, "0");
  assert.equal(harness.elements.get("#connect-button").disabled, false);
  select.value = "0";
  harness.listeners.get("#usb-devices:change")();
  assert.equal(harness.elements.get("#connect-button").disabled, false);
});

test("Wi-Fi scan response populates selectable SSIDs in the setup wizard", async () => {
  let controller;
  const readable = new ReadableStream({start(value) { controller = value; }});
  const requests = [];
  const mockPort = {
    getInfo() { return {usbVendorId: 0x303a, usbProductId: 0x1001}; },
    readable: {getReader() { return readable.getReader(); }},
    writable: {getWriter() {
      return {
        async write(bytes) {
          const request = JSON.parse(new TextDecoder().decode(bytes).trim());
          requests.push(request.op);
          let data = {};
          if (request.op === "status") data = {config_valid: false, safe_mode: true, mode: "wifi", reason: "first setup"};
          if (request.op === "config.get") data = {mode: "wifi", wifi_ssid: "", wifi_password_configured: false, ap_password_configured: false, web_admin_password_configured: false};
          if (request.op === "logs") data = [];
          if (request.op === "wifi.scan") data = [{ssid: "Home-Net", rssi: -48, channel: 6, authmode: 3}];
          controller.enqueue(new TextEncoder().encode(`@${JSON.stringify({id: request.id, ok: true, data})}\r\n`));
        },
        releaseLock() {},
      };
    }},
    async open() {},
    async close() {},
  };
  const harness = makeHarness({ports: [mockPort], requestPort: async () => mockPort});
  await harness.listeners.get("#pair-usb-button:click")();
  await harness.listeners.get("#scan-wifi-button:click")();

  const results = harness.elements.get("#wifi-scan-results");
  assert.ok(requests.includes("wifi.scan"));
  assert.equal(results.children[0].value, "Home-Net");
  harness.listeners.get("#wifi-scan-results:change")({target: results.children[0]});
  assert.equal(harness.elements.get("#setup-wifi-ssid").value, "Home-Net");
  await harness.listeners.get("#disconnect-button:click")();
});

test("recovery AP advances setup without USB and does not save configuration", async () => {
  const operations = [];
  const harness = makeHarness({
    hostname: "192.168.4.1",
    fetchImpl: async (_url, options) => {
      const op = JSON.parse(options.body).op;
      operations.push(op);
      const data = op === "status"
        ? {config_valid: false, safe_mode: true, ap_active: true, ap_ssid: "SMS-Forwarder-AP", reason: "first setup"}
        : {mode: "wifi", wifi_ssid: "", wifi_password_configured: false, ap_password_configured: false, web_admin_password_configured: false, generation: 0};
      return {ok: true, async json() { return {ok: true, data}; }, async text() { return ""; }};
    },
  });

  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(harness.elements.get("#wizard-next").disabled, false);
  await harness.listeners.get("#wizard-next:click")();
  assert.equal(harness.elements.get("#wizard-step-label").textContent, "第 2 步，共 3 步");
  assert.deepEqual(operations, ["status", "config.get"]);
});

test("setup wizard rejects incomplete credentials before sending any configuration writes", async () => {
  const operations = [];
  const harness = makeHarness({
    hostname: "192.168.4.1",
    fetchImpl: async (_url, options) => {
      const op = JSON.parse(options.body).op;
      operations.push(op);
      const data = op === "status"
        ? {config_valid: false, safe_mode: true, ap_active: true, ap_ssid: "SMS-Forwarder-AP", reason: "first setup"}
        : {mode: "wifi", wifi_ssid: "", wifi_password_configured: false, ap_password_configured: false, web_admin_password_configured: false, generation: 0};
      return {ok: true, async json() { return {ok: true, data}; }, async text() { return ""; }};
    },
  });
  await new Promise(resolve => setTimeout(resolve, 0));

  await harness.listeners.get("#wizard-next:click")();
  await harness.listeners.get("#wizard-next:click")();
  assert.equal(harness.elements.get("#wizard-step-label").textContent, "第 2 步，共 3 步");
  assert.match(harness.elements.get("#notice").textContent, /Wi-Fi 模式需要填写/);

  harness.element("#setup-wifi-ssid").value = "Home-Net";
  await harness.listeners.get("#wizard-next:click")();
  assert.equal(harness.elements.get("#wizard-step-label").textContent, "第 3 步，共 3 步");

  const submit = harness.listeners.get("#setup-save:click");
  await submit();
  assert.match(harness.elements.get("#notice").textContent, /请确认设备及配置内容/);

  harness.element("#setup-confirm").checked = true;
  await submit();
  assert.match(harness.elements.get("#notice").textContent, /管理员手机号/);

  harness.element("#setup-admin-phone").value = "13800138000";
  harness.element("#setup-ap-password").value = "short";
  await submit();
  assert.match(harness.elements.get("#notice").textContent, /至少 8 位/);

  harness.element("#setup-ap-password").value = "x".repeat(64);
  await submit();
  assert.match(harness.elements.get("#notice").textContent, /8 至 63 位/);

  harness.element("#setup-ap-password").value = "safe-pass-123";
  harness.element("#setup-admin-password").value = "too-short";
  await submit();
  assert.match(harness.elements.get("#notice").textContent, /至少 12 位/);
  assert.equal(operations.includes("config.set"), false);
  assert.equal(operations.includes("config.save"), false);
});

test("setup mode toggle changes wizard visibility without submitting configuration", async () => {
  const operations = [];
  const harness = makeHarness({
    hostname: "192.168.4.1",
    fetchImpl: async (_url, options) => {
      const op = JSON.parse(options.body).op;
      operations.push(op);
      const data = op === "status"
        ? {config_valid: false, safe_mode: true, ap_active: true, reason: "first setup"}
        : {mode: "wifi", wifi_ssid: "Home-Net", ap_password_configured: false, web_admin_password_configured: false};
      return {ok: true, async json() { return {ok: true, data}; }, async text() { return ""; }};
    },
  });
  await new Promise(resolve => setTimeout(resolve, 0));

  const toggle = harness.element("#cellular-disabled");
  const wifiFields = harness.element("#wifi-setup-fields");
  const cellularNotice = harness.element("#cellular-notice");
  assert.equal(toggle.checked, true);
  assert.equal(wifiFields.classList.contains("hidden"), false);
  assert.equal(cellularNotice.classList.contains("hidden"), true);

  toggle.checked = false;
  harness.listeners.get("#cellular-disabled:change")();
  assert.equal(wifiFields.classList.contains("hidden"), true);
  assert.equal(cellularNotice.classList.contains("hidden"), false);

  toggle.checked = true;
  harness.listeners.get("#cellular-disabled:change")();
  assert.equal(wifiFields.classList.contains("hidden"), false);
  assert.equal(cellularNotice.classList.contains("hidden"), true);
  assert.deepEqual(operations, ["status", "config.get"]);
});

test("confirmed setup sends the expected mock configuration and enters management", async () => {
  const operations = [];
  let saved = false;
  const formFields = ["mode", "wifi_ssid", "wifi_password", "wifi2_ssid", "wifi2_password", "admin_phone", "ap_password", "web_admin_password"]
    .map(name => ({name, value: "", placeholder: ""}));
  const clearFields = ["wifi_password", "wifi2_password", "ap_password", "web_admin_password"]
    .map(clear => ({checked: false, dataset: {clear}}));
  const harness = makeHarness({
    hostname: "192.168.4.1",
    formFields,
    clearFields,
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      operations.push(request);
      let data = {};
      if (request.op === "status") {
        data = saved
          ? {config_valid: true, safe_mode: false, ap_active: false, wifi_connected: true, mode: "wifi"}
          : {config_valid: false, safe_mode: true, ap_active: true, ap_ssid: "SMS-Forwarder-AP", reason: "first setup"};
      } else if (request.op === "config.get") {
        data = {mode: "wifi", wifi_ssid: "", wifi_password_configured: false, wifi2_ssid: "", wifi2_password_configured: false, ap_password_configured: false, web_admin_password_configured: false, generation: 0};
      } else if (request.op === "config.save") {
        saved = true;
        data = {generation: 1};
      } else if (request.op === "config.set") {
        data = {staged: true};
      }
      return {ok: true, async json() { return {ok: true, data}; }, async text() { return ""; }};
    },
  });
  await new Promise(resolve => setTimeout(resolve, 0));

  await harness.listeners.get("#wizard-next:click")();
  harness.element("#setup-wifi-ssid").value = "Home-Net";
  await harness.listeners.get("#wizard-next:click")();
  harness.element("#setup-admin-phone").value = "13800138000";
  harness.element("#setup-ap-password").value = "test-ap-password-123";
  harness.element("#setup-admin-password").value = "test-web-admin-password";
  harness.element("#setup-confirm").checked = true;

  await harness.listeners.get("#setup-save:click")();

  const writes = operations.filter(request => request.op === "config.set").map(({key, value}) => [key, value]);
  assert.deepEqual(writes, [
    ["mode", "wifi"],
    ["wifi_ssid", "Home-Net"],
    ["wifi2_ssid", ""],
    ["admin_phone", "13800138000"],
    ["ap_password", "test-ap-password-123"],
    ["web_admin_password", "test-web-admin-password"],
  ]);
  assert.equal(operations.filter(request => request.op === "config.save").length, 1);
  assert.equal(saved, true);
  assert.equal(harness.elements.get("#page-heading").textContent, "设备管理");
  assert.equal(harness.elements.get("#initialize-view").classList.contains("hidden"), true);
  assert.equal(harness.elements.get("#management-view").classList.contains("hidden"), false);
  assert.equal(harness.element("#setup-confirm").checked, false);
  assert.equal(harness.element("#setup-ap-password").value, "");
  assert.equal(harness.element("#setup-admin-password").value, "");
});

test("setup wizard submits cellular selection without requiring Wi-Fi credentials", async () => {
  const operations = [];
  let saved = false;
  const formFields = ["mode", "wifi_ssid", "wifi_password", "wifi2_ssid", "wifi2_password", "admin_phone", "ap_password", "web_admin_password"]
    .map(name => ({name, value: "", placeholder: ""}));
  const clearFields = ["wifi_password", "wifi2_password", "ap_password", "web_admin_password"]
    .map(clear => ({checked: false, dataset: {clear}}));
  const harness = makeHarness({
    hostname: "192.168.4.1",
    formFields,
    clearFields,
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      operations.push(request);
      let data = {};
      if (request.op === "status") {
        data = saved
          ? {config_valid: true, safe_mode: false, ap_active: true, wifi_connected: false, modem_available: false, mode: "cellular"}
          : {config_valid: false, safe_mode: true, ap_active: true, ap_ssid: "SMS-Forwarder-AP", reason: "first setup"};
      } else if (request.op === "config.get") {
        data = {mode: "wifi", wifi_ssid: "", wifi_password_configured: false, wifi2_ssid: "", wifi2_password_configured: false, ap_password_configured: false, web_admin_password_configured: false, generation: 0};
      } else if (request.op === "config.save") {
        saved = true;
        data = {generation: 1};
      }
      return {ok: true, async json() { return {ok: true, data}; }, async text() { return ""; }};
    },
  });
  await new Promise(resolve => setTimeout(resolve, 0));

  const toggle = harness.element("#cellular-disabled");
  assert.equal(toggle.checked, true);
  toggle.checked = false;
  harness.listeners.get("#cellular-disabled:change")();
  await harness.listeners.get("#wizard-next:click")();
  await harness.listeners.get("#wizard-next:click")();
  harness.element("#setup-admin-phone").value = "13800138000";
  harness.element("#setup-ap-password").value = "test-ap-password-123";
  harness.element("#setup-admin-password").value = "test-web-admin-password";
  harness.element("#setup-confirm").checked = true;

  await harness.listeners.get("#setup-save:click")();

  const writes = operations.filter(request => request.op === "config.set").map(({key, value}) => [key, value]);
  assert.deepEqual(writes, [
    ["mode", "cellular"],
    ["wifi_ssid", ""],
    ["wifi2_ssid", ""],
    ["admin_phone", "13800138000"],
    ["ap_password", "test-ap-password-123"],
    ["web_admin_password", "test-web-admin-password"],
  ]);
  assert.equal(operations.filter(request => request.op === "config.save").length, 1);
  assert.equal(saved, true);
  assert.equal(harness.elements.get("#page-heading").textContent, "设备管理");
});

test("saved secrets are preserved when blank and cleared only by explicit selection", async () => {
  const operations = [];
  let configSaved = false;
  const tokenInput = {name: "pushplus_token", value: "", placeholder: ""};
  const clearToken = {checked: false, dataset: {clear: "pushplus_token"}};
  const harness = makeHarness({
    hostname: "192.168.4.1",
    formFields: [tokenInput],
    clearFields: [clearToken],
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      operations.push(request);
      let data = {};
      if (request.op === "status") {
        data = configSaved
          ? {config_valid: true, safe_mode: false, mode: "wifi"}
          : {config_valid: false, safe_mode: true, ap_active: true, reason: "first setup"};
      } else if (request.op === "config.get") {
        data = {mode: "wifi", pushplus_token: null, pushplus_token_configured: true, generation: 3};
      } else if (request.op === "config.save") {
        configSaved = true;
        data = {generation: configSaved ? 4 : 3};
      } else if (request.op === "config.clear") {
        data = {staged: true};
      }
      return {ok: true, async json() { return {ok: true, data}; }, async text() { return ""; }};
    },
  });
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(tokenInput.placeholder, "已保存；留空保持不变");
  await harness.listeners.get("#save-button:click")();
  assert.equal(operations.filter(request => request.op === "config.set" || request.op === "config.clear").length, 0);
  assert.equal(operations.filter(request => request.op === "config.save").length, 1);

  clearToken.checked = true;
  await harness.listeners.get("#save-button:click")();
  const clearRequests = operations.filter(request => request.op === "config.clear");
  assert.deepEqual(clearRequests.map(({key}) => key), ["pushplus_token"]);
  assert.equal(operations.filter(request => request.op === "config.set").length, 0);
  assert.equal(operations.filter(request => request.op === "config.save").length, 2);
  assert.equal(clearToken.checked, false);
});
