const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("failed readiness after opening USB releases streams and closes the port", async () => {
  const listeners = new Map();
  const elements = new Map();
  const fieldset = {disabled: true};
  const form = element("#config-form");
  form.querySelector = (selector) => selector === "fieldset" ? fieldset : element(selector);
  form.querySelectorAll = () => [];
  form.elements = {namedItem: () => null};

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
        },
        addEventListener(type, callback) {
          listeners.set(`${selector}:${type}`, callback);
        },
        querySelector() { return element(`${selector}:child`); },
        querySelectorAll() { return []; },
        textContent: "",
        value: "",
        disabled: false,
        scrollHeight: 0,
        scrollTop: 0,
      };
      elements.set(selector, node);
    }
    return elements.get(selector);
  }

  let readFinished;
  const state = {opened: false, cancelled: false, readerReleased: false, writerReleased: false, closed: false};
  const mockPort = {
    readable: {
      pipeThrough() {
        return {
          getReader() {
            return {
              read() { return new Promise(resolve => { readFinished = resolve; }); },
              async cancel() {
                state.cancelled = true;
                if (readFinished) readFinished({done: true});
              },
              releaseLock() { state.readerReleased = true; },
            };
          },
        };
      },
    },
    writable: {
      getWriter() {
        return {
          async write() { throw new Error("readiness failed"); },
          releaseLock() { state.writerReleased = true; },
        };
      },
    },
    async open() { state.opened = true; },
    async close() { state.closed = true; },
  };

  const context = {
    document: {querySelector: element},
    location: {hostname: "localhost"},
    navigator: {serial: {async requestPort() { return mockPort; }}},
    TextEncoder,
    TextDecoder,
    TextDecoderStream: class TextDecoderStream {},
    setTimeout,
    clearTimeout,
    console,
    confirm: () => true,
  };
  const script = fs.readFileSync(path.join(__dirname, "..", "web", "app.js"), "utf8");
  vm.runInNewContext(script, context);

  await listeners.get("#connect-button:click")();

  assert.equal(state.opened, true);
  assert.equal(state.cancelled, true);
  assert.equal(state.readerReleased, true);
  assert.equal(state.writerReleased, true);
  assert.equal(state.closed, true);
});
