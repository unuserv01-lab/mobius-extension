var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
(function() {
  "use strict";
  const DEFAULT_MEMORY_TTL_SECONDS = 7 * 24 * 60 * 60;
  const DEFAULT_TEMP_TTL_SECONDS = 15 * 60;
  const TEMP_CLEANUP_ALARM_MINUTES = 5;
  const MAX_ONDEVICE_CHARS = 8e3;
  const DEFAULT_ENGINE = "auto";
  const DEFAULT_LOCAL_SERVER_BASE_URL = "http://localhost:11434";
  const DEFAULT_LOCAL_SERVER_MODEL = "llama3.1";
  const DEFAULT_LOCAL_SERVER_TIMEOUT_MS = 6e4;
  const DEFAULT_CHAT_RETENTION_SECONDS = 24 * 60 * 60;
  const STORAGE_KEYS = {
    permissions: "mobius_permissions",
    memory: "mobius_memory",
    routerLog: "mobius_router_log",
    settings: "mobius_settings",
    chatHistory: "mobius_chat_history"
  };
  class PromptBuilder {
    static whatsappReply(lastMessage, sender, userInstruction) {
      const instruction = userInstruction.trim() ? `User instruction for tone/style: "${userInstruction}".` : "Match the sender's tone; keep it short, natural, and friendly.";
      return [
        "You are MOBIUS, a helpful on-device assistant. Draft ONE short reply to the last WhatsApp message below.",
        instruction,
        "Reply in the same language as the incoming message. Output ONLY the reply text, no quotes, no explanation.",
        `Sender: ${sender ?? "unknown"}`,
        `Last message: """${lastMessage}"""`
      ].join("\n");
    }
    static summarize(pageText, url, userInstruction) {
      const instruction = userInstruction.trim() && !/summar/i.test(userInstruction) ? `Focus on: ${userInstruction}.` : "";
      return [
        "Summarize the following page content in 5-8 concise bullet points.",
        instruction,
        "Keep names, numbers and facts exact. If the content is not in English, answer in its language.",
        url ? `Page URL: ${url}` : "",
        `Content:
"""${pageText}"""`
      ].join("\n");
    }
    static chat(userInput, context) {
      const ctx = [
        context.title ? `Current page: ${context.title}` : "",
        context.url ? `URL: ${context.url}` : "",
        context.pageText ? `Page excerpt:
"""${context.pageText.slice(0, 2e3)}"""` : "",
        context.recentTaskSummaries.length > 0 ? `Recent local tasks:
- ${context.recentTaskSummaries.join("\n- ")}` : ""
      ].filter(Boolean).join("\n");
      return [
        "You are MOBIUS, a helpful on-device assistant running locally in the user's browser.",
        "Answer briefly and helpfully. If you do not know, say so.",
        ctx,
        `User: ${userInput}`
      ].join("\n");
    }
  }
  class TempStore {
    constructor(ttlSeconds) {
      __publicField(this, "data", /* @__PURE__ */ new Map());
      __publicField(this, "ttlMs");
      this.ttlMs = ttlSeconds * 1e3;
    }
    set(key, value) {
      this.data.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    }
    get(key) {
      const entry = this.data.get(key);
      if (!entry) return void 0;
      if (entry.expiresAt <= Date.now()) {
        this.data.delete(key);
        return void 0;
      }
      return entry.value;
    }
    /** Immediate wipe (called on task end — P6). */
    wipe() {
      this.data.clear();
    }
    size() {
      return this.data.size;
    }
  }
  class AgentScope {
    constructor(tempTtlSeconds) {
      __publicField(this, "tempStore");
      __publicField(this, "controller", null);
      __publicField(this, "timeoutId", null);
      this.tempStore = new TempStore(tempTtlSeconds);
    }
    start(timeoutMs2 = 12e4) {
      this.controller = new AbortController();
      this.timeoutId = setTimeout(() => this.abort("timeout"), timeoutMs2);
      return this.controller.signal;
    }
    abort(reason = "aborted") {
      if (this.timeoutId) clearTimeout(this.timeoutId);
      this.timeoutId = null;
      if (this.controller && !this.controller.signal.aborted) {
        this.controller.abort(new Error(`SubAgent ${reason}`));
      }
    }
    cleanup() {
      this.abort("cleanup");
      this.tempStore.wipe();
    }
    get signal() {
      var _a;
      return ((_a = this.controller) == null ? void 0 : _a.signal) ?? null;
    }
  }
  class SubAgent {
    constructor(kind, task, context, aiRouter, permissions, tempTtlSeconds, insertIntoPage) {
      __publicField(this, "id");
      __publicField(this, "kind");
      __publicField(this, "scope");
      __publicField(this, "aiRouter");
      __publicField(this, "permissions");
      __publicField(this, "task");
      __publicField(this, "context");
      __publicField(this, "insertIntoPage");
      __publicField(this, "destroyed", false);
      this.id = `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      this.kind = kind;
      this.task = task;
      this.context = context;
      this.aiRouter = aiRouter;
      this.permissions = permissions;
      this.insertIntoPage = insertIntoPage;
      this.scope = new AgentScope(tempTtlSeconds);
    }
    async run() {
      const signal = this.scope.start();
      try {
        if (this.kind === "reply") return await this.runReply(signal);
        if (this.kind === "summarize") return await this.runSummarize(signal);
        return await this.runChat(signal);
      } finally {
        this.scope.cleanup();
      }
    }
    /** MVP flow (a): WhatsApp Web smart reply. */
    async runReply(signal) {
      const tabId = this.context.tabId;
      if (typeof tabId !== "number") {
        return this.fail("No active tab — open WhatsApp Web and try again.");
      }
      const last = await this.sendToTab(tabId, { type: "MOBIUS_READ_WA" });
      if (!(last == null ? void 0 : last.ok) || !last.text) {
        return this.fail(
          (last == null ? void 0 : last.error) ?? 'Could not read a message on this tab. Make sure a WhatsApp Web chat is open and "Read Page / DOM Context" is enabled.'
        );
      }
      this.scope.tempStore.set("lastMessage", last.text);
      if (signal.aborted) return this.fail("Task aborted.");
      const prompt = PromptBuilder.whatsappReply(last.text, last.sender, this.task.input);
      const gen = await this.aiRouter.generate(this.task.id, prompt, { needsHeavyReasoning: false, pageTextChars: last.text.length });
      if (!gen.ok) return this.fail(gen.error ?? "AI generation failed.");
      const draft = gen.text.trim();
      this.scope.tempStore.set("draft", draft);
      let inserted = false;
      if (this.insertIntoPage && await this.permissions.isAllowed("domActions")) {
        const res = await this.sendToTab(tabId, { type: "MOBIUS_INSERT_REPLY", text: draft });
        inserted = Boolean(res == null ? void 0 : res.ok);
      }
      const engineLabel = gen.engine === "cloud" ? "via Cloud Gemini" : gen.engine === "local-server" ? "via local server" : gen.engine === "local-fallback" ? "via local extractive fallback" : "Locally via Gemini Nano";
      return {
        taskId: this.task.id,
        ok: true,
        engine: gen.engine,
        text: draft,
        provenance: inserted ? `Done (Processed ${engineLabel}) — draft inserted into WhatsApp Web` : `Done (Processed ${engineLabel}) — draft ready, copy it manually (DOM actions are OFF)`
      };
    }
    /** MVP flow (b): active-page summarizer. */
    async runSummarize(signal) {
      const tabId = this.context.tabId;
      let pageText = this.context.pageText ?? this.task.pageText;
      if (!pageText && typeof tabId === "number") {
        const res = await this.sendToTab(tabId, { type: "MOBIUS_READ_PAGE" });
        if ((res == null ? void 0 : res.ok) && res.text) pageText = res.text;
      }
      if (!pageText) {
        return this.fail('Could not read this page. Enable "Read Page / DOM Context" in Settings and reload the page.');
      }
      if (signal.aborted) return this.fail("Task aborted.");
      this.scope.tempStore.set("pageText", pageText);
      const prompt = PromptBuilder.summarize(pageText, this.context.url, this.task.input);
      const gen = await this.aiRouter.generate(this.task.id, prompt, {
        needsHeavyReasoning: pageText.length > 2e3,
        pageTextChars: pageText.length
      });
      if (!gen.ok) return this.fail(gen.error ?? "AI generation failed.");
      return {
        taskId: this.task.id,
        ok: true,
        engine: gen.engine,
        text: gen.text.trim(),
        provenance: `Summary (${gen.engine === "cloud" ? "Cloud Gemini" : gen.engine === "on-device" ? "Gemini Nano on-device" : gen.engine === "local-server" ? "local server" : "local extractive fallback"})`
      };
    }
    /** Free-form chat with the current page as context. */
    async runChat(signal) {
      const prompt = PromptBuilder.chat(this.task.input, this.context);
      const gen = await this.aiRouter.generate(this.task.id, prompt, { needsHeavyReasoning: false, pageTextChars: 0 });
      if (signal.aborted) return this.fail("Task aborted.");
      if (!gen.ok) return this.fail(gen.error ?? "AI generation failed.");
      return {
        taskId: this.task.id,
        ok: true,
        engine: gen.engine,
        text: gen.text.trim(),
        provenance: `Answered (${gen.engine === "cloud" ? "Cloud Gemini" : gen.engine === "on-device" ? "Gemini Nano on-device" : gen.engine === "local-server" ? "local server" : "local extractive fallback"})`
      };
    }
    /** P6: destroy the worker — abort + wipe temp data. Called by the Orchestrator. */
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.scope.cleanup();
    }
    async sendToTab(tabId, message) {
      try {
        return await chrome.tabs.sendMessage(tabId, message);
      } catch {
        return { ok: false, error: "Content script did not respond (reload the tab and try again)." };
      }
    }
    fail(message) {
      return { taskId: this.task.id, ok: false, engine: "none", text: "", provenance: "Failed", error: message };
    }
  }
  class AgentFactory {
    constructor(aiRouter, permissions) {
      __publicField(this, "aiRouter");
      __publicField(this, "permissions");
      this.aiRouter = aiRouter;
      this.permissions = permissions;
    }
    create(kind, task, context, tempTtlSeconds, insertIntoPage) {
      return new SubAgent(kind, task, context, this.aiRouter, this.permissions, tempTtlSeconds, insertIntoPage);
    }
  }
  const getDefaultsFromPostinstall = () => void 0;
  var define_process_env_default = {};
  /**
   * @license
   * Copyright 2017 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  const stringToByteArray$1 = function(str) {
    const out = [];
    let p = 0;
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c < 128) {
        out[p++] = c;
      } else if (c < 2048) {
        out[p++] = c >> 6 | 192;
        out[p++] = c & 63 | 128;
      } else if ((c & 64512) === 55296 && i + 1 < str.length && (str.charCodeAt(i + 1) & 64512) === 56320) {
        c = 65536 + ((c & 1023) << 10) + (str.charCodeAt(++i) & 1023);
        out[p++] = c >> 18 | 240;
        out[p++] = c >> 12 & 63 | 128;
        out[p++] = c >> 6 & 63 | 128;
        out[p++] = c & 63 | 128;
      } else {
        out[p++] = c >> 12 | 224;
        out[p++] = c >> 6 & 63 | 128;
        out[p++] = c & 63 | 128;
      }
    }
    return out;
  };
  const byteArrayToString = function(bytes) {
    const out = [];
    let pos = 0, c = 0;
    while (pos < bytes.length) {
      const c1 = bytes[pos++];
      if (c1 < 128) {
        out[c++] = String.fromCharCode(c1);
      } else if (c1 > 191 && c1 < 224) {
        const c2 = bytes[pos++];
        out[c++] = String.fromCharCode((c1 & 31) << 6 | c2 & 63);
      } else if (c1 > 239 && c1 < 365) {
        const c2 = bytes[pos++];
        const c3 = bytes[pos++];
        const c4 = bytes[pos++];
        const u = ((c1 & 7) << 18 | (c2 & 63) << 12 | (c3 & 63) << 6 | c4 & 63) - 65536;
        out[c++] = String.fromCharCode(55296 + (u >> 10));
        out[c++] = String.fromCharCode(56320 + (u & 1023));
      } else {
        const c2 = bytes[pos++];
        const c3 = bytes[pos++];
        out[c++] = String.fromCharCode((c1 & 15) << 12 | (c2 & 63) << 6 | c3 & 63);
      }
    }
    return out.join("");
  };
  const base64 = {
    /**
     * Maps bytes to characters.
     */
    byteToCharMap_: null,
    /**
     * Maps characters to bytes.
     */
    charToByteMap_: null,
    /**
     * Maps bytes to websafe characters.
     * @private
     */
    byteToCharMapWebSafe_: null,
    /**
     * Maps websafe characters to bytes.
     * @private
     */
    charToByteMapWebSafe_: null,
    /**
     * Our default alphabet, shared between
     * ENCODED_VALS and ENCODED_VALS_WEBSAFE
     */
    ENCODED_VALS_BASE: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
    /**
     * Our default alphabet. Value 64 (=) is special; it means "nothing."
     */
    get ENCODED_VALS() {
      return this.ENCODED_VALS_BASE + "+/=";
    },
    /**
     * Our websafe alphabet.
     */
    get ENCODED_VALS_WEBSAFE() {
      return this.ENCODED_VALS_BASE + "-_.";
    },
    /**
     * Whether this browser supports the atob and btoa functions. This extension
     * started at Mozilla but is now implemented by many browsers. We use the
     * ASSUME_* variables to avoid pulling in the full useragent detection library
     * but still allowing the standard per-browser compilations.
     *
     */
    HAS_NATIVE_SUPPORT: typeof atob === "function",
    /**
     * Base64-encode an array of bytes.
     *
     * @param input An array of bytes (numbers with
     *     value in [0, 255]) to encode.
     * @param webSafe Boolean indicating we should use the
     *     alternative alphabet.
     * @return The base64 encoded string.
     */
    encodeByteArray(input, webSafe) {
      if (!Array.isArray(input)) {
        throw Error("encodeByteArray takes an array as a parameter");
      }
      this.init_();
      const byteToCharMap = webSafe ? this.byteToCharMapWebSafe_ : this.byteToCharMap_;
      const output = [];
      for (let i = 0; i < input.length; i += 3) {
        const byte1 = input[i];
        const haveByte2 = i + 1 < input.length;
        const byte2 = haveByte2 ? input[i + 1] : 0;
        const haveByte3 = i + 2 < input.length;
        const byte3 = haveByte3 ? input[i + 2] : 0;
        const outByte1 = byte1 >> 2;
        const outByte2 = (byte1 & 3) << 4 | byte2 >> 4;
        let outByte3 = (byte2 & 15) << 2 | byte3 >> 6;
        let outByte4 = byte3 & 63;
        if (!haveByte3) {
          outByte4 = 64;
          if (!haveByte2) {
            outByte3 = 64;
          }
        }
        output.push(byteToCharMap[outByte1], byteToCharMap[outByte2], byteToCharMap[outByte3], byteToCharMap[outByte4]);
      }
      return output.join("");
    },
    /**
     * Base64-encode a string.
     *
     * @param input A string to encode.
     * @param webSafe If true, we should use the
     *     alternative alphabet.
     * @return The base64 encoded string.
     */
    encodeString(input, webSafe) {
      if (this.HAS_NATIVE_SUPPORT && !webSafe) {
        return btoa(input);
      }
      return this.encodeByteArray(stringToByteArray$1(input), webSafe);
    },
    /**
     * Base64-decode a string.
     *
     * @param input to decode.
     * @param webSafe True if we should use the
     *     alternative alphabet.
     * @return string representing the decoded value.
     */
    decodeString(input, webSafe) {
      if (this.HAS_NATIVE_SUPPORT && !webSafe) {
        return atob(input);
      }
      return byteArrayToString(this.decodeStringToByteArray(input, webSafe));
    },
    /**
     * Base64-decode a string.
     *
     * In base-64 decoding, groups of four characters are converted into three
     * bytes.  If the encoder did not apply padding, the input length may not
     * be a multiple of 4.
     *
     * In this case, the last group will have fewer than 4 characters, and
     * padding will be inferred.  If the group has one or two characters, it decodes
     * to one byte.  If the group has three characters, it decodes to two bytes.
     *
     * @param input Input to decode.
     * @param webSafe True if we should use the web-safe alphabet.
     * @return bytes representing the decoded value.
     */
    decodeStringToByteArray(input, webSafe) {
      this.init_();
      const charToByteMap = webSafe ? this.charToByteMapWebSafe_ : this.charToByteMap_;
      const output = [];
      for (let i = 0; i < input.length; ) {
        const byte1 = charToByteMap[input.charAt(i++)];
        const haveByte2 = i < input.length;
        const byte2 = haveByte2 ? charToByteMap[input.charAt(i)] : 0;
        ++i;
        const haveByte3 = i < input.length;
        const byte3 = haveByte3 ? charToByteMap[input.charAt(i)] : 64;
        ++i;
        const haveByte4 = i < input.length;
        const byte4 = haveByte4 ? charToByteMap[input.charAt(i)] : 64;
        ++i;
        if (byte1 == null || byte2 == null || byte3 == null || byte4 == null) {
          throw new DecodeBase64StringError();
        }
        const outByte1 = byte1 << 2 | byte2 >> 4;
        output.push(outByte1);
        if (byte3 !== 64) {
          const outByte2 = byte2 << 4 & 240 | byte3 >> 2;
          output.push(outByte2);
          if (byte4 !== 64) {
            const outByte3 = byte3 << 6 & 192 | byte4;
            output.push(outByte3);
          }
        }
      }
      return output;
    },
    /**
     * Lazy static initialization function. Called before
     * accessing any of the static map variables.
     * @private
     */
    init_() {
      if (!this.byteToCharMap_) {
        this.byteToCharMap_ = {};
        this.charToByteMap_ = {};
        this.byteToCharMapWebSafe_ = {};
        this.charToByteMapWebSafe_ = {};
        for (let i = 0; i < this.ENCODED_VALS.length; i++) {
          this.byteToCharMap_[i] = this.ENCODED_VALS.charAt(i);
          this.charToByteMap_[this.byteToCharMap_[i]] = i;
          this.byteToCharMapWebSafe_[i] = this.ENCODED_VALS_WEBSAFE.charAt(i);
          this.charToByteMapWebSafe_[this.byteToCharMapWebSafe_[i]] = i;
          if (i >= this.ENCODED_VALS_BASE.length) {
            this.charToByteMap_[this.ENCODED_VALS_WEBSAFE.charAt(i)] = i;
            this.charToByteMapWebSafe_[this.ENCODED_VALS.charAt(i)] = i;
          }
        }
      }
    }
  };
  class DecodeBase64StringError extends Error {
    constructor() {
      super(...arguments);
      this.name = "DecodeBase64StringError";
    }
  }
  const base64Encode = function(str) {
    const utf8Bytes = stringToByteArray$1(str);
    return base64.encodeByteArray(utf8Bytes, true);
  };
  const base64urlEncodeWithoutPadding = function(str) {
    return base64Encode(str).replace(/\./g, "");
  };
  const base64Decode = function(str) {
    try {
      return base64.decodeString(str, true);
    } catch (e) {
      console.error("base64Decode failed: ", e);
    }
    return null;
  };
  /**
   * @license
   * Copyright 2022 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  function getGlobal() {
    if (typeof self !== "undefined") {
      return self;
    }
    if (typeof window !== "undefined") {
      return window;
    }
    if (typeof global !== "undefined") {
      return global;
    }
    throw new Error("Unable to locate global object.");
  }
  /**
   * @license
   * Copyright 2022 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  const getDefaultsFromGlobal = () => getGlobal().__FIREBASE_DEFAULTS__;
  const getDefaultsFromEnvVariable = () => {
    if (typeof process === "undefined" || typeof define_process_env_default === "undefined") {
      return;
    }
    const defaultsJsonString = define_process_env_default.__FIREBASE_DEFAULTS__;
    if (defaultsJsonString) {
      return JSON.parse(defaultsJsonString);
    }
  };
  const getDefaultsFromCookie = () => {
    if (typeof document === "undefined") {
      return;
    }
    let match;
    try {
      match = document.cookie.match(/__FIREBASE_DEFAULTS__=([^;]+)/);
    } catch (e) {
      return;
    }
    const decoded = match && base64Decode(match[1]);
    return decoded && JSON.parse(decoded);
  };
  const getDefaults = () => {
    try {
      return getDefaultsFromPostinstall() || getDefaultsFromGlobal() || getDefaultsFromEnvVariable() || getDefaultsFromCookie();
    } catch (e) {
      console.info(`Unable to get __FIREBASE_DEFAULTS__ due to: ${e}`);
      return;
    }
  };
  const getDefaultAppConfig = () => {
    var _a;
    return (_a = getDefaults()) == null ? void 0 : _a.config;
  };
  /**
   * @license
   * Copyright 2017 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  class Deferred {
    constructor() {
      this.reject = () => {
      };
      this.resolve = () => {
      };
      this.promise = new Promise((resolve, reject) => {
        this.resolve = resolve;
        this.reject = reject;
      });
    }
    /**
     * Our API internals are not promisified and cannot because our callback APIs have subtle expectations around
     * invoking promises inline, which Promises are forbidden to do. This method accepts an optional node-style callback
     * and returns a node-style callback which will resolve or reject the Deferred's promise.
     */
    wrapCallback(callback) {
      return (error, value) => {
        if (error) {
          this.reject(error);
        } else {
          this.resolve(value);
        }
        if (typeof callback === "function") {
          this.promise.catch(() => {
          });
          if (callback.length === 1) {
            callback(error);
          } else {
            callback(error, value);
          }
        }
      };
    }
  }
  function isIndexedDBAvailable() {
    try {
      return typeof indexedDB === "object";
    } catch (e) {
      return false;
    }
  }
  function validateIndexedDBOpenable() {
    return new Promise((resolve, reject) => {
      try {
        let preExist = true;
        const DB_CHECK_NAME = "validate-browser-context-for-indexeddb-analytics-module";
        const request = self.indexedDB.open(DB_CHECK_NAME);
        request.onsuccess = () => {
          request.result.close();
          if (!preExist) {
            self.indexedDB.deleteDatabase(DB_CHECK_NAME);
          }
          resolve(true);
        };
        request.onupgradeneeded = () => {
          preExist = false;
        };
        request.onerror = () => {
          var _a;
          reject(((_a = request.error) == null ? void 0 : _a.message) || "");
        };
      } catch (error) {
        reject(error);
      }
    });
  }
  /**
   * @license
   * Copyright 2017 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  const ERROR_NAME = "FirebaseError";
  class FirebaseError extends Error {
    constructor(code, message, customData) {
      super(message);
      this.code = code;
      this.customData = customData;
      this.name = ERROR_NAME;
      Object.setPrototypeOf(this, FirebaseError.prototype);
      if (Error.captureStackTrace) {
        Error.captureStackTrace(this, ErrorFactory.prototype.create);
      }
    }
  }
  class ErrorFactory {
    constructor(service, serviceName, errors) {
      this.service = service;
      this.serviceName = serviceName;
      this.errors = errors;
    }
    create(code, ...data) {
      const customData = data[0] || {};
      const fullCode = `${this.service}/${code}`;
      const template = this.errors[code];
      const message = template ? replaceTemplate(template, customData) : "Error";
      const fullMessage = `${this.serviceName}: ${message} (${fullCode}).`;
      const error = new FirebaseError(fullCode, fullMessage, customData);
      return error;
    }
  }
  function replaceTemplate(template, data) {
    try {
      let ptr = 0;
      let result = "";
      while (ptr < template.length) {
        const start = template.indexOf("{$", ptr);
        if (start === -1) {
          result += template.substring(ptr);
          break;
        }
        const end = template.indexOf("}", start + 2);
        if (end === -1) {
          result += template.substring(ptr);
          break;
        }
        const key = template.substring(start + 2, end);
        const value = data[key];
        result += template.substring(ptr, start) + (value != null ? String(value) : `<${key}?>`);
        ptr = end + 1;
      }
      return result;
    } catch (e) {
      return template;
    }
  }
  function deepEqual(a, b) {
    if (a === b) {
      return true;
    }
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    for (const k of aKeys) {
      if (!bKeys.includes(k)) {
        return false;
      }
      const aProp = a[k];
      const bProp = b[k];
      if (isObject(aProp) && isObject(bProp)) {
        if (!deepEqual(aProp, bProp)) {
          return false;
        }
      } else if (aProp !== bProp) {
        return false;
      }
    }
    for (const k of bKeys) {
      if (!aKeys.includes(k)) {
        return false;
      }
    }
    return true;
  }
  function isObject(thing) {
    return thing !== null && typeof thing === "object";
  }
  /**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  const DEFAULT_INTERVAL_MILLIS = 1e3;
  const DEFAULT_BACKOFF_FACTOR = 2;
  const MAX_VALUE_MILLIS = 4 * 60 * 60 * 1e3;
  const RANDOM_FACTOR = 0.5;
  function calculateBackoffMillis(backoffCount, intervalMillis = DEFAULT_INTERVAL_MILLIS, backoffFactor = DEFAULT_BACKOFF_FACTOR) {
    const currBaseValue = intervalMillis * Math.pow(backoffFactor, backoffCount);
    const randomWait = Math.round(
      // A fraction of the backoff value to add/subtract.
      // Deviation: changes multiplication order to improve readability.
      RANDOM_FACTOR * currBaseValue * // A random float (rounded to int by Math.round above) in the range [-1, 1]. Determines
      // if we add or subtract.
      (Math.random() - 0.5) * 2
    );
    return Math.min(MAX_VALUE_MILLIS, currBaseValue + randomWait);
  }
  /**
   * @license
   * Copyright 2021 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  function getModularInstance(service) {
    if (service && service._delegate) {
      return service._delegate;
    } else {
      return service;
    }
  }
  class Component {
    /**
     *
     * @param name The public service name, e.g. app, auth, firestore, database
     * @param instanceFactory Service factory responsible for creating the public interface
     * @param type whether the service provided by the component is public or private
     */
    constructor(name2, instanceFactory, type) {
      this.name = name2;
      this.instanceFactory = instanceFactory;
      this.type = type;
      this.multipleInstances = false;
      this.serviceProps = {};
      this.instantiationMode = "LAZY";
      this.onInstanceCreated = null;
    }
    setInstantiationMode(mode) {
      this.instantiationMode = mode;
      return this;
    }
    setMultipleInstances(multipleInstances) {
      this.multipleInstances = multipleInstances;
      return this;
    }
    setServiceProps(props) {
      this.serviceProps = props;
      return this;
    }
    setInstanceCreatedCallback(callback) {
      this.onInstanceCreated = callback;
      return this;
    }
  }
  /**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  const DEFAULT_ENTRY_NAME$1 = "[DEFAULT]";
  /**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  class Provider {
    constructor(name2, container) {
      this.name = name2;
      this.container = container;
      this.component = null;
      this.instances = /* @__PURE__ */ new Map();
      this.instancesDeferred = /* @__PURE__ */ new Map();
      this.instancesOptions = /* @__PURE__ */ new Map();
      this.onInitCallbacks = /* @__PURE__ */ new Map();
    }
    /**
     * @param identifier A provider can provide multiple instances of a service
     * if this.component.multipleInstances is true.
     */
    get(identifier) {
      const normalizedIdentifier = this.normalizeInstanceIdentifier(identifier);
      if (!this.instancesDeferred.has(normalizedIdentifier)) {
        const deferred = new Deferred();
        this.instancesDeferred.set(normalizedIdentifier, deferred);
        if (this.isInitialized(normalizedIdentifier) || this.shouldAutoInitialize()) {
          try {
            const instance = this.getOrInitializeService({
              instanceIdentifier: normalizedIdentifier
            });
            if (instance) {
              deferred.resolve(instance);
            }
          } catch (e) {
          }
        }
      }
      return this.instancesDeferred.get(normalizedIdentifier).promise;
    }
    getImmediate(options) {
      const normalizedIdentifier = this.normalizeInstanceIdentifier(options == null ? void 0 : options.identifier);
      const optional = (options == null ? void 0 : options.optional) ?? false;
      if (this.isInitialized(normalizedIdentifier) || this.shouldAutoInitialize()) {
        try {
          return this.getOrInitializeService({
            instanceIdentifier: normalizedIdentifier
          });
        } catch (e) {
          if (optional) {
            return null;
          } else {
            throw e;
          }
        }
      } else {
        if (optional) {
          return null;
        } else {
          throw Error(`Service ${this.name} is not available`);
        }
      }
    }
    getComponent() {
      return this.component;
    }
    setComponent(component) {
      if (component.name !== this.name) {
        throw Error(`Mismatching Component ${component.name} for Provider ${this.name}.`);
      }
      if (this.component) {
        throw Error(`Component for ${this.name} has already been provided`);
      }
      this.component = component;
      if (!this.shouldAutoInitialize()) {
        return;
      }
      if (isComponentEager(component)) {
        try {
          this.getOrInitializeService({ instanceIdentifier: DEFAULT_ENTRY_NAME$1 });
        } catch (e) {
        }
      }
      for (const [instanceIdentifier, instanceDeferred] of this.instancesDeferred.entries()) {
        const normalizedIdentifier = this.normalizeInstanceIdentifier(instanceIdentifier);
        try {
          const instance = this.getOrInitializeService({
            instanceIdentifier: normalizedIdentifier
          });
          instanceDeferred.resolve(instance);
        } catch (e) {
        }
      }
    }
    clearInstance(identifier = DEFAULT_ENTRY_NAME$1) {
      this.instancesDeferred.delete(identifier);
      this.instancesOptions.delete(identifier);
      this.instances.delete(identifier);
    }
    // app.delete() will call this method on every provider to delete the services
    // TODO: should we mark the provider as deleted?
    async delete() {
      const services = Array.from(this.instances.values());
      await Promise.all([
        ...services.filter((service) => "INTERNAL" in service).map((service) => service.INTERNAL.delete()),
        ...services.filter((service) => "_delete" in service).map((service) => service._delete())
      ]);
    }
    isComponentSet() {
      return this.component != null;
    }
    isInitialized(identifier = DEFAULT_ENTRY_NAME$1) {
      return this.instances.has(identifier);
    }
    getOptions(identifier = DEFAULT_ENTRY_NAME$1) {
      return this.instancesOptions.get(identifier) || {};
    }
    initialize(opts = {}) {
      const { options = {} } = opts;
      const normalizedIdentifier = this.normalizeInstanceIdentifier(opts.instanceIdentifier);
      if (this.isInitialized(normalizedIdentifier)) {
        throw Error(`${this.name}(${normalizedIdentifier}) has already been initialized`);
      }
      if (!this.isComponentSet()) {
        throw Error(`Component ${this.name} has not been registered yet`);
      }
      const instance = this.getOrInitializeService({
        instanceIdentifier: normalizedIdentifier,
        options
      });
      for (const [instanceIdentifier, instanceDeferred] of this.instancesDeferred.entries()) {
        const normalizedDeferredIdentifier = this.normalizeInstanceIdentifier(instanceIdentifier);
        if (normalizedIdentifier === normalizedDeferredIdentifier) {
          instanceDeferred.resolve(instance);
        }
      }
      return instance;
    }
    /**
     *
     * @param callback - a function that will be invoked  after the provider has been initialized by calling provider.initialize().
     * The function is invoked SYNCHRONOUSLY, so it should not execute any longrunning tasks in order to not block the program.
     *
     * @param identifier An optional instance identifier
     * @returns a function to unregister the callback
     */
    onInit(callback, identifier) {
      const normalizedIdentifier = this.normalizeInstanceIdentifier(identifier);
      const existingCallbacks = this.onInitCallbacks.get(normalizedIdentifier) ?? /* @__PURE__ */ new Set();
      existingCallbacks.add(callback);
      this.onInitCallbacks.set(normalizedIdentifier, existingCallbacks);
      const existingInstance = this.instances.get(normalizedIdentifier);
      if (existingInstance) {
        callback(existingInstance, normalizedIdentifier);
      }
      return () => {
        existingCallbacks.delete(callback);
      };
    }
    /**
     * Invoke onInit callbacks synchronously
     * @param instance the service instance`
     */
    invokeOnInitCallbacks(instance, identifier) {
      const callbacks = this.onInitCallbacks.get(identifier);
      if (!callbacks) {
        return;
      }
      for (const callback of callbacks) {
        try {
          callback(instance, identifier);
        } catch {
        }
      }
    }
    getOrInitializeService({ instanceIdentifier, options = {} }) {
      let instance = this.instances.get(instanceIdentifier);
      if (!instance && this.component) {
        instance = this.component.instanceFactory(this.container, {
          instanceIdentifier: normalizeIdentifierForFactory(instanceIdentifier),
          options
        });
        this.instances.set(instanceIdentifier, instance);
        this.instancesOptions.set(instanceIdentifier, options);
        this.invokeOnInitCallbacks(instance, instanceIdentifier);
        if (this.component.onInstanceCreated) {
          try {
            this.component.onInstanceCreated(this.container, instanceIdentifier, instance);
          } catch {
          }
        }
      }
      return instance || null;
    }
    normalizeInstanceIdentifier(identifier = DEFAULT_ENTRY_NAME$1) {
      if (this.component) {
        return this.component.multipleInstances ? identifier : DEFAULT_ENTRY_NAME$1;
      } else {
        return identifier;
      }
    }
    shouldAutoInitialize() {
      return !!this.component && this.component.instantiationMode !== "EXPLICIT";
    }
  }
  function normalizeIdentifierForFactory(identifier) {
    return identifier === DEFAULT_ENTRY_NAME$1 ? void 0 : identifier;
  }
  function isComponentEager(component) {
    return component.instantiationMode === "EAGER";
  }
  /**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  class ComponentContainer {
    constructor(name2) {
      this.name = name2;
      this.providers = /* @__PURE__ */ new Map();
    }
    /**
     *
     * @param component Component being added
     * @param overwrite When a component with the same name has already been registered,
     * if overwrite is true: overwrite the existing component with the new component and create a new
     * provider with the new component. It can be useful in tests where you want to use different mocks
     * for different tests.
     * if overwrite is false: throw an exception
     */
    addComponent(component) {
      const provider = this.getProvider(component.name);
      if (provider.isComponentSet()) {
        throw new Error(`Component ${component.name} has already been registered with ${this.name}`);
      }
      provider.setComponent(component);
    }
    addOrOverwriteComponent(component) {
      const provider = this.getProvider(component.name);
      if (provider.isComponentSet()) {
        this.providers.delete(component.name);
      }
      this.addComponent(component);
    }
    /**
     * getProvider provides a type safe interface where it can only be called with a field name
     * present in NameServiceMapping interface.
     *
     * Firebase SDKs providing services should extend NameServiceMapping interface to register
     * themselves.
     */
    getProvider(name2) {
      if (this.providers.has(name2)) {
        return this.providers.get(name2);
      }
      const provider = new Provider(name2, this);
      this.providers.set(name2, provider);
      return provider;
    }
    getProviders() {
      return Array.from(this.providers.values());
    }
  }
  /**
   * @license
   * Copyright 2017 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  var LogLevel;
  (function(LogLevel2) {
    LogLevel2[LogLevel2["DEBUG"] = 0] = "DEBUG";
    LogLevel2[LogLevel2["VERBOSE"] = 1] = "VERBOSE";
    LogLevel2[LogLevel2["INFO"] = 2] = "INFO";
    LogLevel2[LogLevel2["WARN"] = 3] = "WARN";
    LogLevel2[LogLevel2["ERROR"] = 4] = "ERROR";
    LogLevel2[LogLevel2["SILENT"] = 5] = "SILENT";
  })(LogLevel || (LogLevel = {}));
  const levelStringToEnum = {
    "debug": LogLevel.DEBUG,
    "verbose": LogLevel.VERBOSE,
    "info": LogLevel.INFO,
    "warn": LogLevel.WARN,
    "error": LogLevel.ERROR,
    "silent": LogLevel.SILENT
  };
  const defaultLogLevel = LogLevel.INFO;
  const ConsoleMethod = {
    [LogLevel.DEBUG]: "log",
    [LogLevel.VERBOSE]: "log",
    [LogLevel.INFO]: "info",
    [LogLevel.WARN]: "warn",
    [LogLevel.ERROR]: "error"
  };
  const defaultLogHandler = (instance, logType, ...args) => {
    if (logType < instance.logLevel) {
      return;
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const method = ConsoleMethod[logType];
    if (method) {
      console[method](`[${now}]  ${instance.name}:`, ...args);
    } else {
      throw new Error(`Attempted to log a message with an invalid logType (value: ${logType})`);
    }
  };
  class Logger {
    /**
     * Gives you an instance of a Logger to capture messages according to
     * Firebase's logging scheme.
     *
     * @param name The name that the logs will be associated with
     */
    constructor(name2) {
      this.name = name2;
      this._logLevel = defaultLogLevel;
      this._logHandler = defaultLogHandler;
      this._userLogHandler = null;
    }
    get logLevel() {
      return this._logLevel;
    }
    set logLevel(val) {
      if (!(val in LogLevel)) {
        throw new TypeError(`Invalid value "${val}" assigned to \`logLevel\``);
      }
      this._logLevel = val;
    }
    // Workaround for setter/getter having to be the same type.
    setLogLevel(val) {
      this._logLevel = typeof val === "string" ? levelStringToEnum[val] : val;
    }
    get logHandler() {
      return this._logHandler;
    }
    set logHandler(val) {
      if (typeof val !== "function") {
        throw new TypeError("Value assigned to `logHandler` must be a function");
      }
      this._logHandler = val;
    }
    get userLogHandler() {
      return this._userLogHandler;
    }
    set userLogHandler(val) {
      this._userLogHandler = val;
    }
    /**
     * The functions below are all based on the `console` interface
     */
    debug(...args) {
      this._userLogHandler && this._userLogHandler(this, LogLevel.DEBUG, ...args);
      this._logHandler(this, LogLevel.DEBUG, ...args);
    }
    log(...args) {
      this._userLogHandler && this._userLogHandler(this, LogLevel.VERBOSE, ...args);
      this._logHandler(this, LogLevel.VERBOSE, ...args);
    }
    info(...args) {
      this._userLogHandler && this._userLogHandler(this, LogLevel.INFO, ...args);
      this._logHandler(this, LogLevel.INFO, ...args);
    }
    warn(...args) {
      this._userLogHandler && this._userLogHandler(this, LogLevel.WARN, ...args);
      this._logHandler(this, LogLevel.WARN, ...args);
    }
    error(...args) {
      this._userLogHandler && this._userLogHandler(this, LogLevel.ERROR, ...args);
      this._logHandler(this, LogLevel.ERROR, ...args);
    }
  }
  const instanceOfAny = (object, constructors) => constructors.some((c) => object instanceof c);
  let idbProxyableTypes;
  let cursorAdvanceMethods;
  function getIdbProxyableTypes() {
    return idbProxyableTypes || (idbProxyableTypes = [
      IDBDatabase,
      IDBObjectStore,
      IDBIndex,
      IDBCursor,
      IDBTransaction
    ]);
  }
  function getCursorAdvanceMethods() {
    return cursorAdvanceMethods || (cursorAdvanceMethods = [
      IDBCursor.prototype.advance,
      IDBCursor.prototype.continue,
      IDBCursor.prototype.continuePrimaryKey
    ]);
  }
  const cursorRequestMap = /* @__PURE__ */ new WeakMap();
  const transactionDoneMap = /* @__PURE__ */ new WeakMap();
  const transactionStoreNamesMap = /* @__PURE__ */ new WeakMap();
  const transformCache = /* @__PURE__ */ new WeakMap();
  const reverseTransformCache = /* @__PURE__ */ new WeakMap();
  function promisifyRequest(request) {
    const promise = new Promise((resolve, reject) => {
      const unlisten = () => {
        request.removeEventListener("success", success);
        request.removeEventListener("error", error);
      };
      const success = () => {
        resolve(wrap(request.result));
        unlisten();
      };
      const error = () => {
        reject(request.error);
        unlisten();
      };
      request.addEventListener("success", success);
      request.addEventListener("error", error);
    });
    promise.then((value) => {
      if (value instanceof IDBCursor) {
        cursorRequestMap.set(value, request);
      }
    }).catch(() => {
    });
    reverseTransformCache.set(promise, request);
    return promise;
  }
  function cacheDonePromiseForTransaction(tx) {
    if (transactionDoneMap.has(tx))
      return;
    const done = new Promise((resolve, reject) => {
      const unlisten = () => {
        tx.removeEventListener("complete", complete);
        tx.removeEventListener("error", error);
        tx.removeEventListener("abort", error);
      };
      const complete = () => {
        resolve();
        unlisten();
      };
      const error = () => {
        reject(tx.error || new DOMException("AbortError", "AbortError"));
        unlisten();
      };
      tx.addEventListener("complete", complete);
      tx.addEventListener("error", error);
      tx.addEventListener("abort", error);
    });
    transactionDoneMap.set(tx, done);
  }
  let idbProxyTraps = {
    get(target, prop, receiver) {
      if (target instanceof IDBTransaction) {
        if (prop === "done")
          return transactionDoneMap.get(target);
        if (prop === "objectStoreNames") {
          return target.objectStoreNames || transactionStoreNamesMap.get(target);
        }
        if (prop === "store") {
          return receiver.objectStoreNames[1] ? void 0 : receiver.objectStore(receiver.objectStoreNames[0]);
        }
      }
      return wrap(target[prop]);
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
    has(target, prop) {
      if (target instanceof IDBTransaction && (prop === "done" || prop === "store")) {
        return true;
      }
      return prop in target;
    }
  };
  function replaceTraps(callback) {
    idbProxyTraps = callback(idbProxyTraps);
  }
  function wrapFunction(func) {
    if (func === IDBDatabase.prototype.transaction && !("objectStoreNames" in IDBTransaction.prototype)) {
      return function(storeNames, ...args) {
        const tx = func.call(unwrap(this), storeNames, ...args);
        transactionStoreNamesMap.set(tx, storeNames.sort ? storeNames.sort() : [storeNames]);
        return wrap(tx);
      };
    }
    if (getCursorAdvanceMethods().includes(func)) {
      return function(...args) {
        func.apply(unwrap(this), args);
        return wrap(cursorRequestMap.get(this));
      };
    }
    return function(...args) {
      return wrap(func.apply(unwrap(this), args));
    };
  }
  function transformCachableValue(value) {
    if (typeof value === "function")
      return wrapFunction(value);
    if (value instanceof IDBTransaction)
      cacheDonePromiseForTransaction(value);
    if (instanceOfAny(value, getIdbProxyableTypes()))
      return new Proxy(value, idbProxyTraps);
    return value;
  }
  function wrap(value) {
    if (value instanceof IDBRequest)
      return promisifyRequest(value);
    if (transformCache.has(value))
      return transformCache.get(value);
    const newValue = transformCachableValue(value);
    if (newValue !== value) {
      transformCache.set(value, newValue);
      reverseTransformCache.set(newValue, value);
    }
    return newValue;
  }
  const unwrap = (value) => reverseTransformCache.get(value);
  function openDB(name2, version2, { blocked, upgrade, blocking, terminated } = {}) {
    const request = indexedDB.open(name2, version2);
    const openPromise = wrap(request);
    if (upgrade) {
      request.addEventListener("upgradeneeded", (event) => {
        upgrade(wrap(request.result), event.oldVersion, event.newVersion, wrap(request.transaction), event);
      });
    }
    if (blocked) {
      request.addEventListener("blocked", (event) => blocked(
        // Casting due to https://github.com/microsoft/TypeScript-DOM-lib-generator/pull/1405
        event.oldVersion,
        event.newVersion,
        event
      ));
    }
    openPromise.then((db) => {
      if (terminated)
        db.addEventListener("close", () => terminated());
      if (blocking) {
        db.addEventListener("versionchange", (event) => blocking(event.oldVersion, event.newVersion, event));
      }
    }).catch(() => {
    });
    return openPromise;
  }
  const readMethods = ["get", "getKey", "getAll", "getAllKeys", "count"];
  const writeMethods = ["put", "add", "delete", "clear"];
  const cachedMethods = /* @__PURE__ */ new Map();
  function getMethod(target, prop) {
    if (!(target instanceof IDBDatabase && !(prop in target) && typeof prop === "string")) {
      return;
    }
    if (cachedMethods.get(prop))
      return cachedMethods.get(prop);
    const targetFuncName = prop.replace(/FromIndex$/, "");
    const useIndex = prop !== targetFuncName;
    const isWrite = writeMethods.includes(targetFuncName);
    if (
      // Bail if the target doesn't exist on the target. Eg, getAll isn't in Edge.
      !(targetFuncName in (useIndex ? IDBIndex : IDBObjectStore).prototype) || !(isWrite || readMethods.includes(targetFuncName))
    ) {
      return;
    }
    const method = async function(storeName, ...args) {
      const tx = this.transaction(storeName, isWrite ? "readwrite" : "readonly");
      let target2 = tx.store;
      if (useIndex)
        target2 = target2.index(args.shift());
      return (await Promise.all([
        target2[targetFuncName](...args),
        isWrite && tx.done
      ]))[0];
    };
    cachedMethods.set(prop, method);
    return method;
  }
  replaceTraps((oldTraps) => ({
    ...oldTraps,
    get: (target, prop, receiver) => getMethod(target, prop) || oldTraps.get(target, prop, receiver),
    has: (target, prop) => !!getMethod(target, prop) || oldTraps.has(target, prop)
  }));
  /**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  class PlatformLoggerServiceImpl {
    constructor(container) {
      this.container = container;
    }
    // In initial implementation, this will be called by installations on
    // auth token refresh, and installations will send this string.
    getPlatformInfoString() {
      const providers = this.container.getProviders();
      return providers.map((provider) => {
        if (isVersionServiceProvider(provider)) {
          const service = provider.getImmediate();
          return `${service.library}/${service.version}`;
        } else {
          return null;
        }
      }).filter((logString) => logString).join(" ");
    }
  }
  function isVersionServiceProvider(provider) {
    const component = provider.getComponent();
    return (component == null ? void 0 : component.type) === "VERSION";
  }
  const name$q = "@firebase/app";
  const version$1$1 = "0.16.2";
  /**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  const logger$2 = new Logger("@firebase/app");
  const name$p = "@firebase/app-compat";
  const name$o = "@firebase/analytics-compat";
  const name$n = "@firebase/analytics";
  const name$m = "@firebase/app-check-compat";
  const name$l = "@firebase/app-check";
  const name$k = "@firebase/auth";
  const name$j = "@firebase/auth-compat";
  const name$i = "@firebase/database";
  const name$h = "@firebase/data-connect";
  const name$g = "@firebase/database-compat";
  const name$f = "@firebase/functions";
  const name$e = "@firebase/functions-compat";
  const name$d = "@firebase/installations";
  const name$c = "@firebase/installations-compat";
  const name$b = "@firebase/messaging";
  const name$a = "@firebase/messaging-compat";
  const name$9 = "@firebase/performance";
  const name$8 = "@firebase/performance-compat";
  const name$7 = "@firebase/remote-config";
  const name$6 = "@firebase/remote-config-compat";
  const name$5 = "@firebase/storage";
  const name$4$1 = "@firebase/storage-compat";
  const name$3$1 = "@firebase/firestore";
  const name$2$1 = "@firebase/ai";
  const name$1$1 = "@firebase/firestore-compat";
  const name$r = "firebase";
  /**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  const DEFAULT_ENTRY_NAME = "[DEFAULT]";
  const PLATFORM_LOG_STRING = {
    [name$q]: "fire-core",
    [name$p]: "fire-core-compat",
    [name$n]: "fire-analytics",
    [name$o]: "fire-analytics-compat",
    [name$l]: "fire-app-check",
    [name$m]: "fire-app-check-compat",
    [name$k]: "fire-auth",
    [name$j]: "fire-auth-compat",
    [name$i]: "fire-rtdb",
    [name$h]: "fire-data-connect",
    [name$g]: "fire-rtdb-compat",
    [name$f]: "fire-fn",
    [name$e]: "fire-fn-compat",
    [name$d]: "fire-iid",
    [name$c]: "fire-iid-compat",
    [name$b]: "fire-fcm",
    [name$a]: "fire-fcm-compat",
    [name$9]: "fire-perf",
    [name$8]: "fire-perf-compat",
    [name$7]: "fire-rc",
    [name$6]: "fire-rc-compat",
    [name$5]: "fire-gcs",
    [name$4$1]: "fire-gcs-compat",
    [name$3$1]: "fire-fst",
    [name$1$1]: "fire-fst-compat",
    [name$2$1]: "fire-vertex",
    "fire-js": "fire-js",
    // Platform identifier for JS SDK.
    [name$r]: "fire-js-all"
  };
  /**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  const _apps = /* @__PURE__ */ new Map();
  const _serverApps = /* @__PURE__ */ new Map();
  const _components = /* @__PURE__ */ new Map();
  function _addComponent(app2, component) {
    try {
      app2.container.addComponent(component);
    } catch (e) {
      logger$2.debug(`Component ${component.name} failed to register with FirebaseApp ${app2.name}`, e);
    }
  }
  function _registerComponent(component) {
    const componentName = component.name;
    if (_components.has(componentName)) {
      logger$2.debug(`There were multiple attempts to register component ${componentName}.`);
      return false;
    }
    _components.set(componentName, component);
    for (const app2 of _apps.values()) {
      _addComponent(app2, component);
    }
    for (const serverApp of _serverApps.values()) {
      _addComponent(serverApp, component);
    }
    return true;
  }
  function _getProvider(app2, name2) {
    const heartbeatController = app2.container.getProvider("heartbeat").getImmediate({ optional: true });
    if (heartbeatController) {
      void heartbeatController.triggerHeartbeat();
    }
    return app2.container.getProvider(name2);
  }
  function _isFirebaseServerApp(obj) {
    if (obj === null || obj === void 0) {
      return false;
    }
    return obj.settings !== void 0;
  }
  /**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  const ERRORS$1 = {
    [
      "no-app"
      /* AppError.NO_APP */
    ]: "No Firebase App '{$appName}' has been created - call initializeApp() first",
    [
      "bad-app-name"
      /* AppError.BAD_APP_NAME */
    ]: "Illegal App name: '{$appName}'",
    [
      "duplicate-app"
      /* AppError.DUPLICATE_APP */
    ]: "Firebase App named '{$appName}' already exists with different {$mismatchedParam}. Existing: '{$oldValue}'. New: '{$newValue}'.",
    [
      "app-deleted"
      /* AppError.APP_DELETED */
    ]: "Firebase App named '{$appName}' already deleted",
    [
      "server-app-deleted"
      /* AppError.SERVER_APP_DELETED */
    ]: "Firebase Server App has been deleted",
    [
      "no-options"
      /* AppError.NO_OPTIONS */
    ]: "Need to provide options, when not being deployed to hosting via source.",
    [
      "invalid-app-argument"
      /* AppError.INVALID_APP_ARGUMENT */
    ]: "firebase.{$appName}() takes either no argument or a Firebase App instance.",
    [
      "invalid-log-argument"
      /* AppError.INVALID_LOG_ARGUMENT */
    ]: "First argument to `onLog` must be null or a function.",
    [
      "idb-open"
      /* AppError.IDB_OPEN */
    ]: "Error thrown when opening IndexedDB. Original error: {$originalErrorMessage}.",
    [
      "idb-get"
      /* AppError.IDB_GET */
    ]: "Error thrown when reading from IndexedDB. Original error: {$originalErrorMessage}.",
    [
      "idb-set"
      /* AppError.IDB_WRITE */
    ]: "Error thrown when writing to IndexedDB. Original error: {$originalErrorMessage}.",
    [
      "idb-delete"
      /* AppError.IDB_DELETE */
    ]: "Error thrown when deleting from IndexedDB. Original error: {$originalErrorMessage}.",
    [
      "finalization-registry-not-supported"
      /* AppError.FINALIZATION_REGISTRY_NOT_SUPPORTED */
    ]: "FirebaseServerApp deleteOnDeref field defined but the JS runtime does not support FinalizationRegistry.",
    [
      "invalid-server-app-environment"
      /* AppError.INVALID_SERVER_APP_ENVIRONMENT */
    ]: "FirebaseServerApp is not for use in browser environments."
  };
  const ERROR_FACTORY$1 = new ErrorFactory("app", "Firebase", ERRORS$1);
  /**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  class FirebaseAppImpl {
    constructor(options, config, container) {
      this._isDeleted = false;
      this._options = { ...options };
      this._config = { ...config };
      this._name = config.name;
      this._automaticDataCollectionEnabled = config.automaticDataCollectionEnabled;
      this._container = container;
      this.container.addComponent(new Component(
        "app",
        () => this,
        "PUBLIC"
        /* ComponentType.PUBLIC */
      ));
    }
    get automaticDataCollectionEnabled() {
      this.checkDestroyed();
      return this._automaticDataCollectionEnabled;
    }
    set automaticDataCollectionEnabled(val) {
      this.checkDestroyed();
      this._automaticDataCollectionEnabled = val;
    }
    get name() {
      this.checkDestroyed();
      return this._name;
    }
    get options() {
      this.checkDestroyed();
      return this._options;
    }
    get config() {
      this.checkDestroyed();
      return this._config;
    }
    get container() {
      return this._container;
    }
    get isDeleted() {
      return this._isDeleted;
    }
    set isDeleted(val) {
      this._isDeleted = val;
    }
    /**
     * This function will throw an Error if the App has already been deleted -
     * use before performing API actions on the App.
     */
    checkDestroyed() {
      if (this.isDeleted) {
        throw ERROR_FACTORY$1.create("app-deleted", { appName: this._name });
      }
    }
  }
  function initializeApp(_options, rawConfig = {}) {
    let options = _options;
    if (typeof rawConfig !== "object") {
      const name3 = rawConfig;
      rawConfig = { name: name3 };
    }
    const config = {
      name: DEFAULT_ENTRY_NAME,
      automaticDataCollectionEnabled: true,
      ...rawConfig
    };
    const name2 = config.name;
    if (typeof name2 !== "string" || !name2) {
      throw ERROR_FACTORY$1.create("bad-app-name", {
        appName: String(name2)
      });
    }
    options || (options = getDefaultAppConfig());
    if (!options) {
      throw ERROR_FACTORY$1.create(
        "no-options"
        /* AppError.NO_OPTIONS */
      );
    }
    const existingApp = _apps.get(name2);
    if (existingApp) {
      if (!deepEqual(options, existingApp.options)) {
        throw ERROR_FACTORY$1.create("duplicate-app", {
          appName: name2,
          mismatchedParam: "options",
          oldValue: JSON.stringify(existingApp.options),
          newValue: JSON.stringify(options)
        });
      } else if (!deepEqual(config, existingApp.config)) {
        throw ERROR_FACTORY$1.create("duplicate-app", {
          appName: name2,
          mismatchedParam: "config",
          oldValue: JSON.stringify(existingApp.config),
          newValue: JSON.stringify(config)
        });
      } else {
        return existingApp;
      }
    }
    const container = new ComponentContainer(name2);
    for (const component of _components.values()) {
      container.addComponent(component);
    }
    const newApp = new FirebaseAppImpl(options, config, container);
    _apps.set(name2, newApp);
    return newApp;
  }
  function getApp(name2 = DEFAULT_ENTRY_NAME) {
    const app2 = _apps.get(name2);
    if (!app2 && name2 === DEFAULT_ENTRY_NAME && getDefaultAppConfig()) {
      return initializeApp();
    }
    if (!app2) {
      throw ERROR_FACTORY$1.create("no-app", { appName: name2 });
    }
    return app2;
  }
  function registerVersion(libraryKeyOrName, version2, variant) {
    let library = PLATFORM_LOG_STRING[libraryKeyOrName] ?? libraryKeyOrName;
    if (variant) {
      library += `-${variant}`;
    }
    const libraryMismatch = library.match(/\s|\//);
    const versionMismatch = version2.match(/\s|\//);
    if (libraryMismatch || versionMismatch) {
      const warning = [
        `Unable to register library "${library}" with version "${version2}":`
      ];
      if (libraryMismatch) {
        warning.push(`library name "${library}" contains illegal characters (whitespace or "/")`);
      }
      if (libraryMismatch && versionMismatch) {
        warning.push("and");
      }
      if (versionMismatch) {
        warning.push(`version name "${version2}" contains illegal characters (whitespace or "/")`);
      }
      logger$2.warn(warning.join(" "));
      return;
    }
    _registerComponent(new Component(
      `${library}-version`,
      () => ({ library, version: version2 }),
      "VERSION"
      /* ComponentType.VERSION */
    ));
  }
  /**
   * @license
   * Copyright 2021 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  const DB_NAME$1 = "firebase-heartbeat-database";
  const DB_VERSION$1 = 1;
  const STORE_NAME$1 = "firebase-heartbeat-store";
  let dbPromise$1 = null;
  function getDbPromise() {
    if (!dbPromise$1) {
      dbPromise$1 = openDB(DB_NAME$1, DB_VERSION$1, {
        upgrade: (db, oldVersion) => {
          switch (oldVersion) {
            case 0:
              try {
                db.createObjectStore(STORE_NAME$1);
              } catch (e) {
                console.warn(e);
              }
          }
        }
      }).catch((e) => {
        throw ERROR_FACTORY$1.create("idb-open", {
          originalErrorMessage: e.message
        });
      });
    }
    return dbPromise$1;
  }
  async function readHeartbeatsFromIndexedDB(app2) {
    try {
      const db = await getDbPromise();
      const tx = db.transaction(STORE_NAME$1);
      const result = await tx.objectStore(STORE_NAME$1).get(computeKey$1(app2));
      await tx.done;
      return result;
    } catch (e) {
      if (e instanceof FirebaseError) {
        logger$2.warn(e.message);
      } else {
        const idbGetError = ERROR_FACTORY$1.create("idb-get", {
          originalErrorMessage: e == null ? void 0 : e.message
        });
        logger$2.warn(idbGetError.message);
      }
    }
  }
  async function writeHeartbeatsToIndexedDB(app2, heartbeatObject) {
    try {
      const db = await getDbPromise();
      const tx = db.transaction(STORE_NAME$1, "readwrite");
      const objectStore = tx.objectStore(STORE_NAME$1);
      await objectStore.put(heartbeatObject, computeKey$1(app2));
      await tx.done;
    } catch (e) {
      if (e instanceof FirebaseError) {
        logger$2.warn(e.message);
      } else {
        const idbGetError = ERROR_FACTORY$1.create("idb-set", {
          originalErrorMessage: e == null ? void 0 : e.message
        });
        logger$2.warn(idbGetError.message);
      }
    }
  }
  function computeKey$1(app2) {
    return `${app2.name}!${app2.options.appId}`;
  }
  /**
   * @license
   * Copyright 2021 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  const MAX_HEADER_BYTES = 1024;
  const MAX_NUM_STORED_HEARTBEATS = 30;
  class HeartbeatServiceImpl {
    constructor(container) {
      this.container = container;
      this._heartbeatsCache = null;
      const app2 = this.container.getProvider("app").getImmediate();
      this._storage = new HeartbeatStorageImpl(app2);
      this._heartbeatsCachePromise = this._storage.read().then((result) => {
        this._heartbeatsCache = result;
        return result;
      });
    }
    /**
     * Called to report a heartbeat. The function will generate
     * a HeartbeatsByUserAgent object, update heartbeatsCache, and persist it
     * to IndexedDB.
     * Note that we only store one heartbeat per day. So if a heartbeat for today is
     * already logged, subsequent calls to this function in the same day will be ignored.
     */
    async triggerHeartbeat() {
      var _a, _b;
      try {
        const platformLogger = this.container.getProvider("platform-logger").getImmediate();
        const agent = platformLogger.getPlatformInfoString();
        const date = getUTCDateString();
        if (((_a = this._heartbeatsCache) == null ? void 0 : _a.heartbeats) == null) {
          this._heartbeatsCache = await this._heartbeatsCachePromise;
          if (((_b = this._heartbeatsCache) == null ? void 0 : _b.heartbeats) == null) {
            return;
          }
        }
        if (this._heartbeatsCache.lastSentHeartbeatDate === date || this._heartbeatsCache.heartbeats.some((singleDateHeartbeat) => singleDateHeartbeat.date === date)) {
          return;
        } else {
          this._heartbeatsCache.heartbeats.push({ date, agent });
          if (this._heartbeatsCache.heartbeats.length > MAX_NUM_STORED_HEARTBEATS) {
            const earliestHeartbeatIdx = getEarliestHeartbeatIdx(this._heartbeatsCache.heartbeats);
            this._heartbeatsCache.heartbeats.splice(earliestHeartbeatIdx, 1);
          }
        }
        return this._storage.overwrite(this._heartbeatsCache);
      } catch (e) {
        logger$2.warn(e);
      }
    }
    /**
     * Returns a base64 encoded string which can be attached to the heartbeat-specific header directly.
     * It also clears all heartbeats from memory as well as in IndexedDB.
     *
     * NOTE: Consuming product SDKs should not send the header if this method
     * returns an empty string.
     */
    async getHeartbeatsHeader() {
      var _a;
      try {
        if (this._heartbeatsCache === null) {
          await this._heartbeatsCachePromise;
        }
        if (((_a = this._heartbeatsCache) == null ? void 0 : _a.heartbeats) == null || this._heartbeatsCache.heartbeats.length === 0) {
          return "";
        }
        const date = getUTCDateString();
        const { heartbeatsToSend, unsentEntries } = extractHeartbeatsForHeader(this._heartbeatsCache.heartbeats);
        const headerString = base64urlEncodeWithoutPadding(JSON.stringify({ version: 2, heartbeats: heartbeatsToSend }));
        this._heartbeatsCache.lastSentHeartbeatDate = date;
        if (unsentEntries.length > 0) {
          this._heartbeatsCache.heartbeats = unsentEntries;
          await this._storage.overwrite(this._heartbeatsCache);
        } else {
          this._heartbeatsCache.heartbeats = [];
          void this._storage.overwrite(this._heartbeatsCache);
        }
        return headerString;
      } catch (e) {
        logger$2.warn(e);
        return "";
      }
    }
  }
  function getUTCDateString() {
    const today = /* @__PURE__ */ new Date();
    return today.toISOString().substring(0, 10);
  }
  function extractHeartbeatsForHeader(heartbeatsCache, maxSize = MAX_HEADER_BYTES) {
    const heartbeatsToSend = [];
    let unsentEntries = heartbeatsCache.slice();
    for (const singleDateHeartbeat of heartbeatsCache) {
      const heartbeatEntry = heartbeatsToSend.find((hb) => hb.agent === singleDateHeartbeat.agent);
      if (!heartbeatEntry) {
        heartbeatsToSend.push({
          agent: singleDateHeartbeat.agent,
          dates: [singleDateHeartbeat.date]
        });
        if (countBytes(heartbeatsToSend) > maxSize) {
          heartbeatsToSend.pop();
          break;
        }
      } else {
        heartbeatEntry.dates.push(singleDateHeartbeat.date);
        if (countBytes(heartbeatsToSend) > maxSize) {
          heartbeatEntry.dates.pop();
          break;
        }
      }
      unsentEntries = unsentEntries.slice(1);
    }
    return {
      heartbeatsToSend,
      unsentEntries
    };
  }
  class HeartbeatStorageImpl {
    constructor(app2) {
      this.app = app2;
      this._canUseIndexedDBPromise = this.runIndexedDBEnvironmentCheck();
    }
    async runIndexedDBEnvironmentCheck() {
      if (!isIndexedDBAvailable()) {
        return false;
      } else {
        return validateIndexedDBOpenable().then(() => true).catch(() => false);
      }
    }
    /**
     * Read all heartbeats.
     */
    async read() {
      const canUseIndexedDB = await this._canUseIndexedDBPromise;
      if (!canUseIndexedDB) {
        return { heartbeats: [] };
      } else {
        const idbHeartbeatObject = await readHeartbeatsFromIndexedDB(this.app);
        if (idbHeartbeatObject == null ? void 0 : idbHeartbeatObject.heartbeats) {
          return idbHeartbeatObject;
        } else {
          return { heartbeats: [] };
        }
      }
    }
    // overwrite the storage with the provided heartbeats
    async overwrite(heartbeatsObject) {
      const canUseIndexedDB = await this._canUseIndexedDBPromise;
      if (!canUseIndexedDB) {
        return;
      } else {
        const existingHeartbeatsObject = await this.read();
        return writeHeartbeatsToIndexedDB(this.app, {
          lastSentHeartbeatDate: heartbeatsObject.lastSentHeartbeatDate ?? existingHeartbeatsObject.lastSentHeartbeatDate,
          heartbeats: heartbeatsObject.heartbeats
        });
      }
    }
    // add heartbeats
    async add(heartbeatsObject) {
      const canUseIndexedDB = await this._canUseIndexedDBPromise;
      if (!canUseIndexedDB) {
        return;
      } else {
        const existingHeartbeatsObject = await this.read();
        return writeHeartbeatsToIndexedDB(this.app, {
          lastSentHeartbeatDate: heartbeatsObject.lastSentHeartbeatDate ?? existingHeartbeatsObject.lastSentHeartbeatDate,
          heartbeats: [
            ...existingHeartbeatsObject.heartbeats,
            ...heartbeatsObject.heartbeats
          ]
        });
      }
    }
  }
  function countBytes(heartbeatsCache) {
    return base64urlEncodeWithoutPadding(
      // heartbeatsCache wrapper properties
      JSON.stringify({ version: 2, heartbeats: heartbeatsCache })
    ).length;
  }
  function getEarliestHeartbeatIdx(heartbeats) {
    if (heartbeats.length === 0) {
      return -1;
    }
    let earliestHeartbeatIdx = 0;
    let earliestHeartbeatDate = heartbeats[0].date;
    for (let i = 1; i < heartbeats.length; i++) {
      if (heartbeats[i].date < earliestHeartbeatDate) {
        earliestHeartbeatDate = heartbeats[i].date;
        earliestHeartbeatIdx = i;
      }
    }
    return earliestHeartbeatIdx;
  }
  /**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  function registerCoreComponents(variant) {
    _registerComponent(new Component(
      "platform-logger",
      (container) => new PlatformLoggerServiceImpl(container),
      "PRIVATE"
      /* ComponentType.PRIVATE */
    ));
    _registerComponent(new Component(
      "heartbeat",
      (container) => new HeartbeatServiceImpl(container),
      "PRIVATE"
      /* ComponentType.PRIVATE */
    ));
    registerVersion(name$q, version$1$1, variant);
    registerVersion(name$q, version$1$1, "esm2020");
    registerVersion("fire-js", "");
  }
  /**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  registerCoreComponents("");
  var name$4 = "@firebase/ai";
  var version$2 = "2.16.0";
  /**
   * @license
   * Copyright 2024 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  const AI_TYPE = "AI";
  const LEGACY_DEFAULT_LOCATION = "us-central1";
  const DEFAULT_LOCATION = "global";
  const DEFAULT_DOMAIN = "firebasevertexai.googleapis.com";
  const DEFAULT_API_VERSION = "v1beta";
  const PACKAGE_VERSION = version$2;
  const LANGUAGE_TAG = "gl-js";
  const HYBRID_TAG = "hybrid";
  const DEFAULT_FETCH_TIMEOUT_MS = 180 * 1e3;
  const DEFAULT_HYBRID_IN_CLOUD_MODEL = "gemini-2.5-flash-lite";
  /**
   * @license
   * Copyright 2024 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  class AIError extends FirebaseError {
    /**
     * Constructs a new instance of the `AIError` class.
     *
     * @param code - The error code from {@link (AIErrorCode:type)}.
     * @param message - A human-readable message describing the error.
     * @param customErrorData - Optional error data.
     */
    constructor(code, message, customErrorData) {
      const service = AI_TYPE;
      const fullCode = `${service}/${code}`;
      const fullMessage = `${service}: ${message} (${fullCode})`;
      super(code, fullMessage);
      this.code = code;
      this.customErrorData = customErrorData;
      if (Error.captureStackTrace) {
        Error.captureStackTrace(this, AIError);
      }
      Object.setPrototypeOf(this, AIError.prototype);
      this.toString = () => fullMessage;
    }
  }
  /**
   * @license
   * Copyright 2024 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  const POSSIBLE_ROLES = ["user", "model", "function", "system"];
  const HarmSeverity = {
    /**
     * Harm severity is not supported.
     *
     * @remarks
     * The GoogleAI backend does not support `HarmSeverity`, so this value is used as a fallback.
     */
    HARM_SEVERITY_UNSUPPORTED: "HARM_SEVERITY_UNSUPPORTED"
  };
  const FinishReason = {
    /**
     * The candidate content was flagged for safety reasons.
     */
    SAFETY: "SAFETY",
    /**
     * The candidate content was flagged for recitation reasons.
     */
    RECITATION: "RECITATION",
    /**
     * The candidate content contained forbidden terms.
     */
    BLOCKLIST: "BLOCKLIST",
    /**
     * The candidate content potentially contained prohibited content.
     */
    PROHIBITED_CONTENT: "PROHIBITED_CONTENT",
    /**
     * The candidate content potentially contained Sensitive Personally Identifiable Information (SPII).
     */
    SPII: "SPII",
    /**
     * The function call generated by the model was invalid.
     */
    MALFORMED_FUNCTION_CALL: "MALFORMED_FUNCTION_CALL",
    /**
     * Token generation stopped because generated images contain safety violations.
     */
    IMAGE_SAFETY: "IMAGE_SAFETY",
    /**
     * Image generation stopped because generated images have other prohibited content.
     */
    IMAGE_PROHIBITED_CONTENT: "IMAGE_PROHIBITED_CONTENT",
    /**
     * Image generation stopped because of other miscellaneous issue.
     */
    IMAGE_OTHER: "IMAGE_OTHER",
    /**
     * The model was expected to generate an image, but none was generated.
     */
    NO_IMAGE: "NO_IMAGE",
    /**
     * Image generation stopped due to recitation.
     */
    IMAGE_RECITATION: "IMAGE_RECITATION",
    /**
     * The response candidate content was flagged for using an unsupported language.
     */
    LANGUAGE: "LANGUAGE",
    /**
     * Model generated a tool call but no tools were enabled in the request.
     */
    UNEXPECTED_TOOL_CALL: "UNEXPECTED_TOOL_CALL",
    /**
     * Model called too many tools consecutively, thus the system exited execution.
     */
    TOO_MANY_TOOL_CALLS: "TOO_MANY_TOOL_CALLS",
    /**
     * Request has at least one thought signature missing.
     */
    MISSING_THOUGHT_SIGNATURE: "MISSING_THOUGHT_SIGNATURE",
    /**
     * Finished due to malformed response.
     */
    MALFORMED_RESPONSE: "MALFORMED_RESPONSE"
  };
  const InferenceMode = {
    "PREFER_ON_DEVICE": "prefer_on_device",
    "ONLY_ON_DEVICE": "only_on_device",
    "ONLY_IN_CLOUD": "only_in_cloud",
    "PREFER_IN_CLOUD": "prefer_in_cloud"
  };
  const InferenceSource = {
    "ON_DEVICE": "on_device",
    "IN_CLOUD": "in_cloud"
  };
  /**
   * @license
   * Copyright 2024 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  const AIErrorCode = {
    /** A generic error occurred. */
    ERROR: "error",
    /** An error occurred in a request. */
    REQUEST_ERROR: "request-error",
    /** An error occurred in a response. */
    RESPONSE_ERROR: "response-error",
    /** An error occurred while performing a fetch. */
    FETCH_ERROR: "fetch-error",
    /** An error occurred because an operation was attempted on a closed session. */
    SESSION_CLOSED: "session-closed",
    /** An error associated with a Content object.  */
    INVALID_CONTENT: "invalid-content",
    /** An error due to the Firebase API not being enabled in the Console. */
    API_NOT_ENABLED: "api-not-enabled",
    /** An error due to invalid Schema input.  */
    INVALID_SCHEMA: "invalid-schema",
    /** An error occurred due to a missing Firebase API key. */
    NO_API_KEY: "no-api-key",
    /** An error occurred due to a missing Firebase app ID. */
    NO_APP_ID: "no-app-id",
    /** An error occurred due to a model name not being specified during initialization. */
    NO_MODEL: "no-model",
    /** An error occurred due to a missing project ID. */
    NO_PROJECT_ID: "no-project-id",
    /** An error occurred while parsing. */
    PARSE_FAILED: "parse-failed",
    /** An error occurred due an attempt to use an unsupported feature. */
    UNSUPPORTED: "unsupported"
  };
  /**
   * @license
   * Copyright 2024 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  const BackendType = {
    /**
     * Identifies the backend service for the Agent Platform Gemini API provided through Google Cloud.
     * Use this constant when creating a {@link AgentPlatformBackend} configuration.
     */
    AGENT_PLATFORM: "AGENT_PLATFORM",
    /**
     * Identifies the backend service for the Agent Platform Gemini API
     * (formerly known as Vertex AI Gemini API) provided through Google Cloud.
     * Use this constant when creating a {@link VertexAIBackend} configuration.
     * @deprecated - Use {@link AgentPlatformBackend} instead.
     */
    VERTEX_AI: "VERTEX_AI",
    /**
     * Identifies the backend service for the Gemini Developer API ({@link https://ai.google/ | Google AI}).
     * Use this constant when creating a {@link GoogleAIBackend} configuration.
     */
    GOOGLE_AI: "GOOGLE_AI"
  };
  /**
   * @license
   * Copyright 2025 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  class Backend {
    /**
     * Protected constructor for use by subclasses.
     * @param type - The backend type.
     */
    constructor(type) {
      this.backendType = type;
    }
  }
  class GoogleAIBackend extends Backend {
    /**
     * Creates a configuration object for the Gemini Developer API backend.
     */
    constructor() {
      super(BackendType.GOOGLE_AI);
    }
    /**
     * @internal
     */
    _getModelPath(project, model) {
      return `/${DEFAULT_API_VERSION}/projects/${project}/${model}`;
    }
    /**
     * @internal
     */
    _getTemplatePath(project, templateId) {
      return `/${DEFAULT_API_VERSION}/projects/${project}/templates/${templateId}`;
    }
  }
  class VertexAIBackend extends Backend {
    /**
     * Creates a configuration object for the Agent Platform Gemini API (formerly
     * known as the Vertex AI Gemini API) backend.
     *
     * @param location - The region identifier, defaulting to `us-central1`;
     * see {@link https://firebase.google.com/docs/ai-logic/locations?api=vertex#available-locations | Agent Platform Gemini API locations}
     * for a list of supported locations.
     */
    constructor(location) {
      super(BackendType.VERTEX_AI);
      this.location = LEGACY_DEFAULT_LOCATION;
      if (location) {
        this.location = location;
      }
    }
    /**
     * @internal
     */
    _getModelPath(project, model) {
      return `/${DEFAULT_API_VERSION}/projects/${project}/locations/${this.location}/${model}`;
    }
    /**
     * @internal
     */
    _getTemplatePath(project, templateId) {
      return `/${DEFAULT_API_VERSION}/projects/${project}/locations/${this.location}/templates/${templateId}`;
    }
  }
  class AgentPlatformBackend extends Backend {
    /**
     * Creates a configuration object for the Agent Platform backend.
     *
     * @param location - The region identifier, defaulting to `global`;
     * see {@link https://firebase.google.com/docs/ai-logic/locations?api=vertex#available-locations | Agent Platform locations}
     * for a list of supported locations.
     */
    constructor(location) {
      super(BackendType.AGENT_PLATFORM);
      this.location = DEFAULT_LOCATION;
      if (location) {
        this.location = location;
      }
    }
    /**
     * @internal
     */
    _getModelPath(project, model) {
      return `/${DEFAULT_API_VERSION}/projects/${project}/locations/${this.location}/${model}`;
    }
    /**
     * @internal
     */
    _getTemplatePath(project, templateId) {
      return `/${DEFAULT_API_VERSION}/projects/${project}/locations/${this.location}/templates/${templateId}`;
    }
  }
  /**
   * @license
   * Copyright 2025 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  function encodeInstanceIdentifier(backend) {
    if (backend instanceof GoogleAIBackend) {
      return `${AI_TYPE}/googleai`;
    } else if (backend instanceof VertexAIBackend) {
      return `${AI_TYPE}/vertexai/${backend.location}`;
    } else if (backend instanceof AgentPlatformBackend) {
      return `${AI_TYPE}/agentplatform/${backend.location}`;
    } else {
      throw new AIError(AIErrorCode.ERROR, `Invalid backend: ${JSON.stringify(backend.backendType)}`);
    }
  }
  function decodeInstanceIdentifier(instanceIdentifier) {
    const identifierParts = instanceIdentifier.split("/");
    if (identifierParts[0] !== AI_TYPE) {
      throw new AIError(AIErrorCode.ERROR, `Invalid instance identifier, unknown prefix '${identifierParts[0]}'`);
    }
    const backendType = identifierParts[1];
    switch (backendType) {
      case "vertexai":
        const vertexLocation = identifierParts[2];
        if (!vertexLocation) {
          throw new AIError(AIErrorCode.ERROR, `Invalid instance identifier, unknown location '${instanceIdentifier}'`);
        }
        return new VertexAIBackend(vertexLocation);
      case "agentplatform":
        const location = identifierParts[2];
        if (!location) {
          throw new AIError(AIErrorCode.ERROR, `Invalid instance identifier, unknown location '${instanceIdentifier}'`);
        }
        return new AgentPlatformBackend(location);
      case "googleai":
        return new GoogleAIBackend();
      default:
        throw new AIError(AIErrorCode.ERROR, `Invalid instance identifier string: '${instanceIdentifier}'`);
    }
  }
  /**
   * @license
   * Copyright 2024 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  const logger$1 = new Logger("@firebase/vertexai");
  var Availability;
  (function(Availability2) {
    Availability2["UNAVAILABLE"] = "unavailable";
    Availability2["DOWNLOADABLE"] = "downloadable";
    Availability2["DOWNLOADING"] = "downloading";
    Availability2["AVAILABLE"] = "available";
  })(Availability || (Availability = {}));
  /**
   * @license
   * Copyright 2025 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  const defaultExpectedText = {
    type: "text",
    languages: ["en"]
  };
  const defaultExpectedInputs = [
    defaultExpectedText,
    { type: "image" }
  ];
  const defaultExpectedOutputs = [
    defaultExpectedText
  ];
  class ChromeAdapterImpl {
    constructor(languageModelProvider, mode, onDeviceParams) {
      this.languageModelProvider = languageModelProvider;
      this.mode = mode;
      this.downloadPromise = null;
      this.onDeviceParams = {
        createOptions: {
          expectedInputs: defaultExpectedInputs,
          expectedOutputs: defaultExpectedOutputs
        }
      };
      if (onDeviceParams) {
        this.onDeviceParams = onDeviceParams;
        if (!this.onDeviceParams.createOptions) {
          this.onDeviceParams.createOptions = {
            expectedInputs: defaultExpectedInputs,
            expectedOutputs: defaultExpectedOutputs
          };
        } else {
          if (!this.onDeviceParams.createOptions.expectedInputs) {
            this.onDeviceParams.createOptions.expectedInputs = defaultExpectedInputs;
          }
          if (!this.onDeviceParams.createOptions.expectedOutputs) {
            this.onDeviceParams.createOptions.expectedOutputs = defaultExpectedOutputs;
          }
        }
      }
    }
    /**
     * Checks if a given request can be made on-device.
     *
     * Encapsulates a few concerns:
     *   the mode
     *   API existence
     *   prompt formatting
     *   model availability
     *
     *
     * Pros: callers needn't be concerned with details of on-device availability.</p>
     * Cons: this method spans a few concerns and splits request validation from usage.
     * If instance variables weren't already part of the API, we could consider a better
     * separation of concerns.
     */
    async isAvailable(request) {
      var _a;
      if (!this.mode) {
        logger$1.debug(`On-device inference unavailable because mode is undefined.`);
        return false;
      }
      if (this.mode === InferenceMode.ONLY_IN_CLOUD) {
        logger$1.debug(`On-device inference unavailable because mode is "only_in_cloud".`);
        return false;
      }
      const availability = await ((_a = this.languageModelProvider) == null ? void 0 : _a.availability(this.onDeviceParams.createOptions));
      if (this.mode === InferenceMode.ONLY_ON_DEVICE) {
        if (availability === Availability.UNAVAILABLE) {
          throw new AIError(AIErrorCode.API_NOT_ENABLED, "Local LanguageModel API not available in this environment.");
        } else if (availability === Availability.DOWNLOADABLE || availability === Availability.DOWNLOADING) {
          logger$1.debug(`Waiting for download of LanguageModel to complete.`);
          try {
            await this.downloadPromise;
          } catch (e) {
            throw new AIError(AIErrorCode.ERROR, e.message);
          }
          return true;
        }
        return true;
      }
      if (availability !== Availability.AVAILABLE) {
        logger$1.debug(`On-device inference unavailable because availability is "${availability}".`);
        return false;
      }
      if (!ChromeAdapterImpl.isOnDeviceRequest(request)) {
        logger$1.debug(`On-device inference unavailable because request is incompatible.`);
        return false;
      }
      return true;
    }
    /**
     * Generates content on device.
     *
     * @remarks
     * This is comparable to {@link GenerativeModel.generateContent} for generating content in
     * Cloud.
     * @param request - a standard Firebase AI {@link GenerateContentRequest}
     * @returns {@link Response}, so we can reuse common response formatting.
     */
    async generateContent(request) {
      const session = await this.createSession();
      const contents = await Promise.all(request.contents.map(ChromeAdapterImpl.toLanguageModelMessage));
      const text = await session.prompt(contents, this.onDeviceParams.promptOptions);
      return ChromeAdapterImpl.toResponse(text);
    }
    /**
     * Generates content stream on device.
     *
     * @remarks
     * This is comparable to {@link GenerativeModel.generateContentStream} for generating content in
     * Cloud.
     * @param request - a standard Firebase AI {@link GenerateContentRequest}
     * @returns {@link Response}, so we can reuse common response formatting.
     */
    async generateContentStream(request) {
      const session = await this.createSession();
      const contents = await Promise.all(request.contents.map(ChromeAdapterImpl.toLanguageModelMessage));
      const stream = session.promptStreaming(contents, this.onDeviceParams.promptOptions);
      return ChromeAdapterImpl.toStreamResponse(stream);
    }
    async countTokens(_request) {
      throw new AIError(AIErrorCode.REQUEST_ERROR, "Count Tokens is not yet available for on-device model.");
    }
    /**
     * Asserts inference for the given request can be performed by an on-device model.
     */
    static isOnDeviceRequest(request) {
      if (request.contents.length === 0) {
        logger$1.debug("Empty prompt rejected for on-device inference.");
        return false;
      }
      for (const content of request.contents) {
        if (content.parts.some((part) => "functionResponse" in part)) {
          logger$1.debug(`Content with a function response part rejected for on-device inference.`);
          return false;
        }
        for (const part of content.parts) {
          if (part.inlineData && ChromeAdapterImpl.SUPPORTED_MIME_TYPES.indexOf(part.inlineData.mimeType) === -1) {
            logger$1.debug(`Unsupported mime type "${part.inlineData.mimeType}" rejected for on-device inference.`);
            return false;
          }
        }
      }
      return true;
    }
    /**
     * Encapsulates logic to get availability and download a model if one is downloadable.
     */
    async downloadIfAvailable(onDownloadProgress) {
      var _a;
      const availability = await ((_a = this.languageModelProvider) == null ? void 0 : _a.availability(this.onDeviceParams.createOptions));
      if (availability === Availability.DOWNLOADABLE || availability === Availability.DOWNLOADING) {
        this.download(onDownloadProgress);
      }
      return availability;
    }
    /**
     * Triggers out-of-band download of an on-device model.
     *
     * Chrome may automatically begin a download on startup or
     * it may trigger a download when code calls LanguageModel.create.
     *
     * Since Chrome manages the download, the SDK can only avoid redundant download requests by
     * tracking if a download has previously been requested.
     */
    download(onDownloadProgress) {
      var _a;
      if (this.downloadPromise) {
        return;
      }
      const options = { ...this.onDeviceParams.createOptions };
      if (options && !options.monitor && onDownloadProgress) {
        options.monitor = (m) => {
          m.addEventListener("downloadprogress", (e) => {
            onDownloadProgress(e.loaded);
          });
        };
      }
      this.downloadPromise = (_a = this.languageModelProvider) == null ? void 0 : _a.create(options).finally(() => {
        this.downloadPromise = null;
      });
    }
    /**
     * Converts Firebase AI {@link Content} object to a Chrome {@link LanguageModelMessage} object.
     */
    static async toLanguageModelMessage(content) {
      const languageModelMessageContents = await Promise.all(content.parts.map(ChromeAdapterImpl.toLanguageModelMessageContent));
      return {
        role: ChromeAdapterImpl.toLanguageModelMessageRole(content.role),
        content: languageModelMessageContents
      };
    }
    /**
     * Converts a Firebase AI Part object to a Chrome LanguageModelMessageContent object.
     */
    static async toLanguageModelMessageContent(part) {
      if (part.text) {
        return {
          type: "text",
          value: part.text
        };
      } else if (part.inlineData) {
        const formattedImageContent = await fetch(`data:${part.inlineData.mimeType};base64,${part.inlineData.data}`);
        const imageBlob = await formattedImageContent.blob();
        const imageBitmap = await createImageBitmap(imageBlob);
        return {
          type: "image",
          value: imageBitmap
        };
      }
      throw new AIError(AIErrorCode.REQUEST_ERROR, `Processing of this Part type is not currently supported.`);
    }
    /**
     * Converts a Firebase AI {@link Role} string to a {@link LanguageModelMessageRole} string.
     */
    static toLanguageModelMessageRole(role) {
      return role === "model" ? "assistant" : "user";
    }
    /**
     * Abstracts Chrome session creation.
     *
     * Chrome uses a multi-turn session for all inference. Firebase AI uses single-turn for all
     * inference. To map the Firebase AI API to Chrome's API, the SDK creates a new session for all
     * inference.
     *
     * Chrome will remove a model from memory if it's no longer in use, so this method ensures a
     * new session is created before an old session is destroyed.
     */
    async createSession() {
      if (!this.languageModelProvider) {
        throw new AIError(AIErrorCode.UNSUPPORTED, "Chrome AI requested for unsupported browser version.");
      }
      const newSession = await this.languageModelProvider.create(this.onDeviceParams.createOptions);
      if (this.oldSession) {
        this.oldSession.destroy();
      }
      this.oldSession = newSession;
      return newSession;
    }
    /**
     * Formats string returned by Chrome as a {@link Response} returned by Firebase AI.
     */
    static toResponse(text) {
      return {
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [{ text }]
              }
            }
          ]
        })
      };
    }
    /**
     * Formats string stream returned by Chrome as SSE returned by Firebase AI.
     */
    static toStreamResponse(stream) {
      const encoder = new TextEncoder();
      return {
        body: stream.pipeThrough(new TransformStream({
          transform(chunk, controller) {
            const json = JSON.stringify({
              candidates: [
                {
                  content: {
                    role: "model",
                    parts: [{ text: chunk }]
                  }
                }
              ]
            });
            controller.enqueue(encoder.encode(`data: ${json}

`));
          }
        }))
      };
    }
  }
  ChromeAdapterImpl.SUPPORTED_MIME_TYPES = ["image/jpeg", "image/png"];
  function chromeAdapterFactory(mode, window2, params2) {
    const globalObj = window2 || getGlobal();
    const languageModel = globalObj.LanguageModel;
    if (languageModel && mode) {
      return new ChromeAdapterImpl(languageModel, mode, params2);
    }
  }
  /**
   * @license
   * Copyright 2024 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  class AIService {
    constructor(app2, backend, authProvider, appCheckProvider, chromeAdapterFactory2) {
      this.app = app2;
      this.backend = backend;
      this.chromeAdapterFactory = chromeAdapterFactory2;
      const appCheck = appCheckProvider == null ? void 0 : appCheckProvider.getImmediate({ optional: true });
      const auth = authProvider == null ? void 0 : authProvider.getImmediate({ optional: true });
      this.auth = auth || null;
      this.appCheck = appCheck || null;
      if (backend instanceof VertexAIBackend || backend instanceof AgentPlatformBackend) {
        this.location = backend.location;
      } else {
        this.location = "";
      }
    }
    _delete() {
      return Promise.resolve();
    }
    set options(optionsToSet) {
      this._options = optionsToSet;
    }
    get options() {
      return this._options;
    }
  }
  /**
   * @license
   * Copyright 2025 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  function factory$1(container, { instanceIdentifier }) {
    if (!instanceIdentifier) {
      throw new AIError(AIErrorCode.ERROR, "AIService instance identifier is undefined.");
    }
    const backend = decodeInstanceIdentifier(instanceIdentifier);
    const app2 = container.getProvider("app").getImmediate();
    const auth = container.getProvider("auth-internal");
    const appCheckProvider = container.getProvider("app-check-internal");
    return new AIService(app2, backend, auth, appCheckProvider, chromeAdapterFactory);
  }
  /**
   * @license
   * Copyright 2025 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  function initApiSettings(ai) {
    var _a, _b, _c, _d, _e, _f, _g;
    if (!((_b = (_a = ai.app) == null ? void 0 : _a.options) == null ? void 0 : _b.apiKey)) {
      throw new AIError(AIErrorCode.NO_API_KEY, `The "apiKey" field is empty in the local Firebase config. Firebase AI requires this field to contain a valid API key.`);
    } else if (!((_d = (_c = ai.app) == null ? void 0 : _c.options) == null ? void 0 : _d.projectId)) {
      throw new AIError(AIErrorCode.NO_PROJECT_ID, `The "projectId" field is empty in the local Firebase config. Firebase AI requires this field to contain a valid project ID.`);
    } else if (!((_f = (_e = ai.app) == null ? void 0 : _e.options) == null ? void 0 : _f.appId)) {
      throw new AIError(AIErrorCode.NO_APP_ID, `The "appId" field is empty in the local Firebase config. Firebase AI requires this field to contain a valid app ID.`);
    }
    const apiSettings = {
      apiKey: ai.app.options.apiKey,
      project: ai.app.options.projectId,
      appId: ai.app.options.appId,
      automaticDataCollectionEnabled: ai.app.automaticDataCollectionEnabled,
      location: ai.location,
      backend: ai.backend
    };
    if (_isFirebaseServerApp(ai.app) && ai.app.settings.appCheckToken) {
      const token = ai.app.settings.appCheckToken;
      apiSettings.getAppCheckToken = () => {
        return Promise.resolve({ token });
      };
    } else if (ai.appCheck) {
      if ((_g = ai.options) == null ? void 0 : _g.useLimitedUseAppCheckTokens) {
        apiSettings.getAppCheckToken = () => ai.appCheck.getLimitedUseToken();
      } else {
        apiSettings.getAppCheckToken = () => ai.appCheck.getToken();
      }
    }
    if (ai.auth) {
      apiSettings.getAuthToken = () => ai.auth.getToken();
    }
    return apiSettings;
  }
  /**
   * @license
   * Copyright 2025 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  class AIModel {
    /**
     * Constructs a new instance of the {@link AIModel} class.
     *
     * This constructor should only be called from subclasses that provide
     * a model API.
     *
     * @param ai - an {@link AI} instance.
     * @param modelName - The name of the model being used. It can be in one of the following formats:
     * - `my-model` (short name, will resolve to `publishers/google/models/my-model`)
     * - `models/my-model` (will resolve to `publishers/google/models/my-model`)
     * - `publishers/my-publisher/models/my-model` (fully qualified model name)
     *
     * @throws If the `apiKey` or `projectId` fields are missing in your
     * Firebase config.
     *
     * @internal
     */
    constructor(ai, modelName) {
      this._apiSettings = initApiSettings(ai);
      this.model = AIModel.normalizeModelName(modelName, this._apiSettings.backend.backendType);
    }
    /**
     * Normalizes the given model name to a fully qualified model resource name.
     *
     * @param modelName - The model name to normalize.
     * @returns The fully qualified model resource name.
     *
     * @internal
     */
    static normalizeModelName(modelName, backendType) {
      if (backendType === BackendType.GOOGLE_AI) {
        return AIModel.normalizeGoogleAIModelName(modelName);
      } else {
        return AIModel.normalizeVertexAIModelName(modelName);
      }
    }
    /**
     * @internal
     */
    static normalizeGoogleAIModelName(modelName) {
      return `models/${modelName}`;
    }
    /**
     * @internal
     */
    static normalizeVertexAIModelName(modelName) {
      let model;
      if (modelName.includes("/")) {
        if (modelName.startsWith("models/")) {
          model = `publishers/google/${modelName}`;
        } else {
          model = modelName;
        }
      } else {
        model = `publishers/google/models/${modelName}`;
      }
      return model;
    }
  }
  /**
   * @license
   * Copyright 2025 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  const TIMEOUT_EXPIRED_MESSAGE = "Timeout has expired.";
  const ABORT_ERROR_NAME = "AbortError";
  class RequestURL {
    constructor(params2) {
      this.params = params2;
    }
    toString() {
      const url = new URL(this.baseUrl);
      url.pathname = this.pathname;
      url.search = this.queryParams.toString();
      return url.toString();
    }
    get pathname() {
      if (this.params.templateId) {
        return `${this.params.apiSettings.backend._getTemplatePath(this.params.apiSettings.project, this.params.templateId)}:${this.params.task}`;
      } else {
        return `${this.params.apiSettings.backend._getModelPath(this.params.apiSettings.project, this.params.model)}:${this.params.task}`;
      }
    }
    get baseUrl() {
      var _a;
      return ((_a = this.params.singleRequestOptions) == null ? void 0 : _a.baseUrl) ?? `https://${DEFAULT_DOMAIN}`;
    }
    get queryParams() {
      const params2 = new URLSearchParams();
      if (this.params.stream) {
        params2.set("alt", "sse");
      }
      return params2;
    }
  }
  function getClientHeaders(url) {
    const loggingTags = [];
    loggingTags.push(`${LANGUAGE_TAG}/${PACKAGE_VERSION}`);
    loggingTags.push(`fire/${PACKAGE_VERSION}`);
    if (url.params.apiSettings.inferenceMode === InferenceMode.PREFER_ON_DEVICE || url.params.apiSettings.inferenceMode === InferenceMode.PREFER_IN_CLOUD) {
      loggingTags.push(HYBRID_TAG);
    }
    return loggingTags.join(" ");
  }
  async function getHeaders(url) {
    const headers = new Headers();
    headers.append("Content-Type", "application/json");
    headers.append("x-goog-api-client", getClientHeaders(url));
    headers.append("x-goog-api-key", url.params.apiSettings.apiKey);
    if (url.params.apiSettings.automaticDataCollectionEnabled) {
      headers.append("X-Firebase-Appid", url.params.apiSettings.appId);
    }
    if (url.params.apiSettings.getAppCheckToken) {
      const appCheckToken = await url.params.apiSettings.getAppCheckToken();
      if (appCheckToken) {
        headers.append("X-Firebase-AppCheck", appCheckToken.token);
        if (appCheckToken.error) {
          logger$1.warn(`Unable to obtain a valid App Check token: ${appCheckToken.error.message}`);
        }
      }
    }
    if (url.params.apiSettings.getAuthToken) {
      const authToken = await url.params.apiSettings.getAuthToken();
      if (authToken) {
        headers.append("Authorization", `Firebase ${authToken.accessToken}`);
      }
    }
    return headers;
  }
  async function makeRequest(requestUrlParams, body) {
    var _a, _b;
    const url = new RequestURL(requestUrlParams);
    let response;
    const externalSignal = (_a = requestUrlParams.singleRequestOptions) == null ? void 0 : _a.signal;
    const timeoutMillis = ((_b = requestUrlParams.singleRequestOptions) == null ? void 0 : _b.timeout) != null && requestUrlParams.singleRequestOptions.timeout >= 0 ? requestUrlParams.singleRequestOptions.timeout : DEFAULT_FETCH_TIMEOUT_MS;
    const internalAbortController = new AbortController();
    const fetchTimeoutId = setTimeout(() => {
      internalAbortController.abort(new DOMException(TIMEOUT_EXPIRED_MESSAGE, ABORT_ERROR_NAME));
      logger$1.debug(`Aborting request to ${url} due to timeout (${timeoutMillis}ms)`);
    }, timeoutMillis);
    const combinedSignal = AbortSignal.any(externalSignal ? [externalSignal, internalAbortController.signal] : [internalAbortController.signal]);
    if (externalSignal && externalSignal.aborted) {
      clearTimeout(fetchTimeoutId);
      throw new DOMException(externalSignal.reason ?? "Aborted externally before fetch", ABORT_ERROR_NAME);
    }
    try {
      const fetchOptions = {
        method: "POST",
        headers: await getHeaders(url),
        signal: combinedSignal,
        body
      };
      response = await fetch(url.toString(), fetchOptions);
      if (!response.ok) {
        let message = "";
        let errorDetails;
        try {
          const json = await response.json();
          message = json.error.message;
          if (json.error.details) {
            message += ` ${JSON.stringify(json.error.details)}`;
            errorDetails = json.error.details;
          }
        } catch (e) {
        }
        if (response.status === 403 && errorDetails && errorDetails.some((detail) => detail.reason === "SERVICE_DISABLED") && errorDetails.some((detail) => {
          var _a2, _b2;
          return (_b2 = (_a2 = detail.links) == null ? void 0 : _a2[0]) == null ? void 0 : _b2.description.includes("Google developers console API activation");
        })) {
          throw new AIError(AIErrorCode.API_NOT_ENABLED, `The Firebase AI SDK requires the Firebase AI API ('firebasevertexai.googleapis.com') to be enabled in your Firebase project. Enable this API by visiting the Firebase Console at https://console.firebase.google.com/project/${url.params.apiSettings.project}/ailogic/ and clicking "Get started". If you enabled this API recently, wait a few minutes for the action to propagate to our systems and then retry.`, {
            status: response.status,
            statusText: response.statusText,
            errorDetails
          });
        }
        throw new AIError(AIErrorCode.FETCH_ERROR, `Error fetching from ${url}: [${response.status} ${response.statusText}] ${message}`, {
          status: response.status,
          statusText: response.statusText,
          errorDetails
        });
      }
    } catch (e) {
      let err = e;
      if (e.code !== AIErrorCode.FETCH_ERROR && e.code !== AIErrorCode.API_NOT_ENABLED && e instanceof Error && e.name !== ABORT_ERROR_NAME) {
        err = new AIError(AIErrorCode.ERROR, `Error fetching from ${url.toString()}: ${e.message}`);
        err.stack = e.stack;
      }
      throw err;
    } finally {
      clearTimeout(fetchTimeoutId);
    }
    return response;
  }
  /**
   * @license
   * Copyright 2024 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  function hasValidCandidates(response) {
    if (response.candidates && response.candidates.length > 0) {
      if (response.candidates.length > 1) {
        logger$1.warn(`This response had ${response.candidates.length} candidates. Returning text from the first candidate only. Access response.candidates directly to use the other candidates.`);
      }
      if (hadBadFinishReason(response.candidates[0])) {
        throw new AIError(AIErrorCode.RESPONSE_ERROR, `Response error: ${formatBlockErrorMessage(response)}. Response body stored in error.response`, {
          response
        });
      }
      return true;
    } else {
      return false;
    }
  }
  function createEnhancedContentResponse(response, inferenceSource = InferenceSource.IN_CLOUD) {
    if (response.candidates && !response.candidates[0].hasOwnProperty("index")) {
      response.candidates[0].index = 0;
    }
    const responseWithHelpers = addHelpers(response);
    responseWithHelpers.inferenceSource = inferenceSource;
    return responseWithHelpers;
  }
  function addHelpers(response) {
    response.text = () => {
      if (hasValidCandidates(response)) {
        return getText(response, (part) => !part.thought);
      } else if (response.promptFeedback) {
        throw new AIError(AIErrorCode.RESPONSE_ERROR, `Text not available. ${formatBlockErrorMessage(response)}`, {
          response
        });
      }
      return "";
    };
    response.thoughtSummary = () => {
      if (hasValidCandidates(response)) {
        const result = getText(response, (part) => !!part.thought);
        return result === "" ? void 0 : result;
      } else if (response.promptFeedback) {
        throw new AIError(AIErrorCode.RESPONSE_ERROR, `Thought summary not available. ${formatBlockErrorMessage(response)}`, {
          response
        });
      }
      return void 0;
    };
    response.inlineDataParts = () => {
      if (hasValidCandidates(response)) {
        return getInlineDataParts(response);
      } else if (response.promptFeedback) {
        throw new AIError(AIErrorCode.RESPONSE_ERROR, `Data not available. ${formatBlockErrorMessage(response)}`, {
          response
        });
      }
      return void 0;
    };
    response.functionCalls = () => {
      if (hasValidCandidates(response)) {
        return getFunctionCalls(response);
      } else if (response.promptFeedback) {
        throw new AIError(AIErrorCode.RESPONSE_ERROR, `Function call not available. ${formatBlockErrorMessage(response)}`, {
          response
        });
      }
      return void 0;
    };
    return response;
  }
  function getText(response, partFilter) {
    var _a, _b, _c, _d;
    const textStrings = [];
    if ((_b = (_a = response.candidates) == null ? void 0 : _a[0].content) == null ? void 0 : _b.parts) {
      for (const part of (_d = (_c = response.candidates) == null ? void 0 : _c[0].content) == null ? void 0 : _d.parts) {
        if (part.text && partFilter(part)) {
          textStrings.push(part.text);
        }
      }
    }
    if (textStrings.length > 0) {
      return textStrings.join("");
    } else {
      return "";
    }
  }
  function getFunctionCalls(response) {
    var _a, _b, _c, _d;
    if (!response) {
      return void 0;
    }
    const functionCalls = [];
    if ((_b = (_a = response.candidates) == null ? void 0 : _a[0].content) == null ? void 0 : _b.parts) {
      for (const part of (_d = (_c = response.candidates) == null ? void 0 : _c[0].content) == null ? void 0 : _d.parts) {
        if (part.functionCall) {
          functionCalls.push(part.functionCall);
        }
      }
    }
    if (functionCalls.length > 0) {
      return functionCalls;
    } else {
      return void 0;
    }
  }
  function getInlineDataParts(response) {
    var _a, _b, _c, _d;
    const data = [];
    if ((_b = (_a = response.candidates) == null ? void 0 : _a[0].content) == null ? void 0 : _b.parts) {
      for (const part of (_d = (_c = response.candidates) == null ? void 0 : _c[0].content) == null ? void 0 : _d.parts) {
        if (part.inlineData) {
          data.push(part);
        }
      }
    }
    if (data.length > 0) {
      return data;
    } else {
      return void 0;
    }
  }
  const badFinishReasons = [
    FinishReason.RECITATION,
    FinishReason.SAFETY,
    FinishReason.BLOCKLIST,
    FinishReason.PROHIBITED_CONTENT,
    FinishReason.SPII,
    FinishReason.MALFORMED_FUNCTION_CALL,
    FinishReason.IMAGE_SAFETY,
    FinishReason.IMAGE_PROHIBITED_CONTENT,
    FinishReason.IMAGE_OTHER,
    FinishReason.NO_IMAGE,
    FinishReason.IMAGE_RECITATION,
    FinishReason.LANGUAGE,
    FinishReason.UNEXPECTED_TOOL_CALL,
    FinishReason.TOO_MANY_TOOL_CALLS,
    FinishReason.MISSING_THOUGHT_SIGNATURE,
    FinishReason.MALFORMED_RESPONSE
  ];
  function hadBadFinishReason(candidate) {
    return !!candidate.finishReason && badFinishReasons.some((reason) => reason === candidate.finishReason);
  }
  function formatBlockErrorMessage(response) {
    var _a, _b, _c;
    let message = "";
    if ((!response.candidates || response.candidates.length === 0) && response.promptFeedback) {
      message += "Response was blocked";
      if ((_a = response.promptFeedback) == null ? void 0 : _a.blockReason) {
        message += ` due to ${response.promptFeedback.blockReason}`;
      }
      if ((_b = response.promptFeedback) == null ? void 0 : _b.blockReasonMessage) {
        message += `: ${response.promptFeedback.blockReasonMessage}`;
      }
    } else if ((_c = response.candidates) == null ? void 0 : _c[0]) {
      const firstCandidate = response.candidates[0];
      if (hadBadFinishReason(firstCandidate)) {
        message += `Candidate was blocked due to ${firstCandidate.finishReason}`;
        if (firstCandidate.finishMessage) {
          message += `: ${firstCandidate.finishMessage}`;
        }
      }
    }
    return message;
  }
  /**
   * @license
   * Copyright 2025 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  function mapGenerateContentRequest(generateContentRequest) {
    var _a, _b;
    (_a = generateContentRequest.safetySettings) == null ? void 0 : _a.forEach((safetySetting) => {
      if (safetySetting.method) {
        throw new AIError(AIErrorCode.UNSUPPORTED, "SafetySetting.method is not supported in the the Gemini Developer API. Please remove this property.");
      }
    });
    if ((_b = generateContentRequest.generationConfig) == null ? void 0 : _b.topK) {
      const roundedTopK = Math.round(generateContentRequest.generationConfig.topK);
      if (roundedTopK !== generateContentRequest.generationConfig.topK) {
        logger$1.warn("topK in GenerationConfig has been rounded to the nearest integer to match the format for requests to the Gemini Developer API.");
        generateContentRequest.generationConfig.topK = roundedTopK;
      }
    }
    return generateContentRequest;
  }
  function mapGenerateContentResponse(googleAIResponse) {
    const generateContentResponse = {
      candidates: googleAIResponse.candidates ? mapGenerateContentCandidates(googleAIResponse.candidates) : void 0,
      prompt: googleAIResponse.promptFeedback ? mapPromptFeedback(googleAIResponse.promptFeedback) : void 0,
      usageMetadata: googleAIResponse.usageMetadata
    };
    return generateContentResponse;
  }
  function mapCountTokensRequest(countTokensRequest, model) {
    const mappedCountTokensRequest = {
      generateContentRequest: {
        model,
        ...countTokensRequest
      }
    };
    return mappedCountTokensRequest;
  }
  function mapGenerateContentCandidates(candidates) {
    const mappedCandidates = [];
    let mappedSafetyRatings;
    if (mappedCandidates) {
      candidates.forEach((candidate) => {
        var _a, _b;
        let citationMetadata;
        if (candidate.citationMetadata) {
          citationMetadata = {
            citations: candidate.citationMetadata.citationSources
          };
        }
        if (candidate.safetyRatings) {
          mappedSafetyRatings = candidate.safetyRatings.map((safetyRating) => {
            return {
              ...safetyRating,
              severity: safetyRating.severity ?? HarmSeverity.HARM_SEVERITY_UNSUPPORTED,
              probabilityScore: safetyRating.probabilityScore ?? 0,
              severityScore: safetyRating.severityScore ?? 0
            };
          });
        }
        if ((_b = (_a = candidate.content) == null ? void 0 : _a.parts) == null ? void 0 : _b.some((part) => part == null ? void 0 : part.videoMetadata)) {
          throw new AIError(AIErrorCode.UNSUPPORTED, "Part.videoMetadata is not supported in the Gemini Developer API. Please remove this property.");
        }
        const mappedCandidate = {
          index: candidate.index,
          content: candidate.content,
          finishReason: candidate.finishReason,
          finishMessage: candidate.finishMessage,
          safetyRatings: mappedSafetyRatings,
          citationMetadata,
          groundingMetadata: candidate.groundingMetadata,
          urlContextMetadata: candidate.urlContextMetadata
        };
        mappedCandidates.push(mappedCandidate);
      });
    }
    return mappedCandidates;
  }
  function mapPromptFeedback(promptFeedback) {
    const mappedSafetyRatings = [];
    promptFeedback.safetyRatings.forEach((safetyRating) => {
      mappedSafetyRatings.push({
        category: safetyRating.category,
        probability: safetyRating.probability,
        severity: safetyRating.severity ?? HarmSeverity.HARM_SEVERITY_UNSUPPORTED,
        probabilityScore: safetyRating.probabilityScore ?? 0,
        severityScore: safetyRating.severityScore ?? 0,
        blocked: safetyRating.blocked
      });
    });
    const mappedPromptFeedback = {
      blockReason: promptFeedback.blockReason,
      safetyRatings: mappedSafetyRatings,
      blockReasonMessage: promptFeedback.blockReasonMessage
    };
    return mappedPromptFeedback;
  }
  /**
   * @license
   * Copyright 2024 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  const responseLineRE = /^data\: (.*)(?:\n\n|\r\r|\r\n\r\n)/;
  async function processStream(response, apiSettings, inferenceSource) {
    const inputStream = response.body.pipeThrough(new TextDecoderStream("utf8", { fatal: true }));
    const responseStream = getResponseStream(inputStream);
    const [stream1, stream2] = responseStream.tee();
    const { response: internalResponse, firstValue } = await processStreamInternal(stream2, apiSettings, inferenceSource);
    return {
      stream: generateResponseSequence(stream1, apiSettings, inferenceSource),
      response: internalResponse,
      firstValue
    };
  }
  async function processStreamInternal(stream, apiSettings, inferenceSource) {
    const [streamForPeek, streamForAggregation] = stream.tee();
    const reader = streamForPeek.getReader();
    const { value } = await reader.read();
    return {
      firstValue: value,
      response: getResponsePromise(streamForAggregation, apiSettings, inferenceSource)
    };
  }
  async function getResponsePromise(stream, apiSettings, inferenceSource) {
    const allResponses = [];
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        let generateContentResponse = aggregateResponses(allResponses);
        if (apiSettings.backend.backendType === BackendType.GOOGLE_AI) {
          generateContentResponse = mapGenerateContentResponse(generateContentResponse);
        }
        return createEnhancedContentResponse(generateContentResponse, inferenceSource);
      }
      allResponses.push(value);
    }
  }
  async function* generateResponseSequence(stream, apiSettings, inferenceSource) {
    var _a, _b;
    const reader = stream.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      let enhancedResponse;
      if (apiSettings.backend.backendType === BackendType.GOOGLE_AI) {
        enhancedResponse = createEnhancedContentResponse(mapGenerateContentResponse(value), inferenceSource);
      } else {
        enhancedResponse = createEnhancedContentResponse(value, inferenceSource);
      }
      const firstCandidate = (_a = enhancedResponse.candidates) == null ? void 0 : _a[0];
      if (!((_b = firstCandidate == null ? void 0 : firstCandidate.content) == null ? void 0 : _b.parts) && !(firstCandidate == null ? void 0 : firstCandidate.finishReason) && !(firstCandidate == null ? void 0 : firstCandidate.citationMetadata) && !(firstCandidate == null ? void 0 : firstCandidate.urlContextMetadata)) {
        continue;
      }
      yield enhancedResponse;
    }
  }
  function getResponseStream(inputStream) {
    const reader = inputStream.getReader();
    const stream = new ReadableStream({
      start(controller) {
        let currentText = "";
        return pump();
        function pump() {
          return reader.read().then(({ value, done }) => {
            if (done) {
              if (currentText.trim()) {
                controller.error(new AIError(AIErrorCode.PARSE_FAILED, "Failed to parse stream"));
                return;
              }
              controller.close();
              return;
            }
            currentText += value;
            let match = currentText.match(responseLineRE);
            let parsedResponse;
            while (match) {
              try {
                parsedResponse = JSON.parse(match[1]);
              } catch (e) {
                controller.error(new AIError(AIErrorCode.PARSE_FAILED, `Error parsing JSON response: "${match[1]}`));
                return;
              }
              controller.enqueue(parsedResponse);
              currentText = currentText.substring(match[0].length);
              match = currentText.match(responseLineRE);
            }
            return pump();
          });
        }
      }
    });
    return stream;
  }
  function aggregateResponses(responses) {
    const lastResponse = responses[responses.length - 1];
    const aggregatedResponse = {
      promptFeedback: lastResponse == null ? void 0 : lastResponse.promptFeedback
    };
    for (const response of responses) {
      if (response.candidates) {
        for (const candidate of response.candidates) {
          const i = candidate.index || 0;
          if (!aggregatedResponse.candidates) {
            aggregatedResponse.candidates = [];
          }
          if (!aggregatedResponse.candidates[i]) {
            aggregatedResponse.candidates[i] = {
              index: candidate.index
            };
          }
          aggregatedResponse.candidates[i].citationMetadata = candidate.citationMetadata;
          aggregatedResponse.candidates[i].finishReason = candidate.finishReason;
          aggregatedResponse.candidates[i].finishMessage = candidate.finishMessage;
          aggregatedResponse.candidates[i].safetyRatings = candidate.safetyRatings;
          aggregatedResponse.candidates[i].groundingMetadata = candidate.groundingMetadata;
          const urlContextMetadata = candidate.urlContextMetadata;
          if (typeof urlContextMetadata === "object" && urlContextMetadata !== null && Object.keys(urlContextMetadata).length > 0) {
            aggregatedResponse.candidates[i].urlContextMetadata = urlContextMetadata;
          }
          if (candidate.content) {
            if (!candidate.content.parts) {
              continue;
            }
            if (!aggregatedResponse.candidates[i].content) {
              aggregatedResponse.candidates[i].content = {
                role: candidate.content.role || "user",
                parts: []
              };
            }
            for (const part of candidate.content.parts) {
              const newPart = { ...part };
              if (part.text === "") {
                continue;
              }
              if (Object.keys(newPart).length > 0) {
                aggregatedResponse.candidates[i].content.parts.push(newPart);
              }
            }
          }
        }
      }
    }
    return aggregatedResponse;
  }
  /**
   * @license
   * Copyright 2025 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  const errorsCausingFallback = [
    // most network errors
    AIErrorCode.FETCH_ERROR,
    // fallback code for all other errors in makeRequest
    AIErrorCode.ERROR,
    // error due to API not being enabled in project
    AIErrorCode.API_NOT_ENABLED
  ];
  async function callCloudOrDevice(request, chromeAdapter, onDeviceCall, inCloudCall) {
    if (!chromeAdapter) {
      return {
        response: await inCloudCall(),
        inferenceSource: InferenceSource.IN_CLOUD
      };
    }
    switch (chromeAdapter.mode) {
      case InferenceMode.ONLY_ON_DEVICE:
        if (await chromeAdapter.isAvailable(request)) {
          return {
            response: await onDeviceCall(),
            inferenceSource: InferenceSource.ON_DEVICE
          };
        }
        throw new AIError(AIErrorCode.UNSUPPORTED, "Inference mode is ONLY_ON_DEVICE, but an on-device model is not available.");
      case InferenceMode.ONLY_IN_CLOUD:
        return {
          response: await inCloudCall(),
          inferenceSource: InferenceSource.IN_CLOUD
        };
      case InferenceMode.PREFER_IN_CLOUD:
        try {
          return {
            response: await inCloudCall(),
            inferenceSource: InferenceSource.IN_CLOUD
          };
        } catch (e) {
          if (e instanceof AIError && errorsCausingFallback.includes(e.code) && await chromeAdapter.isAvailable(request)) {
            return {
              response: await onDeviceCall(),
              inferenceSource: InferenceSource.ON_DEVICE
            };
          }
          throw e;
        }
      case InferenceMode.PREFER_ON_DEVICE:
        if (await chromeAdapter.isAvailable(request)) {
          return {
            response: await onDeviceCall(),
            inferenceSource: InferenceSource.ON_DEVICE
          };
        }
        return {
          response: await inCloudCall(),
          inferenceSource: InferenceSource.IN_CLOUD
        };
      default:
        throw new AIError(AIErrorCode.ERROR, `Unexpected infererence mode: ${chromeAdapter.mode}`);
    }
  }
  /**
   * @license
   * Copyright 2024 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  async function generateContentStreamOnCloud(apiSettings, model, params2, singleRequestOptions) {
    if (apiSettings.backend.backendType === BackendType.GOOGLE_AI) {
      params2 = mapGenerateContentRequest(params2);
    }
    return makeRequest({
      task: "streamGenerateContent",
      model,
      apiSettings,
      stream: true,
      singleRequestOptions
    }, JSON.stringify(params2));
  }
  async function generateContentStream(apiSettings, model, params2, chromeAdapter, singleRequestOptions) {
    const callResult = await callCloudOrDevice(params2, chromeAdapter, () => chromeAdapter.generateContentStream(params2), () => generateContentStreamOnCloud(apiSettings, model, params2, singleRequestOptions));
    return processStream(callResult.response, apiSettings, callResult.inferenceSource);
  }
  async function generateContentOnCloud(apiSettings, model, params2, singleRequestOptions) {
    if (apiSettings.backend.backendType === BackendType.GOOGLE_AI) {
      params2 = mapGenerateContentRequest(params2);
    }
    return makeRequest({
      model,
      task: "generateContent",
      apiSettings,
      stream: false,
      singleRequestOptions
    }, JSON.stringify(params2));
  }
  async function generateContent(apiSettings, model, params2, chromeAdapter, singleRequestOptions) {
    const callResult = await callCloudOrDevice(params2, chromeAdapter, () => chromeAdapter.generateContent(params2), () => generateContentOnCloud(apiSettings, model, params2, singleRequestOptions));
    const generateContentResponse = await processGenerateContentResponse(callResult.response, apiSettings);
    const enhancedResponse = createEnhancedContentResponse(generateContentResponse, callResult.inferenceSource);
    return {
      response: enhancedResponse
    };
  }
  async function processGenerateContentResponse(response, apiSettings) {
    const responseJson = await response.json();
    if (apiSettings.backend.backendType === BackendType.GOOGLE_AI) {
      return mapGenerateContentResponse(responseJson);
    } else {
      return responseJson;
    }
  }
  /**
   * @license
   * Copyright 2024 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  function formatSystemInstruction(input) {
    if (input == null) {
      return void 0;
    } else if (typeof input === "string") {
      return { role: "system", parts: [{ text: input }] };
    } else if (input.text) {
      return { role: "system", parts: [input] };
    } else if (input.parts) {
      if (!input.role) {
        return { role: "system", parts: input.parts };
      } else {
        return input;
      }
    }
  }
  function formatNewContent(request) {
    let newParts = [];
    if (typeof request === "string") {
      newParts = [{ text: request }];
    } else {
      for (const partOrString of request) {
        if (typeof partOrString === "string") {
          newParts.push({ text: partOrString });
        } else {
          newParts.push(partOrString);
        }
      }
    }
    return assignRoleToPartsAndValidateSendMessageRequest(newParts);
  }
  function assignRoleToPartsAndValidateSendMessageRequest(parts) {
    const content = { role: "user", parts: [] };
    let hasUserContent = false;
    let hasFunctionContent = false;
    for (const part of parts) {
      if ("functionResponse" in part) {
        hasFunctionContent = true;
      } else {
        hasUserContent = true;
      }
      content.parts.push(part);
    }
    if (hasUserContent && hasFunctionContent) {
      throw new AIError(AIErrorCode.INVALID_CONTENT, "Within a single message, FunctionResponse cannot be mixed with other type of Part in the request for sending chat message.");
    }
    if (!hasUserContent && !hasFunctionContent) {
      throw new AIError(AIErrorCode.INVALID_CONTENT, "No Content is provided for sending chat message.");
    }
    return content;
  }
  function formatGenerateContentInput(params2) {
    let formattedRequest;
    if (params2.contents) {
      formattedRequest = params2;
    } else {
      const content = formatNewContent(params2);
      formattedRequest = { contents: [content] };
    }
    if (params2.systemInstruction) {
      formattedRequest.systemInstruction = formatSystemInstruction(params2.systemInstruction);
    }
    return formattedRequest;
  }
  /**
   * @license
   * Copyright 2026 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  const SILENT_ERROR = "SILENT_ERROR";
  const DEFAULT_MAX_SEQUENTIAL_FUNCTION_CALLS = 10;
  class ChatSessionBase {
    constructor(apiSettings, params2, requestOptions) {
      this.params = params2;
      this.requestOptions = requestOptions;
      this._history = [];
      this._sendPromise = Promise.resolve();
      this._apiSettings = apiSettings;
    }
    /**
     * Gets the chat history so far. Blocked prompts are not added to history.
     * Neither blocked candidates nor the prompts that generated them are added
     * to history.
     */
    async getHistory() {
      await this._sendPromise;
      return this._history;
    }
    /**
     * Sends a chat message and receives a non-streaming
     * {@link GenerateContentResult}
     * @internal
     */
    async _sendMessage(request, singleRequestOptions) {
      let finalResult = {};
      await this._sendPromise;
      const tempHistory = [];
      this._sendPromise = this._sendPromise.then(async () => {
        var _a, _b, _c;
        let functionCalls;
        let functionCallTurnCount = 0;
        const functionCallMaxTurns = ((_a = this.requestOptions) == null ? void 0 : _a.maxSequentialFunctionCalls) ?? DEFAULT_MAX_SEQUENTIAL_FUNCTION_CALLS;
        do {
          let formattedContent;
          if (functionCalls) {
            functionCallTurnCount++;
            const functionResponseParts = await this._callFunctionsAsNeeded(functionCalls);
            formattedContent = formatNewContent(functionResponseParts);
          } else {
            formattedContent = formatNewContent(request);
          }
          const formattedRequest = this._formatRequest(formattedContent, [
            ...tempHistory
          ]);
          tempHistory.push(formattedContent);
          const result = await this._callGenerateContent(formattedRequest, singleRequestOptions);
          if (result) {
            finalResult = result;
            functionCalls = this._getCallableFunctionCalls(result.response);
            if (result.response.candidates && result.response.candidates.length > 0) {
              const responseContent = {
                parts: ((_b = result.response.candidates) == null ? void 0 : _b[0].content.parts) || [],
                // Response seems to come back without a role set.
                role: ((_c = result.response.candidates) == null ? void 0 : _c[0].content.role) || "model"
              };
              tempHistory.push(responseContent);
            } else {
              const blockErrorMessage = formatBlockErrorMessage(result.response);
              if (blockErrorMessage) {
                logger$1.warn(`sendMessage() was unsuccessful. ${blockErrorMessage}. Inspect response object for details.`);
              }
            }
          } else {
            functionCalls = void 0;
          }
        } while (functionCalls && functionCallTurnCount < functionCallMaxTurns);
        if (functionCalls && functionCallTurnCount >= functionCallMaxTurns) {
          logger$1.warn(`Automatic function calling exceeded the limit of ${functionCallMaxTurns} function calls. Returning last model response.`);
        }
      });
      await this._sendPromise;
      this._history = this._history.concat(tempHistory);
      return finalResult;
    }
    /**
     * Sends a chat message and receives the response as a
     * {@link GenerateContentStreamResult} containing an iterable stream
     * and a response promise.
     * @internal
     */
    async _sendMessageStream(request, singleRequestOptions) {
      await this._sendPromise;
      const tempHistory = [];
      const callGenerateContentStream = async () => {
        var _a;
        let functionCalls;
        let functionCallTurnCount = 0;
        const functionCallMaxTurns = ((_a = this.requestOptions) == null ? void 0 : _a.maxSequentialFunctionCalls) ?? DEFAULT_MAX_SEQUENTIAL_FUNCTION_CALLS;
        let result;
        do {
          let formattedContent;
          if (functionCalls) {
            functionCallTurnCount++;
            const functionResponseParts = await this._callFunctionsAsNeeded(functionCalls);
            formattedContent = formatNewContent(functionResponseParts);
          } else {
            formattedContent = formatNewContent(request);
          }
          const formattedRequest = this._formatRequest(formattedContent, [
            ...tempHistory
          ]);
          tempHistory.push(formattedContent);
          result = await this._callGenerateContentStream(formattedRequest, singleRequestOptions);
          functionCalls = this._getCallableFunctionCalls(result.firstValue);
          if (functionCalls && result.firstValue && result.firstValue.candidates && result.firstValue.candidates.length > 0) {
            const responseContent = {
              ...result.firstValue.candidates[0].content
            };
            if (!responseContent.role) {
              responseContent.role = "model";
            }
            tempHistory.push(responseContent);
          }
        } while (functionCalls && functionCallTurnCount < functionCallMaxTurns);
        if (functionCalls && functionCallTurnCount >= functionCallMaxTurns) {
          logger$1.warn(`Automatic function calling exceeded the limit of ${functionCallMaxTurns} function calls. Returning last model response.`);
        }
        return { stream: result.stream, response: result.response };
      };
      const streamPromise = callGenerateContentStream();
      this._sendPromise = this._sendPromise.then(async () => streamPromise).catch((_ignored) => {
        throw new Error(SILENT_ERROR);
      }).then((streamResult) => streamResult.response).then((response) => {
        if (response.candidates && response.candidates.length > 0) {
          this._history = this._history.concat(tempHistory);
          const responseContent = { ...response.candidates[0].content };
          if (!responseContent.role) {
            responseContent.role = "model";
          }
          this._history.push(responseContent);
        } else {
          const blockErrorMessage = formatBlockErrorMessage(response);
          if (blockErrorMessage) {
            logger$1.warn(`sendMessageStream() was unsuccessful. ${blockErrorMessage}. Inspect response object for details.`);
          }
        }
      }).catch((e) => {
        if (e.message !== SILENT_ERROR && e.name !== "AbortError") {
          logger$1.error(e);
        }
      });
      return streamPromise;
    }
    /**
     * Get function calls that the SDK has references to actually call.
     * This is all-or-nothing. If the model is requesting multiple
     * function calls, all of them must have references in order for
     * automatic function calling to work.
     *
     * @internal
     */
    _getCallableFunctionCalls(response) {
      var _a, _b, _c;
      const functionDeclarationsTool = (_b = (_a = this.params) == null ? void 0 : _a.tools) == null ? void 0 : _b.find((tool) => tool.functionDeclarations);
      if (!(functionDeclarationsTool == null ? void 0 : functionDeclarationsTool.functionDeclarations)) {
        return;
      }
      const functionCalls = getFunctionCalls(response);
      if (!functionCalls) {
        return;
      }
      for (const functionCall of functionCalls) {
        const hasFunctionReference = (_c = functionDeclarationsTool.functionDeclarations) == null ? void 0 : _c.some((declaration) => declaration.name === functionCall.name && typeof declaration.functionReference === "function");
        if (!hasFunctionReference) {
          return;
        }
      }
      return functionCalls;
    }
    /**
     * Call user-defined functions if requested by the model, and return
     * the response that should be sent to the model.
     * @internal
     */
    async _callFunctionsAsNeeded(functionCalls) {
      var _a, _b;
      const activeCallList = [];
      const promiseList = [];
      const functionDeclarationsTool = (_b = (_a = this.params) == null ? void 0 : _a.tools) == null ? void 0 : _b.find((tool) => tool.functionDeclarations);
      if (functionDeclarationsTool && functionDeclarationsTool.functionDeclarations) {
        for (const functionCall of functionCalls) {
          const functionDeclaration = functionDeclarationsTool.functionDeclarations.find((declaration) => declaration.name === functionCall.name);
          if (functionDeclaration == null ? void 0 : functionDeclaration.functionReference) {
            const results = Promise.resolve(functionDeclaration.functionReference(functionCall.args)).catch((e) => {
              const wrappedError = new AIError(AIErrorCode.ERROR, `Error in user-defined function "${functionDeclaration.name}": ${e.message}`);
              wrappedError.stack = e.stack;
              throw wrappedError;
            });
            activeCallList.push({
              name: functionCall.name,
              id: functionCall.id,
              results
            });
            promiseList.push(results);
          }
        }
        await Promise.all(promiseList);
        const functionResponseParts = [];
        for (const { name: name2, id: id2, results } of activeCallList) {
          const functionResponse = {
            name: name2,
            response: await results
          };
          if (id2) {
            functionResponse.id = id2;
          }
          functionResponseParts.push({
            functionResponse
          });
        }
        return functionResponseParts;
      } else {
        throw new AIError(AIErrorCode.REQUEST_ERROR, `No function declarations were provided in "tools".`);
      }
    }
  }
  /**
   * @license
   * Copyright 2024 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  const VALID_PART_FIELDS = [
    "text",
    "inlineData",
    "functionCall",
    "functionResponse",
    "thought",
    "thoughtSignature"
  ];
  const VALID_PARTS_PER_ROLE = {
    user: ["text", "inlineData", "functionResponse"],
    function: ["functionResponse"],
    model: ["text", "functionCall", "thought", "thoughtSignature"],
    // System instructions shouldn't be in history anyway.
    system: ["text"]
  };
  const VALID_PREVIOUS_CONTENT_ROLES = {
    user: ["model"],
    function: ["model"],
    model: ["user", "function"],
    // System instructions shouldn't be in history.
    system: []
  };
  function validateChatHistory(history) {
    let prevContent = null;
    for (const currContent of history) {
      const { role, parts } = currContent;
      if (!prevContent && role !== "user") {
        throw new AIError(AIErrorCode.INVALID_CONTENT, `First Content should be with role 'user', got ${role}`);
      }
      if (!POSSIBLE_ROLES.includes(role)) {
        throw new AIError(AIErrorCode.INVALID_CONTENT, `Each item should include role field. Got ${role} but valid roles are: ${JSON.stringify(POSSIBLE_ROLES)}`);
      }
      if (!Array.isArray(parts)) {
        throw new AIError(AIErrorCode.INVALID_CONTENT, `Content should have 'parts' property with an array of Parts`);
      }
      if (parts.length === 0) {
        throw new AIError(AIErrorCode.INVALID_CONTENT, `Each Content should have at least one part`);
      }
      const countFields = {
        text: 0,
        inlineData: 0,
        functionCall: 0,
        functionResponse: 0,
        thought: 0,
        thoughtSignature: 0,
        executableCode: 0,
        codeExecutionResult: 0
      };
      for (const part of parts) {
        for (const key of VALID_PART_FIELDS) {
          if (key in part) {
            countFields[key] += 1;
          }
        }
      }
      const validParts = VALID_PARTS_PER_ROLE[role];
      for (const key of VALID_PART_FIELDS) {
        if (!validParts.includes(key) && countFields[key] > 0) {
          throw new AIError(AIErrorCode.INVALID_CONTENT, `Content with role '${role}' can't contain '${key}' part`);
        }
      }
      if (prevContent) {
        const validPreviousContentRoles = VALID_PREVIOUS_CONTENT_ROLES[role];
        if (!validPreviousContentRoles.includes(prevContent.role)) {
          throw new AIError(AIErrorCode.INVALID_CONTENT, `Content with role '${role}' can't follow '${prevContent.role}'. Valid previous roles: ${JSON.stringify(VALID_PREVIOUS_CONTENT_ROLES)}`);
        }
      }
      prevContent = currContent;
    }
  }
  /**
   * @license
   * Copyright 2024 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  class ChatSession extends ChatSessionBase {
    constructor(apiSettings, model, chromeAdapter, params2, requestOptions) {
      var _a;
      super(apiSettings, params2, requestOptions);
      this.model = model;
      this.chromeAdapter = chromeAdapter;
      this.params = params2;
      this.requestOptions = requestOptions;
      if (params2 == null ? void 0 : params2.history) {
        validateChatHistory(params2.history);
        this._history = params2.history;
      }
      if (((_a = this.params) == null ? void 0 : _a.systemInstruction) != null) {
        this.params = {
          ...this.params,
          systemInstruction: formatSystemInstruction(this.params.systemInstruction)
        };
      }
    }
    /**
     * Format Content into a request for generateContent or
     * generateContentStream.
     * @internal
     */
    _formatRequest(incomingContent, tempHistory) {
      var _a, _b, _c, _d, _e;
      return {
        safetySettings: (_a = this.params) == null ? void 0 : _a.safetySettings,
        generationConfig: (_b = this.params) == null ? void 0 : _b.generationConfig,
        tools: (_c = this.params) == null ? void 0 : _c.tools,
        toolConfig: (_d = this.params) == null ? void 0 : _d.toolConfig,
        systemInstruction: (_e = this.params) == null ? void 0 : _e.systemInstruction,
        contents: [...this._history, ...tempHistory, incomingContent]
      };
    }
    /**
     * Calls default generateContent() (versus a specialized one like
     * templateGenerateContent).
     * @internal
     */
    _callGenerateContent(formattedRequest, singleRequestOptions) {
      return generateContent(this._apiSettings, this.model, formattedRequest, this.chromeAdapter, {
        ...this.requestOptions,
        ...singleRequestOptions
      });
    }
    /**
     * Calls default generateContentStream() (versus a specialized one like
     * templateGenerateContentStream).
     * @internal
     */
    _callGenerateContentStream(formattedRequest, singleRequestOptions) {
      return generateContentStream(this._apiSettings, this.model, formattedRequest, this.chromeAdapter, {
        ...this.requestOptions,
        ...singleRequestOptions
      });
    }
    /**
     * Sends a chat message and receives a non-streaming
     * {@link GenerateContentResult}
     */
    async sendMessage(request, singleRequestOptions) {
      return this._sendMessage(request, singleRequestOptions);
    }
    /**
     * Sends a chat message and receives the response as a
     * {@link GenerateContentStreamResult} containing an iterable stream
     * and a response promise.
     */
    async sendMessageStream(request, singleRequestOptions) {
      return this._sendMessageStream(request, singleRequestOptions);
    }
  }
  /**
   * @license
   * Copyright 2024 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  async function countTokensOnCloud(apiSettings, model, params2, singleRequestOptions) {
    let body = "";
    if (apiSettings.backend.backendType === BackendType.GOOGLE_AI) {
      const mappedParams = mapCountTokensRequest(params2, model);
      body = JSON.stringify(mappedParams);
    } else {
      body = JSON.stringify(params2);
    }
    const response = await makeRequest({
      model,
      task: "countTokens",
      apiSettings,
      stream: false,
      singleRequestOptions
    }, body);
    return response.json();
  }
  async function countTokens(apiSettings, model, params2, chromeAdapter, requestOptions) {
    if ((chromeAdapter == null ? void 0 : chromeAdapter.mode) === InferenceMode.ONLY_ON_DEVICE) {
      throw new AIError(AIErrorCode.UNSUPPORTED, "countTokens() is not supported for on-device models.");
    }
    return countTokensOnCloud(apiSettings, model, params2, requestOptions);
  }
  /**
   * @license
   * Copyright 2024 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  class GenerativeModel extends AIModel {
    constructor(ai, modelParams, requestOptions, chromeAdapter) {
      super(ai, modelParams.model);
      this.chromeAdapter = chromeAdapter;
      this.generationConfig = modelParams.generationConfig || {};
      validateGenerationConfig(this.generationConfig);
      this.safetySettings = modelParams.safetySettings || [];
      this.tools = modelParams.tools;
      this.toolConfig = modelParams.toolConfig;
      this.systemInstruction = formatSystemInstruction(modelParams.systemInstruction);
      this.requestOptions = requestOptions || {};
    }
    /**
     * Initializes on-device models.
     *
     * @remarks
     * This may trigger a download on first
     * use. Wait for this promise to complete before calling inference
     * methods if you want to ensure the device models are ready before
     * any calls. Calling inference methods before the device is ready
     * will result in a cloud fallback if `inferenceMode` is set to
     * `PREFER_ON_DEVICE`, and an error if set to `ONLY_ON_DEVICE`.
     *
     * IMPORTANT: This call must be made on or after a user has interacted
     * with the page (for example, through a button click or key press).
     * If it is called without a user interaction, and it requires a download,
     * this will cause an error.
     *
     * See the
     * {@link https://developer.chrome.com/docs/ai/prompt-api#use_the_prompt_api | Prompt API docs }
     * for more details on this requirement.
     *
     * @param onDownloadProgress A callback called repeatedly as the
     * download progresses that provides a `progressValue` between 0
     * and 1 representing how much of the download is complete. This
     * will be ignored if `monitor` was populated in
     * {@link LanguageModelCreateOptions}.
     *
     * @public
     */
    async initializeDeviceModel(onDownloadProgress) {
      if (!this.chromeAdapter || this.chromeAdapter.mode === InferenceMode.ONLY_IN_CLOUD) {
        return;
      }
      const availability = await this.chromeAdapter.downloadIfAvailable(onDownloadProgress);
      if (availability === Availability.UNAVAILABLE) {
        const notEnabledError = new AIError(AIErrorCode.API_NOT_ENABLED, "Local LanguageModel API not available in this environment.");
        if (this.chromeAdapter.mode === InferenceMode.ONLY_ON_DEVICE) {
          throw notEnabledError;
        } else {
          logger$1.debug(notEnabledError.message);
        }
      }
      await this.chromeAdapter.downloadPromise;
    }
    /**
     * Makes a single non-streaming call to the model
     * and returns an object containing a single {@link GenerateContentResponse}.
     */
    async generateContent(request, singleRequestOptions) {
      const formattedParams = formatGenerateContentInput(request);
      return generateContent(
        this._apiSettings,
        this.model,
        {
          generationConfig: this.generationConfig,
          safetySettings: this.safetySettings,
          tools: this.tools,
          toolConfig: this.toolConfig,
          systemInstruction: this.systemInstruction,
          ...formattedParams
        },
        this.chromeAdapter,
        // Merge request options
        {
          ...this.requestOptions,
          ...singleRequestOptions
        }
      );
    }
    /**
     * Makes a single streaming call to the model
     * and returns an object containing an iterable stream that iterates
     * over all chunks in the streaming response as well as
     * a promise that returns the final aggregated response.
     */
    async generateContentStream(request, singleRequestOptions) {
      const formattedParams = formatGenerateContentInput(request);
      const { stream, response } = await generateContentStream(
        this._apiSettings,
        this.model,
        {
          generationConfig: this.generationConfig,
          safetySettings: this.safetySettings,
          tools: this.tools,
          toolConfig: this.toolConfig,
          systemInstruction: this.systemInstruction,
          ...formattedParams
        },
        this.chromeAdapter,
        // Merge request options
        {
          ...this.requestOptions,
          ...singleRequestOptions
        }
      );
      return { stream, response };
    }
    /**
     * Gets a new {@link ChatSession} instance which can be used for
     * multi-turn chats.
     */
    startChat(startChatParams) {
      return new ChatSession(this._apiSettings, this.model, this.chromeAdapter, {
        tools: this.tools,
        toolConfig: this.toolConfig,
        systemInstruction: this.systemInstruction,
        generationConfig: this.generationConfig,
        safetySettings: this.safetySettings,
        /**
         * Overrides params inherited from GenerativeModel with those explicitly set in the
         * StartChatParams. For example, if startChatParams.generationConfig is set, it'll override
         * this.generationConfig.
         */
        ...startChatParams
      }, this.requestOptions);
    }
    /**
     * Counts the tokens in the provided request.
     */
    async countTokens(request, singleRequestOptions) {
      const formattedParams = formatGenerateContentInput(request);
      return countTokens(
        this._apiSettings,
        this.model,
        formattedParams,
        this.chromeAdapter,
        // Merge request options
        {
          ...this.requestOptions,
          ...singleRequestOptions
        }
      );
    }
  }
  function validateGenerationConfig(generationConfig) {
    var _a, _b;
    if (
      // != allows for null and undefined. 0 is considered "set" by the model
      ((_a = generationConfig.thinkingConfig) == null ? void 0 : _a.thinkingBudget) != null && ((_b = generationConfig.thinkingConfig) == null ? void 0 : _b.thinkingLevel)
    ) {
      throw new AIError(AIErrorCode.UNSUPPORTED, `Cannot set both thinkingBudget and thinkingLevel in a config.`);
    }
    if (
      // != allows for null and undefined.
      generationConfig.responseSchema != null && generationConfig.responseJsonSchema != null
    ) {
      throw new AIError(AIErrorCode.UNSUPPORTED, `Cannot set both responseSchema and responseJsonSchema in a config.`);
    }
    if ((generationConfig.responseSchema != null || generationConfig.responseJsonSchema != null) && generationConfig.responseMimeType !== "application/json" && generationConfig.responseMimeType !== "text/x.enum") {
      throw new AIError(AIErrorCode.UNSUPPORTED, `responseMimeType must be set to "application/json" or "text/x.enum" if responseSchema or responseJsonSchema are set.`);
    }
  }
  /**
   * @license
   * Copyright 2024 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  function getAI(app2 = getApp(), options) {
    app2 = getModularInstance(app2);
    const AIProvider = _getProvider(app2, AI_TYPE);
    const backend = (options == null ? void 0 : options.backend) ?? new GoogleAIBackend();
    const finalOptions = {
      useLimitedUseAppCheckTokens: (options == null ? void 0 : options.useLimitedUseAppCheckTokens) ?? false
    };
    const identifier = encodeInstanceIdentifier(backend);
    const aiInstance = AIProvider.getImmediate({
      identifier
    });
    aiInstance.options = finalOptions;
    return aiInstance;
  }
  const hybridParamKeys = [
    "mode",
    "onDeviceParams",
    "inCloudParams"
  ];
  function getGenerativeModel(ai, modelParams, requestOptions) {
    var _a;
    const hybridParams = modelParams;
    let inCloudParams;
    if (hybridParams.mode) {
      for (const param of Object.keys(modelParams)) {
        if (!hybridParamKeys.includes(param)) {
          logger$1.warn(`When a hybrid inference mode is specified (mode is currently set to ${hybridParams.mode}), "${param}" cannot be configured at the top level. Configuration for in-cloud and on-device must be done separately in inCloudParams and onDeviceParams. Configuration values set outside of inCloudParams and onDeviceParams will be ignored.`);
        }
      }
      inCloudParams = hybridParams.inCloudParams || {
        model: DEFAULT_HYBRID_IN_CLOUD_MODEL
      };
    } else {
      inCloudParams = modelParams;
    }
    if (!inCloudParams.model) {
      throw new AIError(AIErrorCode.NO_MODEL, `Must provide a model name. Example: getGenerativeModel({ model: 'my-model-name' })`);
    }
    const chromeAdapter = (_a = ai.chromeAdapterFactory) == null ? void 0 : _a.call(ai, hybridParams.mode, typeof window === "undefined" ? void 0 : window, hybridParams.onDeviceParams);
    const generativeModel = new GenerativeModel(ai, inCloudParams, requestOptions, chromeAdapter);
    generativeModel._apiSettings.inferenceMode = hybridParams.mode;
    return generativeModel;
  }
  /**
   * @license
   * Copyright 2025 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  function registerAI() {
    _registerComponent(new Component(
      AI_TYPE,
      factory$1,
      "PUBLIC"
      /* ComponentType.PUBLIC */
    ).setMultipleInstances(true));
    registerVersion(name$4, version$2);
    registerVersion(name$4, version$2, "esm2020");
  }
  registerAI();
  var name$3 = "firebase";
  var version$1 = "12.19.0";
  /**
   * @license
   * Copyright 2020 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  registerVersion(name$3, version$1, "app");
  /**
   * @license
   * Copyright 2020 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  const APP_CHECK_STATES = /* @__PURE__ */ new Map();
  const DEFAULT_STATE = {
    activated: false,
    tokenObservers: []
  };
  const DEBUG_STATE = {
    initialized: false,
    enabled: false
  };
  function getStateReference(app2) {
    return APP_CHECK_STATES.get(app2) || { ...DEFAULT_STATE };
  }
  function setInitialState(app2, state) {
    APP_CHECK_STATES.set(app2, state);
    return APP_CHECK_STATES.get(app2);
  }
  function getDebugState() {
    return DEBUG_STATE;
  }
  /**
   * @license
   * Copyright 2020 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  const BASE_ENDPOINT = "https://content-firebaseappcheck.googleapis.com/v1";
  const EXCHANGE_RECAPTCHA_ENTERPRISE_TOKEN_METHOD = "exchangeRecaptchaEnterpriseToken";
  const EXCHANGE_DEBUG_TOKEN_METHOD = "exchangeDebugToken";
  const TOKEN_REFRESH_TIME = {
    /**
     * This is the first retrial wait after an error. This is currently
     * 30 seconds.
     */
    RETRIAL_MIN_WAIT: 30 * 1e3,
    /**
     * This is the maximum retrial wait, currently 16 minutes.
     */
    RETRIAL_MAX_WAIT: 16 * 60 * 1e3
  };
  const ONE_DAY = 24 * 60 * 60 * 1e3;
  /**
   * @license
   * Copyright 2020 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  class Refresher {
    constructor(operation, retryPolicy, getWaitDuration, lowerBound, upperBound) {
      this.operation = operation;
      this.retryPolicy = retryPolicy;
      this.getWaitDuration = getWaitDuration;
      this.lowerBound = lowerBound;
      this.upperBound = upperBound;
      this.pending = null;
      this.nextErrorWaitInterval = lowerBound;
      if (lowerBound > upperBound) {
        throw new Error("Proactive refresh lower bound greater than upper bound!");
      }
    }
    start() {
      this.nextErrorWaitInterval = this.lowerBound;
      this.process(true).catch(() => {
      });
    }
    stop() {
      if (this.pending) {
        this.pending.reject("cancelled");
        this.pending = null;
      }
    }
    isRunning() {
      return !!this.pending;
    }
    async process(hasSucceeded) {
      this.stop();
      try {
        this.pending = new Deferred();
        this.pending.promise.catch((_e) => {
        });
        await sleep$1(this.getNextRun(hasSucceeded));
        this.pending.resolve();
        await this.pending.promise;
        this.pending = new Deferred();
        this.pending.promise.catch((_e) => {
        });
        await this.operation();
        this.pending.resolve();
        await this.pending.promise;
        this.process(true).catch(() => {
        });
      } catch (error) {
        if (this.retryPolicy(error)) {
          this.process(false).catch(() => {
          });
        } else {
          this.stop();
        }
      }
    }
    getNextRun(hasSucceeded) {
      if (hasSucceeded) {
        this.nextErrorWaitInterval = this.lowerBound;
        return this.getWaitDuration();
      } else {
        const currentErrorWaitInterval = this.nextErrorWaitInterval;
        this.nextErrorWaitInterval *= 2;
        if (this.nextErrorWaitInterval > this.upperBound) {
          this.nextErrorWaitInterval = this.upperBound;
        }
        return currentErrorWaitInterval;
      }
    }
  }
  function sleep$1(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
  /**
   * @license
   * Copyright 2020 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  const ERRORS = {
    [
      "already-initialized"
      /* AppCheckError.ALREADY_INITIALIZED */
    ]: "You have already called initializeAppCheck() for FirebaseApp {$appName} with different options. To avoid this error, call initializeAppCheck() with the same options as when it was originally called. This will return the already initialized instance.",
    [
      "use-before-activation"
      /* AppCheckError.USE_BEFORE_ACTIVATION */
    ]: "App Check is being used before initializeAppCheck() is called for FirebaseApp {$appName}. Call initializeAppCheck() before instantiating other Firebase services.",
    [
      "fetch-network-error"
      /* AppCheckError.FETCH_NETWORK_ERROR */
    ]: "Fetch failed to connect to a network. Check Internet connection. Original error: {$originalErrorMessage}.",
    [
      "fetch-parse-error"
      /* AppCheckError.FETCH_PARSE_ERROR */
    ]: "Fetch client could not parse response. Original error: {$originalErrorMessage}.",
    [
      "fetch-status-error"
      /* AppCheckError.FETCH_STATUS_ERROR */
    ]: "Fetch server returned an HTTP error status. HTTP status: {$httpStatus}.",
    [
      "storage-open"
      /* AppCheckError.STORAGE_OPEN */
    ]: "Error thrown when opening storage. Original error: {$originalErrorMessage}.",
    [
      "storage-get"
      /* AppCheckError.STORAGE_GET */
    ]: "Error thrown when reading from storage. Original error: {$originalErrorMessage}.",
    [
      "storage-set"
      /* AppCheckError.STORAGE_WRITE */
    ]: "Error thrown when writing to storage. Original error: {$originalErrorMessage}.",
    [
      "recaptcha-error"
      /* AppCheckError.RECAPTCHA_ERROR */
    ]: "ReCAPTCHA error.",
    [
      "initial-throttle"
      /* AppCheckError.INITIAL_THROTTLE */
    ]: `{$httpStatus} error. Attempts allowed again after {$time}`,
    [
      "throttled"
      /* AppCheckError.THROTTLED */
    ]: `Requests throttled due to previous {$httpStatus} error. Attempts allowed again after {$time}`
  };
  const ERROR_FACTORY = new ErrorFactory("appCheck", "AppCheck", ERRORS);
  /**
   * @license
   * Copyright 2020 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  function getRecaptcha(isEnterprise = false) {
    var _a;
    if (isEnterprise) {
      return (_a = self.grecaptcha) == null ? void 0 : _a.enterprise;
    }
    return self.grecaptcha;
  }
  function ensureActivated(app2) {
    if (!getStateReference(app2).activated) {
      throw ERROR_FACTORY.create("use-before-activation", {
        appName: app2.name
      });
    }
  }
  function getDurationString(durationInMillis) {
    const totalSeconds = Math.round(durationInMillis / 1e3);
    const days = Math.floor(totalSeconds / (3600 * 24));
    const hours = Math.floor((totalSeconds - days * 3600 * 24) / 3600);
    const minutes = Math.floor((totalSeconds - days * 3600 * 24 - hours * 3600) / 60);
    const seconds = totalSeconds - days * 3600 * 24 - hours * 3600 - minutes * 60;
    let result = "";
    if (days) {
      result += pad(days) + "d:";
    }
    if (hours) {
      result += pad(hours) + "h:";
    }
    result += pad(minutes) + "m:" + pad(seconds) + "s";
    return result;
  }
  function pad(value) {
    if (value === 0) {
      return "00";
    }
    return value >= 10 ? value.toString() : "0" + value;
  }
  /**
   * @license
   * Copyright 2020 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  async function exchangeToken({ url, body }, heartbeatServiceProvider) {
    const headers = {
      "Content-Type": "application/json"
    };
    const heartbeatService = heartbeatServiceProvider.getImmediate({
      optional: true
    });
    if (heartbeatService) {
      const heartbeatsHeader = await heartbeatService.getHeartbeatsHeader();
      if (heartbeatsHeader) {
        headers["X-Firebase-Client"] = heartbeatsHeader;
      }
    }
    const options = {
      method: "POST",
      body: JSON.stringify(body),
      headers
    };
    let response;
    try {
      response = await fetch(url, options);
    } catch (originalError) {
      throw ERROR_FACTORY.create("fetch-network-error", {
        originalErrorMessage: originalError == null ? void 0 : originalError.message
      });
    }
    if (response.status !== 200) {
      throw ERROR_FACTORY.create("fetch-status-error", {
        httpStatus: response.status
      });
    }
    let responseBody;
    try {
      responseBody = await response.json();
    } catch (originalError) {
      throw ERROR_FACTORY.create("fetch-parse-error", {
        originalErrorMessage: originalError == null ? void 0 : originalError.message
      });
    }
    const match = responseBody.ttl.match(/^([\d.]+)(s)$/);
    if (!match || !match[2] || isNaN(Number(match[1]))) {
      throw ERROR_FACTORY.create("fetch-parse-error", {
        originalErrorMessage: `ttl field (timeToLive) is not in standard Protobuf Duration format: ${responseBody.ttl}`
      });
    }
    const timeToLiveAsNumber = Number(match[1]) * 1e3;
    const now = Date.now();
    return {
      token: responseBody.token,
      expireTimeMillis: now + timeToLiveAsNumber,
      issuedAtTimeMillis: now
    };
  }
  function getExchangeRecaptchaEnterpriseTokenRequest(app2, reCAPTCHAToken) {
    const { projectId, appId, apiKey } = app2.options;
    return {
      url: `${BASE_ENDPOINT}/projects/${projectId}/apps/${appId}:${EXCHANGE_RECAPTCHA_ENTERPRISE_TOKEN_METHOD}?key=${apiKey}`,
      body: {
        "recaptcha_enterprise_token": reCAPTCHAToken
      }
    };
  }
  function getExchangeDebugTokenRequest(app2, debugToken) {
    const { projectId, appId, apiKey } = app2.options;
    return {
      url: `${BASE_ENDPOINT}/projects/${projectId}/apps/${appId}:${EXCHANGE_DEBUG_TOKEN_METHOD}?key=${apiKey}`,
      body: {
        // eslint-disable-next-line
        debug_token: debugToken
      }
    };
  }
  /**
   * @license
   * Copyright 2020 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  const DB_NAME = "firebase-app-check-database";
  const DB_VERSION = 1;
  const STORE_NAME = "firebase-app-check-store";
  const DEBUG_TOKEN_KEY = "debug-token";
  let dbPromise = null;
  function getDBPromise() {
    if (dbPromise) {
      return dbPromise;
    }
    dbPromise = new Promise((resolve, reject) => {
      try {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onsuccess = (event) => {
          resolve(event.target.result);
        };
        request.onerror = (event) => {
          var _a;
          reject(ERROR_FACTORY.create("storage-open", {
            originalErrorMessage: (_a = event.target.error) == null ? void 0 : _a.message
          }));
        };
        request.onupgradeneeded = (event) => {
          const db = event.target.result;
          switch (event.oldVersion) {
            case 0:
              db.createObjectStore(STORE_NAME, {
                keyPath: "compositeKey"
              });
          }
        };
      } catch (e) {
        reject(ERROR_FACTORY.create("storage-open", {
          originalErrorMessage: e == null ? void 0 : e.message
        }));
      }
    });
    return dbPromise;
  }
  function readTokenFromIndexedDB(app2) {
    return read(computeKey(app2));
  }
  function writeTokenToIndexedDB(app2, token) {
    return write(computeKey(app2), token);
  }
  function writeDebugTokenToIndexedDB(token) {
    return write(DEBUG_TOKEN_KEY, token);
  }
  function readDebugTokenFromIndexedDB() {
    return read(DEBUG_TOKEN_KEY);
  }
  async function write(key, value) {
    const db = await getDBPromise();
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put({
      compositeKey: key,
      value
    });
    return new Promise((resolve, reject) => {
      request.onsuccess = (_event) => {
        resolve();
      };
      transaction.onerror = (event) => {
        var _a;
        reject(ERROR_FACTORY.create("storage-set", {
          originalErrorMessage: (_a = event.target.error) == null ? void 0 : _a.message
        }));
      };
    });
  }
  async function read(key) {
    const db = await getDBPromise();
    const transaction = db.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(key);
    return new Promise((resolve, reject) => {
      request.onsuccess = (event) => {
        const result = event.target.result;
        if (result) {
          resolve(result.value);
        } else {
          resolve(void 0);
        }
      };
      transaction.onerror = (event) => {
        var _a;
        reject(ERROR_FACTORY.create("storage-get", {
          originalErrorMessage: (_a = event.target.error) == null ? void 0 : _a.message
        }));
      };
    });
  }
  function computeKey(app2) {
    return `${app2.options.appId}-${app2.name}`;
  }
  /**
   * @license
   * Copyright 2020 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  const logger = new Logger("@firebase/app-check");
  /**
   * @license
   * Copyright 2020 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  async function readTokenFromStorage(app2) {
    if (isIndexedDBAvailable()) {
      let token = void 0;
      try {
        token = await readTokenFromIndexedDB(app2);
      } catch (e) {
        logger.warn(`Failed to read token from IndexedDB. Error: ${e}`);
      }
      return token;
    }
    return void 0;
  }
  function writeTokenToStorage(app2, token) {
    if (isIndexedDBAvailable()) {
      return writeTokenToIndexedDB(app2, token).catch((e) => {
        logger.warn(`Failed to write token to IndexedDB. Error: ${e}`);
      });
    }
    return Promise.resolve();
  }
  async function readOrCreateDebugTokenFromStorage(app2) {
    let existingDebugToken = void 0;
    try {
      existingDebugToken = await readDebugTokenFromIndexedDB();
    } catch (_e) {
    }
    if (!existingDebugToken) {
      const newToken = crypto.randomUUID();
      let message = `To use this token for app debugging, register it with your project.

Firebase App Check debug token: ${newToken}

`;
      const appId = app2 == null ? void 0 : app2.options.appId;
      const projectId = app2 == null ? void 0 : app2.options.projectId;
      if (projectId && appId) {
        message += `You can do so in the Firebase Console:
https://console.firebase.google.com/project/${projectId}/appcheck/apps?selectedAppId=${appId}

Or using the Firebase CLI:
firebase appcheck:debugtokens:create ${newToken} --project ${projectId} --app ${appId}

`;
      } else {
        message += `You will need to add it to your app's App Check settings in the Firebase Console for it to work.

`;
      }
      message += `Note: To keep your project secure, please revoke and delete this token using the
Firebase Console or the CLI (\`firebase appcheck:debugtokens:delete\`) when you finish debugging.

Warning: This debug token is a secret and should not be shared or uploaded to source code.

Debug Token Guide: https://firebase.google.com/docs/app-check/web/debug-provider
Firebase CLI install instructions: https://firebase.google.com/docs/cli
`;
      console.log(message);
      writeDebugTokenToIndexedDB(newToken).catch((e) => logger.warn(`Failed to persist debug token to IndexedDB. Error: ${e}`));
      return newToken;
    } else {
      return existingDebugToken;
    }
  }
  /**
   * @license
   * Copyright 2020 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  function isDebugMode() {
    const debugState = getDebugState();
    return debugState.enabled;
  }
  async function getDebugToken() {
    const state = getDebugState();
    if (state.enabled && state.token) {
      return state.token.promise;
    } else {
      throw Error(`
            Can't get debug token in production mode.
        `);
    }
  }
  function initializeDebugMode(app2) {
    const globals = getGlobal();
    const debugState = getDebugState();
    debugState.initialized = true;
    if (typeof globals.FIREBASE_APPCHECK_DEBUG_TOKEN !== "string" && globals.FIREBASE_APPCHECK_DEBUG_TOKEN !== true) {
      return;
    }
    debugState.enabled = true;
    const deferredToken = new Deferred();
    debugState.token = deferredToken;
    if (typeof globals.FIREBASE_APPCHECK_DEBUG_TOKEN === "string") {
      deferredToken.resolve(globals.FIREBASE_APPCHECK_DEBUG_TOKEN);
    } else {
      deferredToken.resolve(readOrCreateDebugTokenFromStorage(app2));
    }
  }
  /**
   * @license
   * Copyright 2020 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  const defaultTokenErrorData = { error: "UNKNOWN_ERROR" };
  function formatDummyToken(tokenErrorData) {
    return base64.encodeString(
      JSON.stringify(tokenErrorData),
      /* webSafe= */
      false
    );
  }
  async function getToken$2(appCheck, forceRefresh = false, shouldLogErrors = false) {
    const app2 = appCheck.app;
    ensureActivated(app2);
    const state = getStateReference(app2);
    let token = state.token;
    let error = void 0;
    if (token && !isValid(token)) {
      state.token = void 0;
      token = void 0;
    }
    if (!token) {
      const cachedToken = await state.cachedTokenPromise;
      if (cachedToken) {
        if (isValid(cachedToken)) {
          token = cachedToken;
        } else {
          await writeTokenToStorage(app2, void 0);
        }
      }
    }
    if (!forceRefresh && token && isValid(token)) {
      return {
        token: token.token
      };
    }
    let shouldCallListeners = false;
    if (isDebugMode()) {
      try {
        const debugToken = await getDebugToken();
        if (!state.exchangeTokenPromise) {
          state.exchangeTokenPromise = exchangeToken(getExchangeDebugTokenRequest(app2, debugToken), appCheck.heartbeatServiceProvider).finally(() => {
            state.exchangeTokenPromise = void 0;
          });
          shouldCallListeners = true;
        }
        const tokenFromDebugExchange = await state.exchangeTokenPromise;
        await writeTokenToStorage(app2, tokenFromDebugExchange);
        state.token = tokenFromDebugExchange;
        return { token: tokenFromDebugExchange.token };
      } catch (e) {
        if (e.code === `appCheck/${"throttled"}` || e.code === `appCheck/${"initial-throttle"}`) {
          logger.warn(e.message);
        } else if (shouldLogErrors) {
          logger.error(e);
        }
        return makeDummyTokenResult(e);
      }
    }
    try {
      if (!state.exchangeTokenPromise) {
        state.exchangeTokenPromise = state.provider.getToken().finally(() => {
          state.exchangeTokenPromise = void 0;
        });
        shouldCallListeners = true;
      }
      token = await getStateReference(app2).exchangeTokenPromise;
    } catch (e) {
      if (e.code === `appCheck/${"throttled"}` || e.code === `appCheck/${"initial-throttle"}`) {
        logger.warn(e.message);
      } else if (shouldLogErrors) {
        logger.error(e);
      }
      error = e;
    }
    let interopTokenResult;
    if (!token) {
      interopTokenResult = makeDummyTokenResult(error);
    } else if (error) {
      if (isValid(token)) {
        interopTokenResult = {
          token: token.token,
          internalError: error
        };
      } else {
        interopTokenResult = makeDummyTokenResult(error);
      }
    } else {
      interopTokenResult = {
        token: token.token
      };
      state.token = token;
      await writeTokenToStorage(app2, token);
    }
    if (shouldCallListeners) {
      notifyTokenListeners(app2, interopTokenResult);
    }
    return interopTokenResult;
  }
  async function getLimitedUseToken$1(appCheck) {
    const app2 = appCheck.app;
    ensureActivated(app2);
    const { provider } = getStateReference(app2);
    if (isDebugMode()) {
      const debugToken = await getDebugToken();
      const request = getExchangeDebugTokenRequest(app2, debugToken);
      request.body["limited_use"] = true;
      const { token } = await exchangeToken(request, appCheck.heartbeatServiceProvider);
      return { token };
    } else {
      const { token } = await provider.getToken(
        true
        /* isLimitedUse */
      );
      return { token };
    }
  }
  function addTokenListener(appCheck, type, listener, onError) {
    const { app: app2 } = appCheck;
    const state = getStateReference(app2);
    const tokenObserver = {
      next: listener,
      error: onError,
      type
    };
    state.tokenObservers = [...state.tokenObservers, tokenObserver];
    if (state.token && isValid(state.token)) {
      const validToken = state.token;
      Promise.resolve().then(() => {
        listener({ token: validToken.token });
        initTokenRefresher(appCheck);
      }).catch(() => {
      });
    }
    void state.cachedTokenPromise.then(() => initTokenRefresher(appCheck));
  }
  function removeTokenListener(app2, listener) {
    const state = getStateReference(app2);
    const newObservers = state.tokenObservers.filter((tokenObserver) => tokenObserver.next !== listener);
    if (newObservers.length === 0 && state.tokenRefresher && state.tokenRefresher.isRunning()) {
      state.tokenRefresher.stop();
    }
    state.tokenObservers = newObservers;
  }
  function initTokenRefresher(appCheck) {
    const { app: app2 } = appCheck;
    const state = getStateReference(app2);
    let refresher = state.tokenRefresher;
    if (!refresher) {
      refresher = createTokenRefresher(appCheck);
      state.tokenRefresher = refresher;
    }
    if (!refresher.isRunning() && state.isTokenAutoRefreshEnabled) {
      refresher.start();
    }
  }
  function createTokenRefresher(appCheck) {
    const { app: app2 } = appCheck;
    return new Refresher(
      // Keep in mind when this fails for any reason other than the ones
      // for which we should retry, it will effectively stop the proactive refresh.
      async () => {
        const state = getStateReference(app2);
        let result;
        if (!state.token) {
          result = await getToken$2(appCheck);
        } else {
          result = await getToken$2(appCheck, true);
        }
        if (result.error) {
          throw result.error;
        }
        if (result.internalError) {
          throw result.internalError;
        }
      },
      () => {
        return true;
      },
      () => {
        const state = getStateReference(app2);
        if (state.token) {
          let nextRefreshTimeMillis = state.token.issuedAtTimeMillis + (state.token.expireTimeMillis - state.token.issuedAtTimeMillis) * 0.5 + 5 * 60 * 1e3;
          const latestAllowableRefresh = state.token.expireTimeMillis - 5 * 60 * 1e3;
          nextRefreshTimeMillis = Math.min(nextRefreshTimeMillis, latestAllowableRefresh);
          return Math.max(0, nextRefreshTimeMillis - Date.now());
        } else {
          return 0;
        }
      },
      TOKEN_REFRESH_TIME.RETRIAL_MIN_WAIT,
      TOKEN_REFRESH_TIME.RETRIAL_MAX_WAIT
    );
  }
  function notifyTokenListeners(app2, token) {
    const observers = getStateReference(app2).tokenObservers;
    for (const observer of observers) {
      try {
        if (observer.type === "EXTERNAL" && token.error != null) {
          observer.error(token.error);
        } else {
          observer.next(token);
        }
      } catch (e) {
      }
    }
  }
  function isValid(token) {
    return token.expireTimeMillis - Date.now() > 0;
  }
  function makeDummyTokenResult(error) {
    return {
      token: formatDummyToken(defaultTokenErrorData),
      error
    };
  }
  /**
   * @license
   * Copyright 2020 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  class AppCheckService {
    constructor(app2, heartbeatServiceProvider) {
      this.app = app2;
      this.heartbeatServiceProvider = heartbeatServiceProvider;
    }
    _delete() {
      const { tokenObservers } = getStateReference(this.app);
      for (const tokenObserver of tokenObservers) {
        removeTokenListener(this.app, tokenObserver.next);
      }
      return Promise.resolve();
    }
  }
  function factory(app2, heartbeatServiceProvider) {
    return new AppCheckService(app2, heartbeatServiceProvider);
  }
  function internalFactory(appCheck) {
    return {
      getToken: (forceRefresh) => getToken$2(appCheck, forceRefresh),
      getLimitedUseToken: () => getLimitedUseToken$1(appCheck),
      addTokenListener: (listener) => addTokenListener(appCheck, "INTERNAL", listener),
      removeTokenListener: (listener) => removeTokenListener(appCheck.app, listener)
    };
  }
  const name$2 = "@firebase/app-check";
  const version = "0.13.1";
  const RECAPTCHA_ENTERPRISE_URL = "https://www.google.com/recaptcha/enterprise.js";
  function initializeEnterprise(app2, siteKey) {
    const initialized = new Deferred();
    const state = getStateReference(app2);
    state.reCAPTCHAState = { initialized };
    const divId = makeDiv(app2);
    const grecaptcha = getRecaptcha(true);
    if (!grecaptcha) {
      loadReCAPTCHAEnterpriseScript(() => {
        const grecaptcha2 = getRecaptcha(true);
        if (!grecaptcha2) {
          throw new Error("no recaptcha");
        }
        queueWidgetRender(app2, siteKey, grecaptcha2, divId, initialized);
      });
    } else {
      queueWidgetRender(app2, siteKey, grecaptcha, divId, initialized);
    }
    return initialized.promise;
  }
  function queueWidgetRender(app2, siteKey, grecaptcha, container, initialized) {
    grecaptcha.ready(() => {
      renderInvisibleWidget(app2, siteKey, grecaptcha, container);
      initialized.resolve(grecaptcha);
    });
  }
  function makeDiv(app2) {
    const divId = `fire_app_check_${app2.name}`;
    const invisibleDiv = document.createElement("div");
    invisibleDiv.id = divId;
    invisibleDiv.style.display = "none";
    document.body.appendChild(invisibleDiv);
    return divId;
  }
  async function getToken$1(app2) {
    ensureActivated(app2);
    const reCAPTCHAState = getStateReference(app2).reCAPTCHAState;
    const recaptcha = await reCAPTCHAState.initialized.promise;
    return new Promise((resolve, _reject) => {
      const reCAPTCHAState2 = getStateReference(app2).reCAPTCHAState;
      recaptcha.ready(() => {
        resolve(
          // widgetId is guaranteed to be available if reCAPTCHAState.initialized.promise resolved.
          recaptcha.execute(reCAPTCHAState2.widgetId, {
            action: "fire_app_check"
          })
        );
      });
    });
  }
  function renderInvisibleWidget(app2, siteKey, grecaptcha, container) {
    const widgetId = grecaptcha.render(container, {
      sitekey: siteKey,
      size: "invisible",
      // Success callback - set state
      callback: () => {
        getStateReference(app2).reCAPTCHAState.succeeded = true;
      },
      // Failure callback - set state
      "error-callback": () => {
        getStateReference(app2).reCAPTCHAState.succeeded = false;
      }
    });
    const state = getStateReference(app2);
    state.reCAPTCHAState = {
      ...state.reCAPTCHAState,
      // state.reCAPTCHAState is set in the initialize()
      widgetId
    };
  }
  function loadReCAPTCHAEnterpriseScript(onload) {
    const script = document.createElement("script");
    script.src = RECAPTCHA_ENTERPRISE_URL + "?render=explicit";
    script.onload = onload;
    document.head.appendChild(script);
  }
  class ReCaptchaEnterpriseProvider {
    /**
     * Create a ReCaptchaEnterpriseProvider instance.
     * @param siteKey - reCAPTCHA Enterprise score-based site key.
     */
    constructor(_siteKey) {
      this._siteKey = _siteKey;
      this._throttleData = null;
    }
    /**
     * Returns an App Check token.
     * @internal
     */
    async getToken(isLimitedUse = false) {
      var _a, _b, _c;
      throwIfThrottled(this._throttleData);
      const attestedClaimsToken = await getToken$1(this._app).catch((_e) => {
        throw ERROR_FACTORY.create(
          "recaptcha-error"
          /* AppCheckError.RECAPTCHA_ERROR */
        );
      });
      if (!((_a = getStateReference(this._app).reCAPTCHAState) == null ? void 0 : _a.succeeded)) {
        throw ERROR_FACTORY.create(
          "recaptcha-error"
          /* AppCheckError.RECAPTCHA_ERROR */
        );
      }
      let result;
      try {
        const request = getExchangeRecaptchaEnterpriseTokenRequest(this._app, attestedClaimsToken);
        if (isLimitedUse) {
          request.body["limited_use"] = true;
        }
        result = await exchangeToken(request, this._heartbeatServiceProvider);
      } catch (e) {
        if ((_b = e.code) == null ? void 0 : _b.includes("fetch-status-error")) {
          this._throttleData = setBackoff(Number((_c = e.customData) == null ? void 0 : _c.httpStatus), this._throttleData);
          throw ERROR_FACTORY.create("initial-throttle", {
            time: getDurationString(this._throttleData.allowRequestsAfter - Date.now()),
            httpStatus: this._throttleData.httpStatus
          });
        } else {
          throw e;
        }
      }
      this._throttleData = null;
      return result;
    }
    /**
     * @internal
     */
    initialize(app2) {
      this._app = app2;
      this._heartbeatServiceProvider = _getProvider(app2, "heartbeat");
      initializeEnterprise(app2, this._siteKey).catch(() => {
      });
    }
    /**
     * @internal
     */
    isEqual(otherProvider) {
      if (otherProvider instanceof ReCaptchaEnterpriseProvider) {
        return this._siteKey === otherProvider._siteKey;
      } else {
        return false;
      }
    }
  }
  function setBackoff(httpStatus, throttleData) {
    if (httpStatus === 404 || httpStatus === 403) {
      return {
        backoffCount: 1,
        allowRequestsAfter: Date.now() + ONE_DAY,
        httpStatus
      };
    } else {
      const backoffCount = throttleData ? throttleData.backoffCount : 0;
      const backoffMillis = calculateBackoffMillis(backoffCount, 1e3, 2);
      return {
        backoffCount: backoffCount + 1,
        allowRequestsAfter: Date.now() + backoffMillis,
        httpStatus
      };
    }
  }
  function throwIfThrottled(throttleData) {
    if (throttleData) {
      if (Date.now() - throttleData.allowRequestsAfter <= 0) {
        throw ERROR_FACTORY.create("throttled", {
          time: getDurationString(throttleData.allowRequestsAfter - Date.now()),
          httpStatus: throttleData.httpStatus
        });
      }
    }
  }
  /**
   * @license
   * Copyright 2020 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  function initializeAppCheck(app2 = getApp(), options) {
    var _a;
    app2 = getModularInstance(app2);
    const provider = _getProvider(app2, "app-check");
    if (!getDebugState().initialized) {
      initializeDebugMode(app2);
    }
    if (isDebugMode()) {
      void getDebugToken().then((token) => {
        console.log(`Firebase App Check debug token: ${token}`);
      });
    }
    if (provider.isInitialized()) {
      const existingInstance = provider.getImmediate();
      const initialOptions = provider.getOptions();
      if (initialOptions && !!initialOptions.isTokenAutoRefreshEnabled === !!options.isTokenAutoRefreshEnabled && ((_a = initialOptions.provider) == null ? void 0 : _a.isEqual(options.provider))) {
        return existingInstance;
      } else {
        throw ERROR_FACTORY.create("already-initialized", {
          appName: app2.name
        });
      }
    }
    const appCheck = provider.initialize({ options });
    _activate(app2, options.provider, options.isTokenAutoRefreshEnabled);
    if (getStateReference(app2).isTokenAutoRefreshEnabled) {
      addTokenListener(appCheck, "INTERNAL", () => {
      });
    }
    return appCheck;
  }
  function _activate(app2, provider, isTokenAutoRefreshEnabled = false) {
    const state = setInitialState(app2, { ...DEFAULT_STATE });
    state.activated = true;
    state.provider = provider;
    state.cachedTokenPromise = readTokenFromStorage(app2).then((cachedToken) => {
      if (cachedToken && isValid(cachedToken)) {
        state.token = cachedToken;
        notifyTokenListeners(app2, { token: cachedToken.token });
      }
      return cachedToken;
    });
    state.isTokenAutoRefreshEnabled = isTokenAutoRefreshEnabled && app2.automaticDataCollectionEnabled;
    if (!app2.automaticDataCollectionEnabled && isTokenAutoRefreshEnabled) {
      logger.warn("`isTokenAutoRefreshEnabled` is true but `automaticDataCollectionEnabled` was set to false during `initializeApp()`. This blocks automatic token refresh.");
    }
    state.provider.initialize(app2);
  }
  /**
   * @license
   * Copyright 2021 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  const APP_CHECK_NAME = "app-check";
  const APP_CHECK_NAME_INTERNAL = "app-check-internal";
  function registerAppCheck() {
    _registerComponent(new Component(
      APP_CHECK_NAME,
      (container) => {
        const app2 = container.getProvider("app").getImmediate();
        const heartbeatServiceProvider = container.getProvider("heartbeat");
        return factory(app2, heartbeatServiceProvider);
      },
      "PUBLIC"
      /* ComponentType.PUBLIC */
    ).setInstantiationMode(
      "EXPLICIT"
      /* InstantiationMode.EXPLICIT */
    ).setInstanceCreatedCallback((container, _identifier, _appcheckService) => {
      container.getProvider(APP_CHECK_NAME_INTERNAL).initialize();
    }));
    _registerComponent(new Component(
      APP_CHECK_NAME_INTERNAL,
      (container) => {
        const appCheck = container.getProvider("app-check").getImmediate();
        return internalFactory(appCheck);
      },
      "PUBLIC"
      /* ComponentType.PUBLIC */
    ).setInstantiationMode(
      "EXPLICIT"
      /* InstantiationMode.EXPLICIT */
    ));
    registerVersion(name$2, version);
  }
  registerAppCheck();
  const FIREBASE_CONFIG = JSON.parse(
    '{"apiKey":"AIzaSyCe3pFg0ZaEfneTYw3ZwqNzNutDqmkzqhY","authDomain":"gen-lang-client-0936734513.firebaseapp.com","projectId":"gen-lang-client-0936734513","storageBucket":"gen-lang-client-0936734513.firebasestorage.app","messagingSenderId":"1035973413407","appId":"1:1035973413407:web:ddc7621b4170a69977e32a"}'
  );
  const SECRETS = JSON.parse(
    '{"appCheckDebugToken":"PASTE_YOUR_APP_CHECK_DEBUG_TOKEN_HERE","recaptchaEnterpriseSiteKey":"PASTE_YOUR_RECAPTCHA_ENTERPRISE_SITE_KEY_HERE"}'
  );
  const APP_CHECK_DEBUG_TOKEN = SECRETS.appCheckDebugToken;
  const RECAPTCHA_ENTERPRISE_SITE_KEY = SECRETS.recaptchaEnterpriseSiteKey;
  function isFirebaseConfigured() {
    return FIREBASE_CONFIG.apiKey !== "PASTE_YOUR_API_KEY_HERE" && FIREBASE_CONFIG.projectId !== "PASTE_YOUR_PROJECT_ID" && FIREBASE_CONFIG.appId !== "PASTE_YOUR_APP_ID";
  }
  let app = null;
  let appCheckReady = false;
  function getFirebaseApp() {
    if (app) return app;
    if (!isFirebaseConfigured()) {
      throw new Error(
        'Firebase is not configured: paste your project keys into src/config/firebase.ts (see README.md "Firebase setup").'
      );
    }
    app = initializeApp({ ...FIREBASE_CONFIG });
    initAppCheck(app);
    return app;
  }
  function initAppCheck(firebaseApp) {
    if (appCheckReady) return;
    try {
      const g = globalThis;
      if (APP_CHECK_DEBUG_TOKEN !== "PASTE_YOUR_APP_CHECK_DEBUG_TOKEN_HERE") {
        g.FIREBASE_APPCHECK_DEBUG_TOKEN = APP_CHECK_DEBUG_TOKEN;
      }
      if (RECAPTCHA_ENTERPRISE_SITE_KEY !== "PASTE_YOUR_RECAPTCHA_ENTERPRISE_SITE_KEY_HERE") {
        initializeAppCheck(firebaseApp, {
          provider: new ReCaptchaEnterpriseProvider(RECAPTCHA_ENTERPRISE_SITE_KEY),
          isTokenAutoRefreshEnabled: true
        });
        appCheckReady = true;
      }
    } catch (err) {
      console.warn("[MOBIUS] App Check init failed (continuing without it):", err);
    }
  }
  class CloudAI {
    static async generate(prompt) {
      try {
        const app2 = getFirebaseApp();
        const ai = getAI(app2, { backend: new GoogleAIBackend() });
        const model = getGenerativeModel(ai, { model: "gemini-3.8-flash" });
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        if (!text || !text.trim()) return { ok: false, error: "Cloud Gemini returned an empty response." };
        return { ok: true, text: text.trim() };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  }
  async function loadLocalServerConfig() {
    const data = await chrome.storage.local.get(STORAGE_KEYS.settings);
    const stored = data[STORAGE_KEYS.settings];
    return {
      baseUrl: ((stored == null ? void 0 : stored.localServerBaseUrl) ?? DEFAULT_LOCAL_SERVER_BASE_URL).replace(/\/+$/, ""),
      model: (stored == null ? void 0 : stored.localServerModel) ?? DEFAULT_LOCAL_SERVER_MODEL,
      timeoutMs: DEFAULT_LOCAL_SERVER_TIMEOUT_MS
    };
  }
  class LocalServerAI {
    static async generate(prompt, config) {
      const cfg = config ?? await loadLocalServerConfig();
      const url = `${cfg.baseUrl}/api/generate`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
      try {
        let res;
        try {
          res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: cfg.model, prompt, stream: false }),
            signal: controller.signal
          });
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") {
            return {
              ok: false,
              error: `Local server timed out after ${cfg.timeoutMs / 1e3}s at ${cfg.baseUrl} (model "${cfg.model}"). The server may be busy or the model too slow — try a smaller model.`
            };
          }
          return {
            ok: false,
            error: `Local server unreachable at ${cfg.baseUrl} — is Ollama running? Start it with \`ollama serve\`, pull the model with \`ollama pull ${cfg.model}\`, and check the base URL in Settings. (No request reached any AI; nothing was sent to the cloud.)`
          };
        }
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          return {
            ok: false,
            error: `Local server at ${cfg.baseUrl} returned HTTP ${res.status}` + (body ? `: ${body.slice(0, 200)}` : ".") + ` Check the model name ("${cfg.model}" — is it pulled? run \`ollama list\`) and the base URL in Settings.`
          };
        }
        const data = await res.json();
        const text = typeof data.response === "string" ? data.response.trim() : "";
        if (!text) return { ok: false, error: `Local server at ${cfg.baseUrl} returned an empty response for model "${cfg.model}".` };
        return { ok: true, text };
      } finally {
        clearTimeout(timer);
      }
    }
  }
  async function tryPromptApi(prompt) {
    try {
      const g = globalThis;
      if (!g.LanguageModel) return null;
      const session = await g.LanguageModel.create({ initialPrompts: [{ role: "system", content: "You are MOBIUS, a concise on-device assistant." }] });
      return await session.prompt(prompt);
    } catch {
      return null;
    }
  }
  class OnDeviceAI {
    /** Returns true when Nano can plausibly run (Firebase on-device model or Prompt API). */
    static async isAvailable() {
      if (isFirebaseConfigured()) return true;
      const g = globalThis;
      return Boolean(g.LanguageModel);
    }
    static async generate(prompt) {
      if (isFirebaseConfigured()) {
        try {
          const app2 = getFirebaseApp();
          const ai = getAI(app2, { backend: new GoogleAIBackend() });
          const model = getGenerativeModel(ai, { mode: InferenceMode.ONLY_ON_DEVICE });
          const result = await model.generateContent(prompt);
          const text = result.response.text();
          if (text && text.trim()) return { ok: true, text: text.trim(), source: "firebase-nano" };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const fallback = await tryPromptApi(prompt);
          if (fallback) return { ok: true, text: fallback.trim(), source: "prompt-api" };
          return { ok: false, error: `Gemini Nano (Firebase AI Logic) unavailable: ${message}` };
        }
      }
      const viaPromptApi = await tryPromptApi(prompt);
      if (viaPromptApi) return { ok: true, text: viaPromptApi.trim(), source: "prompt-api" };
      return {
        ok: false,
        error: isFirebaseConfigured() ? "Gemini Nano is not available in this Chrome (enable chrome://flags/#prompt-api-for-gemini-nano and use Chrome 138+)." : "Firebase is not configured (paste keys in src/config/firebase.ts) and no built-in Prompt API was found."
      };
    }
  }
  class AIRouter {
    constructor(permissions) {
      __publicField(this, "permissions");
      this.permissions = permissions;
    }
    /** Read the persisted engine choice; unknown/missing values fall back to "auto". */
    async getEngineChoice() {
      const data = await chrome.storage.local.get(STORAGE_KEYS.settings);
      const stored = data[STORAGE_KEYS.settings];
      const choice = stored == null ? void 0 : stored.engine;
      return choice === "auto" || choice === "nano" || choice === "cloud" || choice === "local" ? choice : DEFAULT_ENGINE;
    }
    async generate(taskId, prompt, opts) {
      const cloudAllowed = await this.permissions.isAllowed("cloudAI");
      const engineChoice = await this.getEngineChoice();
      const started = Date.now();
      const summary = prompt.slice(0, 80).replace(/\s+/g, " ");
      const payload = (detail) => `prompt ${prompt.length} chars, ${detail}`;
      if (engineChoice === "nano") {
        const nano = await OnDeviceAI.generate(prompt);
        if (nano.ok) {
          await this.log({ taskId, taskSummary: summary, engine: "on-device", reason: 'Engine "nano": Gemini Nano on-device (explicit choice).', latencyMs: Date.now() - started, cloudAllowed, payloadSummary: payload("on-device, explicit") });
          return { ok: true, text: nano.text, engine: "on-device" };
        }
        return this.failWithFallback(taskId, summary, prompt, started, cloudAllowed, `Engine "nano" failed: ${nano.error}`, payload("nano failed, no other engine tried"));
      }
      if (engineChoice === "cloud") {
        if (!cloudAllowed) {
          await this.log({ taskId, taskSummary: summary, engine: "local-fallback", reason: 'Engine "cloud" chosen but "Allow Cloud AI" is OFF — cloud NOT called.', latencyMs: Date.now() - started, cloudAllowed, payloadSummary: payload("cloud not allowed") });
          const fallback2 = this.extractiveFallback(prompt);
          if (fallback2) return { ok: true, text: fallback2, engine: "local-fallback" };
          return { ok: false, error: 'Engine "cloud" is selected but "Allow Cloud AI" is OFF, so MOBIUS did not call the cloud. Enable "Allow Cloud AI" in Settings or switch the engine back to "auto".', engine: "none" };
        }
        const cloud2 = await CloudAI.generate(prompt);
        if (cloud2.ok) {
          await this.log({ taskId, taskSummary: summary, engine: "cloud", reason: 'Engine "cloud": cloud Gemini (explicit choice).', latencyMs: Date.now() - started, cloudAllowed, payloadSummary: payload("cloud Gemini, explicit") });
          return { ok: true, text: cloud2.text, engine: "cloud" };
        }
        return this.failWithFallback(taskId, summary, prompt, started, cloudAllowed, `Engine "cloud" failed: ${cloud2.error}`, payload("cloud failed, no other engine tried"));
      }
      if (engineChoice === "local") {
        const cfg = await loadLocalServerConfig();
        const local = await LocalServerAI.generate(prompt, cfg);
        if (local.ok) {
          await this.log({ taskId, taskSummary: summary, engine: "local-server", reason: `Engine "local": local server at ${cfg.baseUrl} (model "${cfg.model}", explicit choice).`, latencyMs: Date.now() - started, cloudAllowed, payloadSummary: payload(`local server ${cfg.baseUrl} model ${cfg.model}`) });
          return { ok: true, text: local.text, engine: "local-server" };
        }
        return this.failWithFallback(taskId, summary, prompt, started, cloudAllowed, `Engine "local" failed: ${local.error}`, payload(`local server ${cfg.baseUrl} failed, no other engine tried`));
      }
      const onDevice = await OnDeviceAI.generate(prompt);
      if (onDevice.ok) {
        await this.log({ taskId, taskSummary: summary, engine: "on-device", reason: "Default intelligence (P3): Gemini Nano on-device.", latencyMs: Date.now() - started, cloudAllowed, payloadSummary: payload("on-device") });
        return { ok: true, text: onDevice.text, engine: "on-device" };
      }
      const nanoError = onDevice.error;
      if (!cloudAllowed) {
        await this.log({ taskId, taskSummary: summary, engine: "local-fallback", reason: `Nano unavailable (${nanoError}); cloud NOT called — "Allow Cloud AI" is OFF.`, latencyMs: Date.now() - started, cloudAllowed, payloadSummary: payload("no cloud call") });
        const fallback2 = this.extractiveFallback(prompt);
        if (fallback2) return { ok: true, text: fallback2, engine: "local-fallback" };
        return {
          ok: false,
          error: `${nanoError} Cloud AI is OFF, so MOBIUS did not call the cloud. Enable "Allow Cloud AI" in Settings to let MOBIUS escalate, or enable Gemini Nano at chrome://flags/#prompt-api-for-gemini-nano.`,
          engine: "none"
        };
      }
      const cloud = await CloudAI.generate(prompt);
      if (cloud.ok) {
        await this.log({ taskId, taskSummary: summary, engine: "cloud", reason: `Escalated: Nano unavailable (${nanoError}) and cloud is allowed.`, latencyMs: Date.now() - started, cloudAllowed, payloadSummary: payload("-> cloud Gemini") });
        return { ok: true, text: cloud.text, engine: "cloud" };
      }
      await this.log({ taskId, taskSummary: summary, engine: "local-fallback", reason: `Both engines failed — Nano: ${nanoError}; Cloud: ${cloud.error}.`, latencyMs: Date.now() - started, cloudAllowed, payloadSummary: payload("both engines failed") });
      const fallback = this.extractiveFallback(prompt);
      if (fallback) return { ok: true, text: fallback, engine: "local-fallback" };
      return { ok: false, error: `On-device failed (${nanoError}); cloud failed (${cloud.error}).`, engine: "none" };
    }
    /**
     * Log an explicit-engine failure, then try ONLY the local extractive
     * summary — never another AI engine. Returns the fallback result, or an
     * honest error when even the extractive summary has nothing to work with.
     */
    async failWithFallback(taskId, taskSummary, prompt, started, cloudAllowed, reason, payloadSummary) {
      await this.log({ taskId, taskSummary, engine: "local-fallback", reason: `${reason} — no other engine tried (explicit engine choice).`, latencyMs: Date.now() - started, cloudAllowed, payloadSummary });
      const fallback = this.extractiveFallback(prompt);
      if (fallback) return { ok: true, text: fallback, engine: "local-fallback" };
      return { ok: false, error: `${reason} No local extractive summary was possible either.`, engine: "none" };
    }
    /** Local, offline, deterministic extractive summary of the page content embedded in the prompt. */
    extractiveFallback(prompt) {
      var _a;
      const match = prompt.match(/Content:\n?"""([\s\S]*?)"""/) ?? prompt.match(/Last message: """([\s\S]*?)"""/);
      const text = (_a = match == null ? void 0 : match[1]) == null ? void 0 : _a.trim();
      if (!text) return null;
      const sentences = text.split(new RegExp("(?<=[.!?])\\s+")).filter((s) => s.trim().length > 20);
      const picked = sentences.slice(0, 5);
      if (picked.length === 0) return null;
      return `[Local extractive summary — no AI available]
- ${picked.join("\n- ")}`;
    }
    async log(entry) {
      const full = { ...entry, id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, timestamp: Date.now() };
      const data = await chrome.storage.local.get(STORAGE_KEYS.routerLog);
      const logs = Array.isArray(data[STORAGE_KEYS.routerLog]) ? data[STORAGE_KEYS.routerLog] : [];
      logs.unshift(full);
      await chrome.storage.local.set({ [STORAGE_KEYS.routerLog]: logs.slice(0, 200) });
    }
    async getLog() {
      const data = await chrome.storage.local.get(STORAGE_KEYS.routerLog);
      return Array.isArray(data[STORAGE_KEYS.routerLog]) ? data[STORAGE_KEYS.routerLog] : [];
    }
    async clearLog() {
      await chrome.storage.local.set({ [STORAGE_KEYS.routerLog]: [] });
    }
  }
  class ChatHistory {
    async add(role, text, retentionSeconds) {
      const now = Date.now();
      const msg = {
        id: `chat_${now}_${Math.random().toString(36).slice(2, 8)}`,
        role,
        text,
        createdAt: now,
        expiresAt: now + Math.max(60, retentionSeconds) * 1e3
      };
      const all = await this.readRaw();
      all.push(msg);
      await chrome.storage.local.set({ [STORAGE_KEYS.chatHistory]: all.slice(-200) });
      return msg;
    }
    async list(now = Date.now()) {
      const all = await this.readRaw();
      const kept = all.filter((m) => m.expiresAt > now).sort((a, b) => a.createdAt - b.createdAt);
      if (kept.length !== all.length) {
        await chrome.storage.local.set({ [STORAGE_KEYS.chatHistory]: kept });
      }
      return kept;
    }
    async clear() {
      await chrome.storage.local.set({ [STORAGE_KEYS.chatHistory]: [] });
    }
    /** Delete expired messages. Returns the number purged. */
    async purgeExpired(now = Date.now()) {
      const all = await this.readRaw();
      const kept = all.filter((m) => m.expiresAt > now);
      const purged = all.length - kept.length;
      if (purged > 0) await chrome.storage.local.set({ [STORAGE_KEYS.chatHistory]: kept });
      return purged;
    }
    async readRaw() {
      const data = await chrome.storage.local.get(STORAGE_KEYS.chatHistory);
      const list = data[STORAGE_KEYS.chatHistory];
      return Array.isArray(list) ? list : [];
    }
  }
  class ContextManager {
    /** Assemble context for a task. pageText is supplied by the caller (content script). */
    async build(tabId, pageText, recentTaskSummaries) {
      let tab;
      try {
        if (typeof tabId === "number") {
          tab = await chrome.tabs.get(tabId);
        } else {
          const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
          tab = active;
        }
      } catch {
        tab = void 0;
      }
      const url = (tab == null ? void 0 : tab.url) ?? "";
      let domain = "";
      try {
        domain = url ? new URL(url).hostname : "";
      } catch {
        domain = "";
      }
      const cleanText = pageText ? pageText.replace(/\s+/g, " ").trim().slice(0, MAX_ONDEVICE_CHARS) : void 0;
      return {
        tabId: tab == null ? void 0 : tab.id,
        url: url || void 0,
        title: tab == null ? void 0 : tab.title,
        domain: domain || void 0,
        pageText: cleanText,
        timeIso: (/* @__PURE__ */ new Date()).toISOString(),
        recentTaskSummaries: recentTaskSummaries.slice(0, 5)
      };
    }
  }
  const DEFAULT_LANGUAGE = "id";
  const ID = {
    navOnboarding: "Onboarding",
    navRouterLog: "Log Router",
    navSettings: "Pengaturan",
    navHistory: "Riwayat",
    navChat: "Chat",
    onbWelcome: "Selamat datang di MOBIUS",
    onbIntro: "MOBIUS berjalan lokal di browser Anda. AI on-device (Gemini Nano) adalah default. Tidak ada data yang keluar dari perangkat Anda kecuali Anda mengizinkan Cloud AI di bawah.",
    onbHowItWorks: "Cara kerja",
    onbSteps: '1. Klik bubble mengambang di halaman mana pun.\n2. Tanyakan ke MOBIUS — mis. "Ringkas halaman ini" atau, di WhatsApp Web, "Balas pesan terakhir".\n3. MOBIUS membuat draf on-device, menyisipkan draf (bila aksi DOM aktif), dan mencatat setiap keputusan routing AI di tab Log Router.',
    gateBubble: "Bubble Mengambang",
    gateReadPage: "Baca Halaman / Konteks DOM",
    gateDomActions: "Aksi DOM Antar-Aplikasi",
    gateMemory: "Riwayat Konteks / Memori (lokal, TTL)",
    gateCloudAI: "Izinkan Cloud AI (Kecerdasan Pinjaman)",
    explainBubble: "Tampilkan bubble MOBIUS mengambang di halaman web.",
    explainReadPage: "Baca teks tab aktif (chat WhatsApp Web, artikel) supaya MOBIUS bisa memakai konteks halaman.",
    explainDomActions: "Ketik / sisipkan balasan ke input web (mis. kotak pesan WhatsApp Web).",
    explainMemory: "Simpan hasil tugas secara lokal di perangkat ini, dengan batas waktu (TTL).",
    explainCloudAI: "Izinkan Cloud AI (kecerdasan pinjaman). Saat OFF, MOBIUS tidak pernah memanggil cloud, bahkan bila AI on-device tidak tersedia.",
    denialNeeds: 'Ini butuh "{detail}" — saat ini OFF. Aktifkan di Side Panel MOBIUS (Onboarding / Pengaturan) untuk memakai fitur ini.',
    settingsTitle: "Pengaturan",
    setCloudAI: "Izinkan Cloud AI (Kecerdasan Pinjaman)",
    setCloudAIDesc: "Saat OFF (default), MOBIUS tidak pernah memanggil cloud — bahkan bila AI on-device tidak tersedia. Setiap panggilan cloud dicatat di Log Router.",
    setBubble: "Bubble Mengambang",
    setBubbleDesc: "Tampilkan bubble MOBIUS di halaman web.",
    setMemory: "Memori (lokal, TTL)",
    setMemoryDesc: "Simpan hasil tugas hanya di perangkat ini.",
    setEngine: "Mesin AI",
    setEngineDesc: 'Kecerdasan mana yang menjawab. Default "Otomatis" = Nano on-device dulu, cloud hanya bila diizinkan. Mesin yang dipilih eksplisit tidak pernah diam-diam pindah ke mesin lain — bila gagal, MOBIUS mencatatnya dan hanya fallback ke ringkasan ekstraktif lokal.',
    setEngineLabel: "Mesin",
    engineAuto: "Otomatis (Nano dulu, cloud bila diizinkan)",
    engineNano: "Nano on-device saja",
    engineCloud: 'Cloud Gemini saja (butuh "Izinkan Cloud AI")',
    engineLocal: "Server lokal saja (mis. Ollama di laptop ini)",
    setLocalBaseUrl: "URL dasar server lokal",
    setLocalModel: "Model server lokal",
    setLocalNote: 'Tidak ada model yang jalan di dalam browser — "server lokal" adalah program di laptop Anda (mis. Ollama: ollama serve, lalu ollama pull llama3.1). Extension hanya memanggilnya lewat HTTP. Bila server mati, MOBIUS mengatakannya, bukan pura-pura berhasil.',
    setSaveEngine: "Simpan pengaturan mesin",
    setSaved: "Tersimpan.",
    setTtl: "Batas waktu (TTL)",
    setTtlDesc: "Entri memori kedaluwarsa setelah sekian hari; data subagent sementara setelah sekian menit.",
    setMemoryTtl: "TTL Memori (hari)",
    setTempTtl: "TTL data sementara (menit)",
    setSaveTtl: "Simpan TTL",
    setFirebaseStatus: "Status Firebase AI Logic",
    setFirebaseOk: "Kunci Firebase sudah dikonfigurasi di src/config/firebase.ts. Gemini Nano on-device dan Gemini cloud tersedia lewat Firebase AI Logic SDK.",
    setFirebaseMissing: 'Kunci Firebase BELUM dikonfigurasi — tempel di src/config/firebase.ts (lihat README "Firebase setup"). Sampai saat itu, MOBIUS berjalan dengan Prompt API bawaan / fallback ekstraktif lokal dan tetap bekerja dengan baik.',
    setLanguage: "Bahasa",
    setLanguageDesc: "Berlaku untuk side panel dan bubble.",
    langIndonesian: "Bahasa Indonesia",
    langEnglish: "English",
    setChatHistory: "Riwayat chat",
    setChatHistoryDesc: "Berapa lama pesan chat disimpan.",
    retention1h: "1 jam",
    retention24h: "24 jam",
    retention7d: "7 hari",
    setSave: "Simpan",
    histTitle: "Riwayat & Memori",
    histDesc: "Hasil tugas yang diputuskan Core untuk disimpan — hanya lokal, dengan batas waktu. Tidak ada memori yang pernah dikirim ke cloud.",
    histEmpty: "Belum ada memori tersimpan.",
    histDelete: "Hapus",
    histClearAll: "Hapus semua memori",
    histSource: "sumber",
    histExpires: "kedaluwarsa",
    logTitle: "Log Router AI",
    logDesc: "Setiap keputusan routing yang dibuat MOBIUS — on-device dulu, cloud hanya bila diizinkan dan dibutuhkan. Diperbarui tiap 3 detik.",
    logEmpty: "Belum ada keputusan. Tanyakan sesuatu ke MOBIUS dari bubble.",
    logClear: "Hapus log",
    logCloudAllowed: "cloud diizinkan",
    logYes: "ya",
    logNo: "tidak",
    chatTitle: "Riwayat Chat",
    chatDesc: "Pesan yang Anda kirim dari bubble, disimpan di perangkat ini selama masa retensi di Pengaturan.",
    chatEmpty: "Belum ada pesan chat.",
    chatClear: "Hapus riwayat chat",
    chatYou: "Anda",
    bubbleDesc: "Tanyakan soal halaman ini, atau balas pesan WhatsApp terakhir. Diproses on-device secara default.",
    bubblePlaceholder: "cth. Ringkas halaman ini / Balas pesan terakhir",
    bubbleAsk: "Tanya MOBIUS",
    bubblePanel: "Panel Samping",
    bubbleThinking: "Berpikir on-device…",
    bubbleNoResponse: "Tidak ada respons dari inti MOBIUS. Muat ulang halaman dan coba lagi.",
    bubbleTaskFailed: "Tugas gagal.",
    bubbleUnreachable: "Tidak bisa menghubungi inti MOBIUS: ",
    bubbleSensitiveTitle: "Data sensitif ditemukan di pesan Anda: {types}. Belum ada yang dikirim.",
    bubbleSensitiveContinue: "Tetap lanjut",
    bubbleSensitiveCancel: "Batal",
    bubbleHistoryLabel: "Sebelumnya di chat ini",
    skillMatched: 'Skill "{skill}" cocok lewat kata kunci (skor {score}) — dijalankan secara deterministik, lokal.',
    skillDone: "Selesai: {skill}.",
    skillFailed: "Skill gagal: {message}",
    skillNoQuery: 'Sebutkan produknya — mis. "cari harga sepatu di Shopee".',
    skillNeedsReadPage: "Skill ini membaca halaman, jadi butuh izin baca halaman.",
    typeKtp: "nomor KTP",
    typePhone: "nomor HP",
    typeAccount: "nomor rekening",
    typeEmail: "email",
    typePassword: "kata sandi"
  };
  const EN = {
    navOnboarding: "Onboarding",
    navRouterLog: "Router Log",
    navSettings: "Settings",
    navHistory: "History",
    navChat: "Chat",
    onbWelcome: "Welcome to MOBIUS",
    onbIntro: "MOBIUS runs locally in your browser. On-device AI (Gemini Nano) is the default. Nothing leaves your device unless you explicitly allow Cloud AI below.",
    onbHowItWorks: "How it works",
    onbSteps: '1. Click the floating bubble on any page.\n2. Ask MOBIUS — e.g. "Summarize this page" or, on WhatsApp Web, "Reply to the last message".\n3. MOBIUS drafts on-device, inserts the draft (if DOM actions are on), and logs every AI routing decision in the Router Log tab.',
    gateBubble: "Floating Bubble Overlay",
    gateReadPage: "Read Page / DOM Context",
    gateDomActions: "Cross-App DOM Actions",
    gateMemory: "Context History / Memory (local, TTL)",
    gateCloudAI: "Allow Cloud AI (Borrowed Intelligence)",
    explainBubble: "Show the floating MOBIUS bubble on webpages.",
    explainReadPage: "Read the active tab text (WhatsApp Web chats, articles) so MOBIUS can use page context.",
    explainDomActions: "Type / insert replies into web inputs (e.g. the WhatsApp Web message box).",
    explainMemory: "Store task outcomes locally on this device, with a time limit (TTL).",
    explainCloudAI: "Allow Cloud AI (borrowed intelligence). When OFF, MOBIUS never calls the cloud, even if on-device AI is unavailable.",
    denialNeeds: 'This needs "{detail}" — it is currently OFF. Enable it in the MOBIUS Side Panel (Onboarding / Settings) to use this feature.',
    settingsTitle: "Settings",
    setCloudAI: "Allow Cloud AI (Borrowed Intelligence)",
    setCloudAIDesc: "When OFF (default), MOBIUS never calls the cloud — even if on-device AI is unavailable. Every cloud call is logged in the Router Log.",
    setBubble: "Floating Bubble",
    setBubbleDesc: "Show the MOBIUS bubble on webpages.",
    setMemory: "Memory (local, TTL)",
    setMemoryDesc: "Store task outcomes on this device only.",
    setEngine: "AI Engine",
    setEngineDesc: 'Which intelligence answers. Default "Auto" = Nano on-device first, cloud only if allowed. An explicit engine never silently switches to another one — if it fails, MOBIUS logs it and falls back only to the local extractive summary.',
    setEngineLabel: "Engine",
    engineAuto: "Auto (Nano first, cloud if allowed)",
    engineNano: "Nano on-device only",
    engineCloud: 'Cloud Gemini only (needs "Allow Cloud AI")',
    engineLocal: "Local server only (e.g. Ollama on this laptop)",
    setLocalBaseUrl: "Local server base URL",
    setLocalModel: "Local server model",
    setLocalNote: 'No model runs inside the browser — the "local server" is a program on your laptop (e.g. Ollama: ollama serve, then ollama pull llama3.1). The extension only calls it over HTTP. If the server is down, MOBIUS says so instead of pretending success.',
    setSaveEngine: "Save engine settings",
    setSaved: "Saved.",
    setTtl: "Time limits (TTL)",
    setTtlDesc: "Memory entries expire after this many days; temporary subagent data after this many minutes.",
    setMemoryTtl: "Memory TTL (days)",
    setTempTtl: "Temporary data TTL (minutes)",
    setSaveTtl: "Save TTL",
    setFirebaseStatus: "Firebase AI Logic status",
    setFirebaseOk: "Firebase keys are configured in src/config/firebase.ts. On-device Gemini Nano and cloud Gemini are available through the Firebase AI Logic SDK.",
    setFirebaseMissing: 'Firebase keys are NOT configured yet — paste them into src/config/firebase.ts (see README "Firebase setup"). Until then, MOBIUS runs on the built-in Prompt API / local extractive fallback and degrades gracefully.',
    setLanguage: "Language",
    setLanguageDesc: "Applies to the side panel and the bubble.",
    langIndonesian: "Bahasa Indonesia",
    langEnglish: "English",
    setChatHistory: "Chat history",
    setChatHistoryDesc: "How long chat messages are kept.",
    retention1h: "1 hour",
    retention24h: "24 hours",
    retention7d: "7 days",
    setSave: "Save",
    histTitle: "History & Memory",
    histDesc: "Task outcomes the Core decided to keep — stored locally only, with a time limit. No memory is ever sent to the cloud.",
    histEmpty: "No memory stored yet.",
    histDelete: "Delete",
    histClearAll: "Clear all memory",
    histSource: "source",
    histExpires: "expires",
    logTitle: "AI Router Log",
    logDesc: "Every routing decision MOBIUS makes — on-device first, cloud only when allowed and needed. Refreshes every 3 seconds.",
    logEmpty: "No decisions yet. Ask MOBIUS something from the bubble.",
    logClear: "Clear log",
    logCloudAllowed: "cloud allowed",
    logYes: "yes",
    logNo: "no",
    chatTitle: "Chat History",
    chatDesc: "Messages you sent from the bubble, kept on this device for the retention period in Settings.",
    chatEmpty: "No chat messages yet.",
    chatClear: "Clear chat history",
    chatYou: "You",
    bubbleDesc: "Ask about this page, or reply to the last WhatsApp message. Processed on-device by default.",
    bubblePlaceholder: "e.g. Summarize this page / Reply to the last message",
    bubbleAsk: "Ask MOBIUS",
    bubblePanel: "Side Panel",
    bubbleThinking: "Thinking on-device…",
    bubbleNoResponse: "No response from the MOBIUS core. Reload the page and try again.",
    bubbleTaskFailed: "Task failed.",
    bubbleUnreachable: "Could not reach the MOBIUS core: ",
    bubbleSensitiveTitle: "Sensitive data found in your message: {types}. Nothing was sent yet.",
    bubbleSensitiveContinue: "Continue anyway",
    bubbleSensitiveCancel: "Cancel",
    bubbleHistoryLabel: "Earlier in this chat",
    skillMatched: 'Skill "{skill}" matched by keyword (score {score}) — running deterministically, locally.',
    skillDone: "Done: {skill}.",
    skillFailed: "Skill failed: {message}",
    skillNoQuery: 'Name the product — e.g. "cari harga sepatu di Shopee".',
    skillNeedsReadPage: "This skill reads the page, so it needs the read-page permission.",
    typeKtp: "ID card number",
    typePhone: "phone number",
    typeAccount: "bank account number",
    typeEmail: "email",
    typePassword: "password"
  };
  const STRINGS = { id: ID, en: EN };
  let cachedLang = DEFAULT_LANGUAGE;
  async function loadLanguage() {
    try {
      const data = await chrome.storage.local.get(STORAGE_KEYS.settings);
      const stored = data[STORAGE_KEYS.settings];
      const lang = stored == null ? void 0 : stored.language;
      cachedLang = lang === "en" || lang === "id" ? lang : DEFAULT_LANGUAGE;
    } catch {
      cachedLang = DEFAULT_LANGUAGE;
    }
    return cachedLang;
  }
  function t(key, lang = cachedLang) {
    var _a;
    return ((_a = STRINGS[lang]) == null ? void 0 : _a[key]) ?? STRINGS.en[key] ?? key;
  }
  function tf(key, vars, lang = cachedLang) {
    let out = t(key, lang);
    for (const [k, v] of Object.entries(vars)) out = out.replace(`{${k}}`, String(v));
    return out;
  }
  class MemoryStore {
    async readAll() {
      const data = await chrome.storage.local.get(STORAGE_KEYS.memory);
      const entries = data[STORAGE_KEYS.memory];
      return Array.isArray(entries) ? entries : [];
    }
    async writeAll(entries) {
      await chrome.storage.local.set({ [STORAGE_KEYS.memory]: entries });
    }
    /** Core-only write. Called by Orchestrator after a SubAgent reports. */
    async add(entry) {
      const now = Date.now();
      const full = {
        ...entry,
        id: `mem_${now}_${Math.random().toString(36).slice(2, 8)}`,
        createdAt: now,
        expiresAt: now + entry.ttlSeconds * 1e3
      };
      const entries = await this.readAll();
      entries.push(full);
      await this.writeAll(entries);
      return full;
    }
    async list() {
      const entries = await this.readAll();
      return entries.sort((a, b) => b.createdAt - a.createdAt);
    }
    async remove(id2) {
      const entries = (await this.readAll()).filter((e) => e.id !== id2);
      await this.writeAll(entries);
    }
    async clear() {
      await this.writeAll([]);
    }
    /** Delete expired entries. Returns the number purged. */
    async purgeExpired(now = Date.now()) {
      const entries = await this.readAll();
      const kept = entries.filter((e) => e.expiresAt > now);
      const purged = entries.length - kept.length;
      if (purged > 0) await this.writeAll(kept);
      return purged;
    }
  }
  const DEFAULT_PERMISSIONS = {
    bubble: true,
    // default ON (entry point)
    readPage: false,
    // opt-in
    domActions: false,
    // opt-in
    memory: true,
    // opt-in, default ON (local only)
    cloudAI: false
    // default OFF — P4: cloud is borrowed intelligence
  };
  const EXPLANATIONS = {
    bubble: "explainBubble",
    readPage: "explainReadPage",
    domActions: "explainDomActions",
    memory: "explainMemory",
    cloudAI: "explainCloudAI"
  };
  class PermissionManager {
    constructor() {
      __publicField(this, "cache", null);
    }
    async getAll() {
      if (this.cache) return this.cache;
      const data = await chrome.storage.local.get(STORAGE_KEYS.permissions);
      const stored = data[STORAGE_KEYS.permissions];
      this.cache = { ...DEFAULT_PERMISSIONS, ...stored ?? {} };
      return this.cache;
    }
    async isAllowed(key) {
      const gates = await this.getAll();
      return gates[key];
    }
    async set(key, value) {
      const gates = await this.getAll();
      gates[key] = value;
      this.cache = gates;
      await chrome.storage.local.set({ [STORAGE_KEYS.permissions]: gates });
      return gates;
    }
    explain(key) {
      return t(EXPLANATIONS[key]);
    }
    /** Human-readable denial message for a capability the user has not opted into. */
    denialMessage(key) {
      return tf("denialNeeds", { detail: this.explain(key) });
    }
  }
  function okResult(message, data) {
    return { success: true, message, data };
  }
  function failResult(message) {
    return { success: false, message };
  }
  const REF = /\$([A-Za-z0-9_.]+)/g;
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  class SkillRunner {
    async run(skill, params2, tool, onStatus = () => void 0) {
      if (skill.steps.length > skill.maxSteps) {
        return {
          success: false,
          partial: false,
          message: `Skill '${skill.id}' has ${skill.steps.length} steps but maxSteps is ${skill.maxSteps}.`,
          steps: [],
          vars: { ...params2 }
        };
      }
      const vars = {};
      for (const p of skill.params) {
        if (params2[p.name] !== void 0) vars[p.name] = params2[p.name];
        else if (p.default) vars[p.name] = p.default;
      }
      const deadline = Date.now() + skill.timeoutMs;
      const results = [];
      let last = null;
      let failed = false;
      let partial = false;
      let failMessage = "";
      for (let index = 0; index < skill.steps.length; index++) {
        const step = skill.steps[index];
        if (Date.now() > deadline) {
          failed = true;
          failMessage = `Skill timed out after ${skill.timeoutMs}ms at step ${index + 1}.`;
          results.push({ index, tool: step.tool, success: false, message: failMessage, durationMs: 0 });
          break;
        }
        if (step.when && !evalWhen(step.when, vars, last)) {
          results.push({ index, tool: step.tool, success: true, message: "skipped (when false)", durationMs: 0 });
          continue;
        }
        onStatus(`Step ${index + 1}/${skill.steps.length}: ${step.tool}...`);
        let resolved = null;
        let resolveError = null;
        try {
          const r = {};
          for (const [k, v] of Object.entries(step.args)) r[k] = resolveRefs(v, vars);
          resolved = r;
        } catch (e) {
          resolveError = e instanceof Error ? e.message : String(e);
        }
        const started = Date.now();
        let result;
        if (resolved === null) {
          result = failResult(resolveError ?? "missing parameter");
        } else if (step.risk === "irreversible") {
          result = failResult("Step is marked irreversible, but the extension has no approval UI — refused.");
        } else {
          let attempt = 0;
          for (; ; ) {
            try {
              result = await tool.call(step.tool, resolved);
            } catch (e) {
              result = failResult(e instanceof Error ? e.message : String(e));
            }
            if (result.success || attempt >= step.maxRetries) break;
            attempt++;
            await sleep(300);
          }
        }
        const duration = Date.now() - started;
        results.push({ index, tool: step.tool, success: result.success, message: result.message, durationMs: duration });
        if (result.success) {
          last = result;
          if (step.storeAs) {
            vars[step.storeAs] = result.message;
            for (const [k, v] of Object.entries(result.data ?? {})) vars[`${step.storeAs}.${k}`] = v;
          }
        } else {
          last = result;
          if (step.onFail === "skip") {
            partial = true;
          } else if (step.onFail === "stop") {
            partial = true;
            failMessage = `Stopped at step ${index + 1} (${step.tool}): ${result.message}`;
            break;
          } else {
            failed = true;
            failMessage = `Step ${index + 1} (${step.tool}) failed: ${result.message}`;
            break;
          }
        }
      }
      const lastOk = [...results].reverse().find((r) => r.success);
      const message = failed ? failMessage : partial ? failMessage ? `Partially done — ${failMessage}` : `Partially done (some steps skipped): ${(lastOk == null ? void 0 : lastOk.message) ?? skill.name}.` : (lastOk == null ? void 0 : lastOk.message) && lastOk.message.trim() ? lastOk.message : `Done: ${skill.name}.`;
      return { success: !failed, partial, message, steps: results, vars };
    }
  }
  function resolveRefs(value, vars) {
    let missing = null;
    const out = value.replace(REF, (_m, name2) => {
      if (vars[name2] !== void 0) return vars[name2];
      missing = name2;
      return _m;
    });
    if (missing !== null) throw new Error(`missing parameter/var '$${missing}'`);
    return out;
  }
  function evalWhen(expr, vars, last) {
    return expr.split("&&").map((p) => p.trim()).every((part) => evalAtom(part, vars, last));
  }
  function evalAtom(atom, vars, last) {
    const negated = atom.startsWith("!");
    const core = negated ? atom.slice(1).trim() : atom;
    let value = false;
    if (core === "last.success") value = (last == null ? void 0 : last.success) === true;
    else if (core === "last.failed") value = (last == null ? void 0 : last.success) === false;
    else if (core.startsWith("vars.")) {
      const rest = core.slice("vars.".length);
      if (rest.includes(" contains ")) {
        const [k, v] = rest.split(" contains ");
        value = (vars[k.trim()] ?? "").includes(unquote(v.trim()));
      } else if (rest.includes("==")) {
        const [k, v] = rest.split("==");
        value = vars[k.trim()] === unquote(v.trim());
      } else if (rest.includes("!=")) {
        const [k, v] = rest.split("!=");
        value = vars[k.trim()] !== unquote(v.trim());
      } else {
        const v = vars[rest];
        value = v !== void 0 && v.trim() !== "";
      }
    }
    return negated ? !value : value;
  }
  function unquote(s) {
    return s.replace(/^["']|["']$/g, "");
  }
  function parseSkill(json) {
    try {
      if (typeof json !== "object" || json === null) return null;
      const obj = json;
      const id2 = typeof obj.id === "string" ? obj.id.trim() : "";
      if (!id2) return null;
      const stepsJson = obj.steps;
      if (!Array.isArray(stepsJson)) return null;
      const steps2 = [];
      for (const s of stepsJson) {
        if (typeof s !== "object" || s === null) continue;
        const so = s;
        const tool = typeof so.tool === "string" ? so.tool.trim() : "";
        if (!tool) continue;
        const args = {};
        if (typeof so.args === "object" && so.args !== null) {
          for (const [k, v] of Object.entries(so.args)) args[k] = String(v ?? "");
        }
        const onFailRaw = typeof so.onFail === "string" ? so.onFail.toLowerCase() : "fail";
        steps2.push({
          tool,
          args,
          storeAs: typeof so.storeAs === "string" && so.storeAs.trim() ? so.storeAs : null,
          when: typeof so.when === "string" && so.when.trim() ? so.when : null,
          onFail: ["fail", "skip", "stop"].includes(onFailRaw) ? onFailRaw : "fail",
          maxRetries: typeof so.maxRetries === "number" ? Math.min(3, Math.max(0, Math.floor(so.maxRetries))) : 0,
          risk: so.risk === "irreversible" ? "irreversible" : null
        });
      }
      if (steps2.length === 0) return null;
      const params2 = [];
      if (Array.isArray(obj.params)) {
        for (const p of obj.params) {
          if (typeof p !== "object" || p === null) continue;
          const po = p;
          const name2 = typeof po.name === "string" ? po.name.trim() : "";
          if (!name2) continue;
          params2.push({
            name: name2,
            required: po.required === true,
            default: typeof po.default === "string" && po.default.trim() ? po.default : null
          });
        }
      }
      const triggers2 = [];
      if (Array.isArray(obj.triggers)) {
        for (const t2 of obj.triggers) {
          if (typeof t2 === "string" && t2.trim()) triggers2.push(t2.trim());
        }
      }
      return {
        id: id2,
        name: typeof obj.name === "string" && obj.name ? obj.name : id2,
        description: typeof obj.description === "string" ? obj.description : "",
        triggers: triggers2,
        params: params2,
        steps: steps2,
        maxSteps: typeof obj.maxSteps === "number" ? Math.min(100, Math.max(1, Math.floor(obj.maxSteps))) : 20,
        timeoutMs: typeof obj.timeoutMs === "number" ? Math.min(3e5, Math.max(1e3, Math.floor(obj.timeoutMs))) : 6e4,
        summarize: obj.summarize === true
      };
    } catch {
      return null;
    }
  }
  const description$1 = "Search Shopee (web) for a product and return the top 5 prices found on the page.";
  const id$1 = "shopee_price_search";
  const maxSteps$1 = 12;
  const name$1 = "Shopee price search";
  const params$1 = [{ "name": "query", "required": true }];
  const steps$1 = [{ "args": { "url": "https://shopee.co.id/search?keyword=$query" }, "tool": "navigate" }, { "args": { "text": "Rp", "timeoutMs": "15000" }, "onFail": "skip", "tool": "waitForText" }, { "onFail": "skip", "tool": "scroll" }, { "args": { "limit": "100" }, "storeAs": "screen", "tool": "readScreen" }, { "args": { "max": "5", "pattern": "Rp\\s?[0-9][0-9.,]*" }, "storeAs": "prices", "tool": "extract", "when": "last.success" }];
  const summarize$1 = false;
  const timeoutMs$1 = 6e4;
  const triggers$1 = ["shopee", "cari harga", "cek harga", "bandingkan harga", "harga di shopee"];
  const shopeeSkillJson = {
    description: description$1,
    id: id$1,
    maxSteps: maxSteps$1,
    name: name$1,
    params: params$1,
    steps: steps$1,
    summarize: summarize$1,
    timeoutMs: timeoutMs$1,
    triggers: triggers$1
  };
  const description = "Search Tokopedia (web) for a product and return the top 5 prices found on the page.";
  const id = "tokopedia_price_search";
  const maxSteps = 12;
  const name = "Tokopedia price search";
  const params = [{ "name": "query", "required": true }];
  const steps = [{ "args": { "url": "https://www.tokopedia.com/search?st=product&q=$query" }, "tool": "navigate" }, { "args": { "text": "Rp", "timeoutMs": "15000" }, "onFail": "skip", "tool": "waitForText" }, { "onFail": "skip", "tool": "scroll" }, { "args": { "limit": "100" }, "storeAs": "screen", "tool": "readScreen" }, { "args": { "max": "5", "pattern": "Rp\\s?[0-9][0-9.,]*" }, "storeAs": "prices", "tool": "extract", "when": "last.success" }];
  const summarize = false;
  const timeoutMs = 6e4;
  const triggers = ["tokopedia", "cari harga", "cek harga", "bandingkan harga", "harga di tokopedia"];
  const tokopediaSkillJson = {
    description,
    id,
    maxSteps,
    name,
    params,
    steps,
    summarize,
    timeoutMs,
    triggers
  };
  class SkillRegistry {
    constructor() {
      __publicField(this, "skills");
      this.skills = [shopeeSkillJson, tokopediaSkillJson].map((j) => parseSkill(j)).filter((s) => s !== null);
    }
    all() {
      return this.skills;
    }
    byId(id2) {
      return this.skills.find((s) => s.id === id2);
    }
    match(userText) {
      const t2 = userText.toLowerCase();
      let best = null;
      let bestScore = 0;
      let secondScore = 0;
      for (const skill of this.skills) {
        let score = 0;
        for (const rawTrigger of skill.triggers) {
          const trigger = rawTrigger.toLowerCase().trim();
          if (!trigger) continue;
          if (t2.includes(trigger)) {
            score += trigger.includes(" ") ? 3 : 2;
          } else {
            const words = trigger.split(/\s+/).filter((w) => w.length > 2);
            if (words.length > 0 && words.some((w) => t2.includes(w))) score += 1;
          }
        }
        if (score > bestScore) {
          secondScore = bestScore;
          bestScore = score;
          best = skill;
        } else if (score > secondScore) {
          secondScore = score;
        }
      }
      return best !== null && bestScore >= 3 && bestScore > secondScore ? { skill: best, score: bestScore } : null;
    }
  }
  const FILLER_WORDS = [
    "tolong",
    "mohon",
    "cari",
    "cek",
    "carikan",
    "tolong cari",
    "tolong cek",
    "di",
    "untuk",
    "harga",
    "harganya",
    "berapa",
    "dong",
    "ya",
    "saja",
    "aja",
    "please",
    "find",
    "check",
    "search",
    "for",
    "the",
    "price",
    "of"
  ];
  function extractQuery(input, skillTriggers) {
    let text = ` ${input.toLowerCase().trim()} `;
    const triggers2 = [...skillTriggers].sort((a, b) => b.length - a.length);
    for (const trigger of triggers2) {
      text = text.split(trigger.toLowerCase()).join(" ");
    }
    let query = text.replace(/[?,!.]+/g, " ").replace(/\s+/g, " ").trim();
    for (const filler of FILLER_WORDS) {
      const re = new RegExp(`^(${filler}\\s+)+`, "i");
      query = query.replace(re, "").trim();
    }
    for (const filler of ["di", "dong", "ya", "saja", "aja", "please"]) {
      const re = new RegExp(`(\\s+${filler})+$`, "i");
      query = query.replace(re, "").trim();
    }
    return query.length >= 2 ? query : null;
  }
  class TaskRouter {
    constructor() {
      __publicField(this, "skills", new SkillRegistry());
    }
    /** Keyword skill match + extracted params. Null = no clear match (LLM fallback). */
    matchSkill(input) {
      const match = this.skills.match(input);
      if (!match) return null;
      const query = extractQuery(input, match.skill.triggers);
      if (!query) return null;
      const params2 = {};
      const required = match.skill.params.find((p) => p.required);
      if (required) params2[required.name] = query;
      return { match, params: params2 };
    }
    route(input, url) {
      const text = input.toLowerCase().trim();
      const isWhatsApp = (url ?? "").includes("web.whatsapp.com");
      if (/\b(reply|balas|jawab)\b/.test(text) && (isWhatsApp || /\bwhatsapp\b/.test(text))) {
        return { intent: "wa-reply", agentType: "reply", confidence: 0.95 };
      }
      if (isWhatsApp && /\b(reply|balas|jawab|draft)\b/.test(text)) {
        return { intent: "wa-reply", agentType: "reply", confidence: 0.9 };
      }
      if (/\b(summar(y|ise|ize)|ringkas|tl;dr|tldr|intinya|poin penting)\b/.test(text)) {
        return { intent: "summarize", agentType: "summarize", confidence: 0.95 };
      }
      if (/\b(this page|halaman ini|artikel ini|page)\b/.test(text)) {
        return { intent: "summarize", agentType: "summarize", confidence: 0.8 };
      }
      return { intent: "chat", agentType: "chat", confidence: 0.6 };
    }
  }
  class WebSkillTools {
    constructor() {
      __publicField(this, "tabId", null);
    }
    async call(tool, args) {
      switch (tool) {
        case "navigate":
          return this.navigate(args.url ?? "");
        case "clickText":
          return this.toTab("MOBIUS_TOOL_CLICK_TEXT", { text: args.text ?? "", exact: args.exact === "true" });
        case "typeText":
          return this.toTab("MOBIUS_TOOL_TYPE_TEXT", { text: args.text ?? "" });
        case "submit":
          return this.toTab("MOBIUS_TOOL_SUBMIT", {});
        case "readScreen":
          return this.readScreen(args.limit ? Number(args.limit) : 200);
        case "findText":
          return this.toTab("MOBIUS_TOOL_FIND_TEXT", { text: args.text ?? "", exact: args.exact === "true" });
        case "extract":
          return this.extract(args.pattern ?? "", args.max ? Number(args.max) : 5);
        case "scroll":
          return this.toTab("MOBIUS_TOOL_SCROLL", {});
        case "back":
          return this.toTab("MOBIUS_TOOL_BACK", {});
        case "home":
          return this.toTab("MOBIUS_TOOL_HOME", {});
        case "wait":
          await new Promise((r) => setTimeout(r, args.ms ? Number(args.ms) : 1e3));
          return okResult(`Waited ${args.ms ?? "1000"}ms.`);
        case "waitForText":
          return this.toTab("MOBIUS_TOOL_WAIT_FOR_TEXT", { text: args.text ?? "", timeoutMs: String(args.timeoutMs ? Number(args.timeoutMs) : 5e3) });
        default:
          return failResult(`Unknown tool: ${tool}`);
      }
    }
    async navigate(rawUrl) {
      if (!rawUrl) return failResult("navigate needs a url.");
      const url = encodeURI(rawUrl);
      try {
        const tab = await this.activeTab();
        if ((tab == null ? void 0 : tab.id) !== void 0) {
          this.tabId = tab.id;
          await chrome.tabs.update(tab.id, { url });
          await this.waitForLoad(tab.id, 2e4);
          return okResult(`Opened ${url}`);
        }
        const created = await chrome.tabs.create({ url });
        if (created.id !== void 0) {
          this.tabId = created.id;
          await this.waitForLoad(created.id, 2e4);
          return okResult(`Opened ${url} in a new tab`);
        }
        return failResult("Could not open a tab.");
      } catch (e) {
        return failResult(e instanceof Error ? e.message : String(e));
      }
    }
    async readScreen(limit) {
      var _a;
      const res = await this.toTab("MOBIUS_TOOL_READ_PAGE", {});
      if (!res.success || !((_a = res.data) == null ? void 0 : _a.text)) return res;
      const text = res.data.text;
      const capped = text.slice(0, Math.max(1e3, limit * 100));
      return okResult(capped.slice(0, 400) + (capped.length > 400 ? "…" : ""), { text: capped });
    }
    async extract(pattern, max) {
      var _a;
      if (!pattern) return failResult("extract needs a pattern.");
      let re;
      try {
        re = new RegExp(pattern, "g");
      } catch {
        return failResult(`Invalid pattern: ${pattern}`);
      }
      const res = await this.toTab("MOBIUS_TOOL_EXTRACT", { pattern, max: String(max) });
      if (!res.success) return res;
      const matches = ((_a = res.data) == null ? void 0 : _a.matches) ? res.data.matches.split("\n").filter(Boolean) : [];
      if (matches.length === 0) return failResult("No matches found on this page.");
      const shown = matches.slice(0, max);
      return okResult(`Found ${matches.length} price(s): ${shown.join(", ")}`, { matches: shown.join("\n"), count: String(matches.length) });
    }
    async toTab(type, payload) {
      try {
        const tab = await this.activeTab();
        if ((tab == null ? void 0 : tab.id) === void 0) return failResult("No active tab — open a page first.");
        this.tabId = tab.id;
        const res = await chrome.tabs.sendMessage(tab.id, { type, ...payload });
        if (!res) return failResult("Content script did not answer (reload the page and try again).");
        if (!res.ok) return failResult(res.error ?? "Tool failed on the page.");
        if (res.text !== void 0) return okResult(res.text.slice(0, 400), { text: res.text });
        if (res.matches !== void 0) return okResult(res.matches.join(", "), { matches: res.matches.join("\n") });
        if (res.found !== void 0) return res.found ? okResult(`Found "${payload.text ?? ""}" on the page.`) : failResult(`"${payload.text ?? ""}" not found on the page.`);
        return okResult("Done.");
      } catch (e) {
        return failResult(e instanceof Error ? e.message : String(e));
      }
    }
    async activeTab() {
      if (this.tabId !== null) {
        try {
          const tab = await chrome.tabs.get(this.tabId);
          if (tab) return tab;
        } catch {
          this.tabId = null;
        }
      }
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      return tabs[0];
    }
    waitForLoad(tabId, timeoutMs2) {
      return new Promise((resolve) => {
        const done = () => {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        };
        const timer = setTimeout(done, timeoutMs2);
        const listener = (id2, info) => {
          if (id2 === tabId && info.status === "complete") {
            clearTimeout(timer);
            done();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
      });
    }
  }
  class Orchestrator {
    constructor() {
      __publicField(this, "permissions", new PermissionManager());
      __publicField(this, "memory", new MemoryStore());
      __publicField(this, "chatHistory", new ChatHistory());
      __publicField(this, "contextManager", new ContextManager());
      __publicField(this, "taskRouter", new TaskRouter());
      __publicField(this, "aiRouter", new AIRouter(this.permissions));
      __publicField(this, "agentFactory", new AgentFactory(this.aiRouter, this.permissions));
    }
    async getSettings() {
      const data = await chrome.storage.local.get(STORAGE_KEYS.settings);
      const stored = data[STORAGE_KEYS.settings];
      return {
        memoryTtlSeconds: (stored == null ? void 0 : stored.memoryTtlSeconds) ?? DEFAULT_MEMORY_TTL_SECONDS,
        tempTtlSeconds: (stored == null ? void 0 : stored.tempTtlSeconds) ?? DEFAULT_TEMP_TTL_SECONDS,
        chatRetentionSeconds: (stored == null ? void 0 : stored.chatRetentionSeconds) ?? DEFAULT_CHAT_RETENTION_SECONDS
      };
    }
    /** Main entry: handle one user task end-to-end (prompt section 6). */
    async handleTask(task) {
      await loadLanguage();
      const settings = await this.getSettings();
      const skillMatch = this.taskRouter.matchSkill(task.input);
      if (skillMatch) {
        return this.runSkill(task, skillMatch.match.skill, skillMatch.match.score, skillMatch.params, settings);
      }
      const route = this.taskRouter.route(task.input, task.url);
      if ((route.intent === "wa-reply" || route.intent === "summarize") && !await this.permissions.isAllowed("readPage")) {
        return this.fail(task, "none", this.permissions.denialMessage("readPage"));
      }
      if (route.intent === "wa-reply" && !await this.permissions.isAllowed("domActions")) {
        return this.runWithAgent(
          task,
          route.agentType,
          settings,
          /* insertIntoPage */
          false
        );
      }
      return this.runWithAgent(
        task,
        route.agentType,
        settings,
        /* insertIntoPage */
        true
      );
    }
    /** Deterministic skill run (no LLM): navigate the web, read, extract. */
    async runSkill(task, skill, score, params2, settings) {
      const started = Date.now();
      const summary = task.input.slice(0, 80).replace(/\s+/g, " ");
      if (!await this.permissions.isAllowed("readPage")) {
        return this.fail(task, "none", `${t("skillNeedsReadPage")} ${this.permissions.denialMessage("readPage")}`);
      }
      const outcome = await new SkillRunner().run(skill, params2, new WebSkillTools());
      const cloudAllowed = await this.permissions.isAllowed("cloudAI");
      await this.aiRouter.log({
        taskId: task.id,
        taskSummary: summary,
        engine: "skill",
        reason: tf("skillMatched", { skill: skill.name, score }),
        latencyMs: Date.now() - started,
        cloudAllowed,
        payloadSummary: `skill ${skill.id}, ${outcome.steps.length} steps, ${outcome.success ? "ok" : outcome.partial ? "partial" : "failed"}`
      });
      const text = outcome.success ? this.formatSkillResult(skill.name, outcome.vars) : tf("skillFailed", { message: outcome.message });
      const result = {
        taskId: task.id,
        ok: outcome.success,
        engine: "skill",
        text,
        provenance: `Skill: ${skill.name} (deterministic, local)`,
        error: outcome.success ? void 0 : outcome.message
      };
      await this.chatHistory.add("user", task.input, settings.chatRetentionSeconds ?? DEFAULT_CHAT_RETENTION_SECONDS);
      await this.chatHistory.add("assistant", text, settings.chatRetentionSeconds ?? DEFAULT_CHAT_RETENTION_SECONDS);
      if (result.ok && await this.permissions.isAllowed("memory")) {
        await this.memory.add({
          type: "task_result",
          content: `${task.input.slice(0, 120)} -> ${text.slice(0, 200)} [skill:${skill.id}]`,
          source: `${task.id}/skill:${skill.id}`,
          ttlSeconds: settings.memoryTtlSeconds
        });
      }
      return result;
    }
    /** "Shopee price search — sepatu nike\nRp120.000\nRp135.500…" from skill vars. */
    formatSkillResult(skillName, vars) {
      const prices = vars["prices.matches"] ?? vars.prices ?? "";
      const query = vars.query ? ` — ${vars.query}` : "";
      if (prices) {
        const lines = prices.split("\n").filter(Boolean);
        return `${skillName}${query}
${lines.map((p) => `• ${p}`).join("\n")}`;
      }
      return `${tf("skillDone", { skill: skillName })}${query}`;
    }
    async runWithAgent(task, agentType, settings, insertIntoPage) {
      const recent = (await this.memory.list()).slice(0, 5).map((e) => e.content);
      const context = await this.contextManager.build(task.tabId, task.pageText, recent);
      const agent = this.agentFactory.create(agentType, task, context, settings.tempTtlSeconds, insertIntoPage);
      let result;
      try {
        result = await agent.run();
      } catch (err) {
        result = this.fail(task, "none", err instanceof Error ? err.message : String(err));
      } finally {
        agent.destroy();
      }
      if (result.ok && await this.permissions.isAllowed("memory")) {
        await this.memory.add({
          type: "task_result",
          content: `${task.input.slice(0, 120)} -> ${result.text.slice(0, 200)} [${result.engine}]`,
          source: `${task.id}/${agentType}`,
          ttlSeconds: settings.memoryTtlSeconds
        });
      }
      const retention = settings.chatRetentionSeconds ?? DEFAULT_CHAT_RETENTION_SECONDS;
      await this.chatHistory.add("user", task.input, retention);
      if (result.text) await this.chatHistory.add("assistant", result.text, retention);
      return result;
    }
    fail(task, engine, message) {
      return {
        taskId: task.id,
        ok: false,
        engine,
        text: "",
        provenance: "Failed",
        error: message
      };
    }
    // Exposed for the service worker / side panel.
    getMemoryStore() {
      return this.memory;
    }
    getChatHistory() {
      return this.chatHistory;
    }
    getPermissionManager() {
      return this.permissions;
    }
    getAIRouter() {
      return this.aiRouter;
    }
  }
  const orchestrator = new Orchestrator();
  void loadLanguage();
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    var _a, _b, _c;
    const msg = message;
    if ((msg == null ? void 0 : msg.type) === "MOBIUS_TASK" && msg.task) {
      const task = { ...msg.task, tabId: msg.task.tabId ?? ((_a = sender.tab) == null ? void 0 : _a.id), url: msg.task.url ?? ((_b = sender.tab) == null ? void 0 : _b.url) };
      orchestrator.handleTask(task).then((result) => sendResponse({ ok: true, result })).catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      return true;
    }
    if ((msg == null ? void 0 : msg.type) === "MOBIUS_OPEN_PANEL") {
      chrome.sidePanel.open({ windowId: ((_c = sender.tab) == null ? void 0 : _c.windowId) ?? -1 }).catch(() => void 0);
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
  chrome.action.onClicked.addListener((tab) => {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => void 0);
  });
  chrome.alarms.create("mobius-ttl-cleanup", { periodInMinutes: TEMP_CLEANUP_ALARM_MINUTES });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== "mobius-ttl-cleanup") return;
    orchestrator.getMemoryStore().purgeExpired().then((purged) => {
      if (purged > 0) console.log(`[MOBIUS] TTL cleanup purged ${purged} expired memory entries.`);
    }).catch((err) => console.warn("[MOBIUS] TTL cleanup failed:", err));
    orchestrator.getChatHistory().purgeExpired().then((purged) => {
      if (purged > 0) console.log(`[MOBIUS] TTL cleanup purged ${purged} expired chat messages.`);
    }).catch((err) => console.warn("[MOBIUS] Chat cleanup failed:", err));
  });
  console.log("[MOBIUS] Core service worker started.");
})();
