/**
 * Hivekeep Mini-App SDK (JavaScript)
 * Auto-injected into mini-app iframes alongside hivekeep-sdk.css.
 *
 * Provides:
 *   Hivekeep.theme   — current theme info (mode, palette)
 *   Hivekeep.app     — current app metadata (id, name, slug)
 *   Hivekeep.on()    — listen for events from the parent
 *   Hivekeep.emit()  — send events to the parent
 *   Hivekeep.toast() — show a toast notification in the parent UI
 *   Hivekeep.storage  — persistent key-value storage (get/set/delete/list/clear)
 *   Hivekeep.ready() — signal that the app has finished loading
 *   Hivekeep.fullpage(bool) — request full-page or side-panel mode
 *   Hivekeep.isFullPage — whether the app is currently in full-page mode
 *   Hivekeep.api(path, options) — call backend API (_server.js) routes (raw Response)
 *     .json(path, options?) — shorthand: call and parse JSON
 *     .get(path, headers?) — shorthand: GET JSON
 *     .post(path, data) — shorthand: POST JSON
 *     .put(path, data) — shorthand: PUT JSON
 *     .patch(path, data) — shorthand: PATCH JSON
 *     .delete(path) — shorthand: DELETE and parse response
 *   Hivekeep.confirm(message, options) — show a confirmation dialog in the parent UI (returns Promise<boolean>)
 *   Hivekeep.prompt(message, options) — show a prompt dialog in the parent UI (returns Promise<string|null>)
 *   Hivekeep.setTitle(title) — dynamically update the panel header title
 *   Hivekeep.setBadge(value) — show a badge on the app in the sidebar (number, string, or null to clear)
 *   Hivekeep.openApp(slug) — open another mini-app from the same Agent by its slug
 *   Hivekeep.clipboard.write(text) — copy text to system clipboard (bypasses iframe restrictions)
 *   Hivekeep.clipboard.read() — read text from system clipboard (may require permission)
 *   Hivekeep.http(url, options) — fetch external URLs through server proxy (bypasses CORS)
 *     .json(url, headers?) — shorthand: GET and parse JSON
 *     .post(url, data, headers?) — shorthand: POST JSON and parse response
 *   Hivekeep.sendMessage(text, options?) — send a message to the Agent's conversation (returns Promise<boolean>)
 *   Hivekeep.agent — info about the parent Agent (id, name, avatarUrl)
 *   Hivekeep.user — info about the current user (id, name, pseudonym, locale, timezone, avatarUrl)
 *   Hivekeep.resize(width?, height?) — request the parent panel to resize
 *   Hivekeep.notification(title, body?) — show a browser notification via the parent (returns Promise<boolean>)
 *   Hivekeep.apps.list() — list all mini-apps from the same Agent
 *   Hivekeep.apps.get(appId) — get details of a specific mini-app
 *   Hivekeep.memory.search(query, limit?) — semantic search the Agent's memories
 *   Hivekeep.memory.store(content, options?) — store a new memory for the Agent
 *   Hivekeep.conversation.history(limit?) — get recent conversation messages
 *   Hivekeep.conversation.send(text, options?) — send a message to the Agent's conversation
 *   Hivekeep.share(targetSlug, data) — share data with another mini-app and open it
 *   Hivekeep.locale — current UI language code (e.g. 'en', 'fr')
 *   Hivekeep.on('locale-changed', cb) — listen for language changes (cb receives {locale})
 *   Hivekeep.events — real-time event stream from backend (_server.js)
 *     .subscribe(callback) — receive all events from ctx.events.emit() in the backend
 *     .send(event, data)   — send an event to the backend's onClientEvent() export
 *     .on(eventName, callback) — listen for a specific event name
 *     .close() — disconnect the event stream
 *     .connected — whether the SSE connection is active
 */
;(function () {
  'use strict'

  // ─── Internal state ─────────────────────────────────────────────────────

  var listeners = {} // event name → Set<callback>
  var _appMeta = null
  var _isFullPage = false
  var _locale = 'en'
  var _pendingDialogs = {} // callbackId → {resolve}
  var _dialogCounter = 0
  var _kinInfo = null // { id, name, avatarUrl }
  var _userInfo = null // { id, name, pseudonym, locale, timezone, avatarUrl }

  // ─── Console interception ─────────────────────────────────────────────

  var _consoleBuffer = [] // ring buffer, max 50 entries
  var CONSOLE_BUFFER_MAX = 50

  function _pushConsoleEntry(entry) {
    _consoleBuffer.push(entry)
    if (_consoleBuffer.length > CONSOLE_BUFFER_MAX) _consoleBuffer.shift()
    try {
      parent.postMessage({
        source: 'hivekeep-sdk',
        type: 'console',
        level: entry.level,
        args: entry.args,
        stack: entry.stack || null,
        timestamp: entry.timestamp,
      }, '*')
    } catch (e) { /* ignore */ }
  }

  // Patch console.log/warn/error
  ;['log', 'warn', 'error'].forEach(function (level) {
    var original = console[level]
    console[level] = function () {
      // Call the original so devtools still work
      original.apply(console, arguments)
      // Serialize arguments safely
      var args = []
      for (var i = 0; i < arguments.length; i++) {
        try {
          var a = arguments[i]
          if (a instanceof Error) {
            args.push(a.message)
          } else if (typeof a === 'object') {
            args.push(JSON.stringify(a))
          } else {
            args.push(String(a))
          }
        } catch (e) {
          args.push('[unserializable]')
        }
      }
      _pushConsoleEntry({ level: level, args: args, timestamp: Date.now() })
    }
  })

  // Catch uncaught errors
  window.addEventListener('error', function (ev) {
    _pushConsoleEntry({
      level: 'error',
      args: [ev.message || 'Unknown error'],
      stack: ev.error && ev.error.stack ? ev.error.stack : (ev.filename + ':' + ev.lineno + ':' + ev.colno),
      timestamp: Date.now(),
    })
  })

  // Catch unhandled promise rejections
  window.addEventListener('unhandledrejection', function (ev) {
    var reason = ev.reason
    var msg = 'Unhandled promise rejection'
    var stack = null
    if (reason instanceof Error) {
      msg = reason.message
      stack = reason.stack || null
    } else if (typeof reason === 'string') {
      msg = reason
    } else {
      try { msg = JSON.stringify(reason) } catch (e) { /* keep default */ }
    }
    _pushConsoleEntry({
      level: 'error',
      args: ['Unhandled promise rejection: ' + msg],
      stack: stack,
      timestamp: Date.now(),
    })
  })

  // ─── Theme ──────────────────────────────────────────────────────────────

  function getTheme() {
    var root = document.documentElement
    return {
      mode: root.classList.contains('dark') ? 'dark' : 'light',
      palette: root.getAttribute('data-palette') || 'aurora',
    }
  }

  // ─── Events ─────────────────────────────────────────────────────────────

  function on(event, callback) {
    if (!listeners[event]) listeners[event] = new Set()
    listeners[event].add(callback)
    return function off() {
      if (listeners[event]) listeners[event].delete(callback)
    }
  }

  function _dispatch(event, data) {
    var cbs = listeners[event]
    if (cbs) {
      cbs.forEach(function (cb) {
        try { cb(data) } catch (e) { console.error('[Hivekeep SDK]', event, e) }
      })
    }
  }

  function emit(event, data) {
    try {
      parent.postMessage({ source: 'hivekeep-sdk', type: 'emit', event: event, data: data }, '*')
    } catch (e) {
      console.warn('[Hivekeep SDK] emit failed:', e)
    }
  }

  // ─── Toast ──────────────────────────────────────────────────────────────

  /**
   * Show a toast in the parent Hivekeep UI.
   * @param {string} message
   * @param {'info'|'success'|'warning'|'error'} [type='info']
   */
  function toast(message, type) {
    try {
      parent.postMessage({
        source: 'hivekeep-sdk',
        type: 'toast',
        message: String(message).slice(0, 500),
        toastType: type || 'info',
      }, '*')
    } catch (e) {
      console.warn('[Hivekeep SDK] toast failed:', e)
    }
  }

  // ─── Navigate ───────────────────────────────────────────────────────────

  /**
   * Navigate the parent Hivekeep app to a path.
   * @param {string} path — e.g. '/agents' or '/settings'
   */
  function navigate(path) {
    try {
      parent.postMessage({
        source: 'hivekeep-sdk',
        type: 'navigate',
        path: String(path),
      }, '*')
    } catch (e) {
      console.warn('[Hivekeep SDK] navigate failed:', e)
    }
  }

  // ─── Ready ──────────────────────────────────────────────────────────────

  var _readyPromise = null

  /**
   * Signal that the app has finished loading and wait for app metadata.
   * Returns a Promise that resolves with app metadata once the parent responds.
   * Can be called with `await Hivekeep.ready()` or fire-and-forget `Hivekeep.ready()`.
   * If app-meta was already received, resolves immediately.
   * @returns {Promise<object>} — app metadata
   */
  function ready() {
    if (_readyPromise) return _readyPromise

    _readyPromise = new Promise(function (resolve) {
      // If app-meta was already received (e.g. ready() called late), resolve immediately
      if (_appMeta) {
        resolve(_appMeta)
        return
      }
      // Otherwise wait for the app-meta event
      on('app-meta', function onMeta(data) {
        resolve(data)
      })
    })

    try {
      parent.postMessage({ source: 'hivekeep-sdk', type: 'ready' }, '*')
    } catch (e) {}

    return _readyPromise
  }

  /**
   * Request full-page or side-panel mode.
   * @param {boolean} value — true for full-page, false for side panel
   */
  function fullpage(value) {
    _isFullPage = !!value
    try {
      parent.postMessage({ source: 'hivekeep-sdk', type: 'fullpage', value: _isFullPage }, '*')
    } catch (e) {
      console.warn('[Hivekeep SDK] fullpage failed:', e)
    }
  }

  // ─── Listen for messages from parent ────────────────────────────────────

  window.addEventListener('message', function (ev) {
    var msg = ev.data
    if (!msg || msg.source !== 'hivekeep-parent') return

    if (msg.type === 'dialog-result') {
      var pending = _pendingDialogs[msg.callbackId]
      if (pending) {
        delete _pendingDialogs[msg.callbackId]
        pending.resolve(msg.value)
      }
    } else if (msg.type === 'app-meta') {
      _appMeta = msg.data || null
      if (_appMeta && _appMeta.isFullPage !== undefined) _isFullPage = _appMeta.isFullPage
      if (_appMeta && _appMeta.locale) _locale = _appMeta.locale
      // Extract agent info
      if (_appMeta) {
        _kinInfo = {
          id: _appMeta.agentId || null,
          name: _appMeta.agentName || null,
          avatarUrl: _appMeta.agentAvatarUrl || null,
        }
      }
      // Extract user info
      if (_appMeta && _appMeta.user) {
        _userInfo = {
          id: _appMeta.user.id || null,
          name: _appMeta.user.name || null,
          pseudonym: _appMeta.user.pseudonym || null,
          locale: _appMeta.user.locale || _locale,
          timezone: _appMeta.user.timezone || null,
          avatarUrl: _appMeta.user.avatarUrl || null,
        }
      }
      _dispatch('app-meta', _appMeta)
    } else if (msg.type === 'locale-changed') {
      var newLocale = msg.data && msg.data.locale
      if (newLocale && newLocale !== _locale) {
        _locale = newLocale
        _dispatch('locale-changed', { locale: _locale })
      }
    } else if (msg.type === 'fullpage-changed') {
      _isFullPage = !!(msg.data && msg.data.isFullPage)
      _dispatch('fullpage-changed', { isFullPage: _isFullPage })
    } else if (msg.type === 'theme-changed') {
      _dispatch('theme-changed', getTheme())
    } else if (msg.type === 'shared-data') {
      _dispatch('shared-data', msg.data || null)
    } else if (msg.type === 'event') {
      _dispatch(msg.event, msg.data)
    }
  })

  // ─── Theme change observer (local CSS class sync already done by theme script) ─

  try {
    new MutationObserver(function () {
      _dispatch('theme-changed', getTheme())
    }).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-palette'],
    })
  } catch (e) {}

  // ─── Storage ─────────────────────────────────────────────────────────

  /**
   * Persistent key-value storage per app, backed by the server.
   * Values can be any JSON-serializable type.
   * All methods return Promises. Requires Hivekeep.ready() to have been called.
   */
  var storage = {
    /** Get a value by key. Returns parsed value or null if not found. */
    get: function (key) {
      if (!_appMeta || !_appMeta.id) return Promise.reject(new Error('App not ready — call Hivekeep.ready() first'))
      return fetch('/api/mini-apps/' + _appMeta.id + '/storage/' + encodeURIComponent(key))
        .then(function (r) {
          if (r.status === 404) return null
          if (!r.ok) return r.json().then(function (d) { throw new Error(d.error?.message || 'Storage error') })
          return r.json().then(function (d) { return d.value })
        })
    },

    /** Set a value for a key. Value must be JSON-serializable. */
    set: function (key, value) {
      if (!_appMeta || !_appMeta.id) return Promise.reject(new Error('App not ready — call Hivekeep.ready() first'))
      return fetch('/api/mini-apps/' + _appMeta.id + '/storage/' + encodeURIComponent(key), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: value }),
      }).then(function (r) {
        if (!r.ok) return r.json().then(function (d) { throw new Error(d.error?.message || 'Storage error') })
      })
    },

    /** Delete a key. Returns true if deleted, false if not found. */
    delete: function (key) {
      if (!_appMeta || !_appMeta.id) return Promise.reject(new Error('App not ready — call Hivekeep.ready() first'))
      return fetch('/api/mini-apps/' + _appMeta.id + '/storage/' + encodeURIComponent(key), {
        method: 'DELETE',
      }).then(function (r) {
        if (r.status === 404) return false
        if (!r.ok) return r.json().then(function (d) { throw new Error(d.error?.message || 'Storage error') })
        return true
      })
    },

    /** List all keys with their sizes. Returns [{key, size}]. */
    list: function () {
      if (!_appMeta || !_appMeta.id) return Promise.reject(new Error('App not ready — call Hivekeep.ready() first'))
      return fetch('/api/mini-apps/' + _appMeta.id + '/storage')
        .then(function (r) {
          if (!r.ok) return r.json().then(function (d) { throw new Error(d.error?.message || 'Storage error') })
          return r.json().then(function (d) { return d.keys })
        })
    },

    /** Clear all storage for this app. Returns number of keys cleared. */
    clear: function () {
      if (!_appMeta || !_appMeta.id) return Promise.reject(new Error('App not ready — call Hivekeep.ready() first'))
      return fetch('/api/mini-apps/' + _appMeta.id + '/storage', {
        method: 'DELETE',
      }).then(function (r) {
        if (!r.ok) return r.json().then(function (d) { throw new Error(d.error?.message || 'Storage error') })
        return r.json().then(function (d) { return d.cleared })
      })
    },
  }

  // ─── Backend API ─────────────────────────────────────────────────────────

  /**
   * Call a backend API route defined in _server.js.
   * @param {string} path — API path (e.g. '/hello', '/items/123')
   * @param {RequestInit} [options] — fetch options (method, headers, body, etc.)
   * @returns {Promise<Response>} — the raw fetch Response
   */
  function api(path, options) {
    if (!_appMeta || !_appMeta.id) return Promise.reject(new Error('App not ready — call Hivekeep.ready() first'))
    var url = '/api/mini-apps/' + _appMeta.id + '/api' + (path.startsWith('/') ? path : '/' + path)
    return fetch(url, options)
  }

  /**
   * Convenience: call backend API and parse JSON response.
   * @param {string} path
   * @param {RequestInit} [options]
   * @returns {Promise<any>}
   */
  api.json = function (path, options) {
    return api(path, options).then(function (r) {
      if (!r.ok) return r.json().then(function (d) { throw new Error(d.error?.message || 'API error ' + r.status) })
      return r.json()
    })
  }

  /**
   * Convenience: POST JSON to backend API.
   * @param {string} path
   * @param {any} data — will be JSON.stringify'd
   * @returns {Promise<any>}
   */
  api.post = function (path, data) {
    return api.json(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  }

  /**
   * Convenience: GET JSON from backend API.
   * @param {string} path
   * @param {Record<string,string>} [headers] — optional extra headers
   * @returns {Promise<any>}
   */
  api.get = function (path, headers) {
    return api.json(path, headers ? { headers: headers } : undefined)
  }

  /**
   * Convenience: PUT JSON to backend API.
   * @param {string} path
   * @param {any} data — will be JSON.stringify'd
   * @returns {Promise<any>}
   */
  api.put = function (path, data) {
    return api.json(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  }

  /**
   * Convenience: PATCH JSON to backend API.
   * @param {string} path
   * @param {any} data — will be JSON.stringify'd
   * @returns {Promise<any>}
   */
  api.patch = function (path, data) {
    return api.json(path, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  }

  /**
   * Convenience: DELETE via backend API.
   * @param {string} path
   * @returns {Promise<any|null>} — parsed JSON response, or null for 204
   */
  api.delete = function (path) {
    return api(path, { method: 'DELETE' }).then(function (r) {
      if (r.status === 204) return null
      if (!r.ok) return r.json().then(function (d) { throw new Error(d.error?.message || 'API error ' + r.status) })
      return r.json()
    })
  }

  // ─── Confirm / Prompt Dialogs ─────────────────────────────────────────────

  /**
   * Show a confirmation dialog in the parent Hivekeep UI.
   * @param {string} message — dialog body text
   * @param {object} [options]
   * @param {string} [options.title] — dialog title (default: "Confirm")
   * @param {string} [options.confirmLabel] — confirm button text (default: "Confirm")
   * @param {string} [options.cancelLabel] — cancel button text (default: "Cancel")
   * @param {'default'|'destructive'} [options.variant] — confirm button variant
   * @returns {Promise<boolean>} — true if confirmed, false if cancelled
   */
  function confirm(message, options) {
    var id = String(++_dialogCounter)
    var opts = options || {}
    try {
      parent.postMessage({
        source: 'hivekeep-sdk',
        type: 'confirm',
        callbackId: id,
        message: String(message).slice(0, 1000),
        title: opts.title || '',
        confirmLabel: opts.confirmLabel || '',
        cancelLabel: opts.cancelLabel || '',
        variant: opts.variant || 'default',
      }, '*')
    } catch (e) {
      return Promise.resolve(false)
    }
    return new Promise(function (resolve) {
      _pendingDialogs[id] = { resolve: resolve }
    })
  }

  /**
   * Show a prompt dialog in the parent Hivekeep UI.
   * @param {string} message — dialog body text
   * @param {object} [options]
   * @param {string} [options.title] — dialog title (default: "Input")
   * @param {string} [options.placeholder] — input placeholder
   * @param {string} [options.defaultValue] — pre-filled value
   * @param {string} [options.confirmLabel] — confirm button text (default: "OK")
   * @param {string} [options.cancelLabel] — cancel button text (default: "Cancel")
   * @returns {Promise<string|null>} — the entered string, or null if cancelled
   */
  function prompt(message, options) {
    var id = String(++_dialogCounter)
    var opts = options || {}
    try {
      parent.postMessage({
        source: 'hivekeep-sdk',
        type: 'prompt',
        callbackId: id,
        message: String(message).slice(0, 1000),
        title: opts.title || '',
        placeholder: opts.placeholder || '',
        defaultValue: opts.defaultValue || '',
        confirmLabel: opts.confirmLabel || '',
        cancelLabel: opts.cancelLabel || '',
      }, '*')
    } catch (e) {
      return Promise.resolve(null)
    }
    return new Promise(function (resolve) {
      _pendingDialogs[id] = { resolve: resolve }
    })
  }

  // ─── Set Title ───────────────────────────────────────────────────────────

  /**
   * Dynamically update the panel header title.
   * @param {string} title — new title to display (empty string resets to app name)
   */
  function setTitle(title) {
    try {
      parent.postMessage({
        source: 'hivekeep-sdk',
        type: 'set-title',
        title: String(title).slice(0, 200),
      }, '*')
    } catch (e) {
      console.warn('[Hivekeep SDK] setTitle failed:', e)
    }
  }

  // ─── Set Badge ──────────────────────────────────────────────────────────

  /**
   * Show a badge on the app in the sidebar.
   * @param {number|string|null} value — badge content (null or 0 to clear)
   */
  function setBadge(value) {
    try {
      parent.postMessage({
        source: 'hivekeep-sdk',
        type: 'set-badge',
        value: value === null || value === 0 || value === '' ? null : String(value).slice(0, 20),
      }, '*')
    } catch (e) {
      console.warn('[Hivekeep SDK] setBadge failed:', e)
    }
  }

  // ─── Open App ───────────────────────────────────────────────────────────

  /**
   * Open another mini-app from the same Agent by its slug.
   * @param {string} slug — the slug of the app to open (e.g. "todo-tracker")
   */
  function openApp(slug) {
    try {
      parent.postMessage({
        source: 'hivekeep-sdk',
        type: 'open-app',
        slug: String(slug),
      }, '*')
    } catch (e) {
      console.warn('[Hivekeep SDK] openApp failed:', e)
    }
  }

  // ─── Clipboard ─────────────────────────────────────────────────────────

  /**
   * Clipboard access via the parent window (bypasses iframe sandbox restrictions).
   */
  var clipboard = {
    /**
     * Write text to the system clipboard.
     * @param {string} text — text to copy
     * @returns {Promise<boolean>} — true if copied successfully
     */
    write: function (text) {
      var id = String(++_dialogCounter)
      try {
        parent.postMessage({
          source: 'hivekeep-sdk',
          type: 'clipboard-write',
          callbackId: id,
          text: String(text),
        }, '*')
      } catch (e) {
        return Promise.resolve(false)
      }
      return new Promise(function (resolve) {
        _pendingDialogs[id] = { resolve: resolve }
      })
    },

    /**
     * Read text from the system clipboard.
     * @returns {Promise<string|null>} — clipboard text, or null if denied/failed
     */
    read: function () {
      var id = String(++_dialogCounter)
      try {
        parent.postMessage({
          source: 'hivekeep-sdk',
          type: 'clipboard-read',
          callbackId: id,
        }, '*')
      } catch (e) {
        return Promise.resolve(null)
      }
      return new Promise(function (resolve) {
        _pendingDialogs[id] = { resolve: resolve }
      })
    },
  }

  // ─── Backend Events (SSE) ────────────────────────────────────────────────

  var _eventSource = null
  var _eventListeners = {} // eventName → Set<callback>
  var _allEventListeners = new Set() // callbacks for all events
  var _eventsConnected = false

  /**
   * Connect to the backend SSE event stream.
   * Called lazily on first subscribe/on call.
   */
  function _connectEvents() {
    if (_eventSource || !_appMeta || !_appMeta.id) return
    try {
      _eventSource = new EventSource('/api/mini-apps/' + _appMeta.id + '/events')

      _eventSource.addEventListener('connected', function () {
        _eventsConnected = true
      })

      _eventSource.addEventListener('app-event', function (ev) {
        try {
          var payload = JSON.parse(ev.data)
          var eventName = payload.event
          var data = payload.data

          // Dispatch to all-event listeners
          _allEventListeners.forEach(function (cb) {
            try { cb(eventName, data) } catch (e) { console.error('[Hivekeep SDK] events callback error:', e) }
          })

          // Dispatch to specific event listeners
          var specific = _eventListeners[eventName]
          if (specific) {
            specific.forEach(function (cb) {
              try { cb(data) } catch (e) { console.error('[Hivekeep SDK] events.' + eventName + ' callback error:', e) }
            })
          }
        } catch (e) {
          console.warn('[Hivekeep SDK] Failed to parse event:', e)
        }
      })

      _eventSource.onerror = function () {
        _eventsConnected = false
      }

      _eventSource.onopen = function () {
        _eventsConnected = true
      }
    } catch (e) {
      console.warn('[Hivekeep SDK] Failed to connect to event stream:', e)
    }
  }

  var events = {
    /**
     * Subscribe to all events from the backend.
     * @param {function(eventName: string, data: any): void} callback
     * @returns {function} unsubscribe function
     */
    subscribe: function (callback) {
      _allEventListeners.add(callback)
      _connectEvents()
      return function () { _allEventListeners.delete(callback) }
    },

    /**
     * Listen for a specific named event from the backend.
     * @param {string} eventName
     * @param {function(data: any): void} callback
     * @returns {function} unsubscribe function
     */
    on: function (eventName, callback) {
      if (!_eventListeners[eventName]) _eventListeners[eventName] = new Set()
      _eventListeners[eventName].add(callback)
      _connectEvents()
      return function () {
        if (_eventListeners[eventName]) _eventListeners[eventName].delete(callback)
      }
    },

    /**
     * Send an event to the backend's onClientEvent(ctx, event, data, meta) export.
     * The socket-style upstream channel: the backend can react and answer via
     * its return value, or push to everyone with ctx.events.emit().
     * @param {string} eventName
     * @param {any} [data]
     * @returns {Promise<{handled: boolean, result: any}>}
     */
    send: function (eventName, data) {
      if (!_appMeta || !_appMeta.id) return Promise.reject(new Error('App not ready — call Hivekeep.ready() first'))
      return fetch('/api/mini-apps/' + _appMeta.id + '/client-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: eventName, data: data }),
      }).then(function (r) {
        return r.json().then(function (d) {
          if (!r.ok) throw new Error((d.error && d.error.message) || 'events.send failed: ' + r.status)
          return d
        })
      })
    },

    /** Disconnect the event stream */
    close: function () {
      if (_eventSource) {
        _eventSource.close()
        _eventSource = null
        _eventsConnected = false
      }
    },

    /** Whether the SSE connection is active */
    get connected() { return _eventsConnected },
  }

  // ─── HTTP Proxy ──────────────────────────────────────────────────────────

  /**
   * Make HTTP requests to external URLs through the Hivekeep server proxy.
   * Bypasses CORS restrictions — mini-apps can fetch any public API.
   *
   * @param {string} url — the URL to fetch
   * @param {object} [options]
   * @param {string} [options.method='GET'] — HTTP method
   * @param {Record<string,string>} [options.headers] — request headers
   * @param {string|object} [options.body] — request body (objects are JSON.stringify'd)
   * @returns {Promise<{status: number, statusText: string, headers: Record<string,string>, body: string, isBase64: boolean, ok: boolean, json: function}>}
   */
  function http(url, options) {
    if (!_appMeta || !_appMeta.id) return Promise.reject(new Error('App not ready — call Hivekeep.ready() first'))

    var opts = options || {}
    var reqBody = opts.body
    if (reqBody && typeof reqBody === 'object') {
      reqBody = JSON.stringify(reqBody)
    }

    return fetch('/api/mini-apps/' + _appMeta.id + '/http', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: url,
        method: opts.method || 'GET',
        headers: opts.headers,
        body: reqBody,
      }),
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (d) { throw new Error(d.error?.message || 'HTTP proxy error ' + r.status) })
      return r.json()
    }).then(function (data) {
      // Decode base64 body for binary responses
      var body = data.body
      if (data.isBase64 && typeof atob === 'function') {
        // Keep as base64 string — caller can decode if needed
      }

      return {
        status: data.status,
        statusText: data.statusText,
        headers: data.headers || {},
        body: body,
        isBase64: !!data.isBase64,
        ok: data.status >= 200 && data.status < 300,
        /** Parse body as JSON */
        json: function () {
          try { return JSON.parse(body) } catch (e) { throw new Error('Failed to parse response as JSON') }
        },
        /** Get body as text (decodes base64 if needed) */
        text: function () {
          if (data.isBase64 && typeof atob === 'function') return atob(body)
          return body
        },
      }
    })
  }

  /**
   * Shorthand: GET JSON from an external URL.
   * @param {string} url
   * @param {Record<string,string>} [headers]
   * @returns {Promise<any>}
   */
  http.json = function (url, headers) {
    return http(url, { headers: headers }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + r.statusText)
      return r.json()
    })
  }

  /**
   * Shorthand: POST JSON to an external URL.
   * @param {string} url
   * @param {any} data — will be JSON.stringify'd
   * @param {Record<string,string>} [headers]
   * @returns {Promise<any>}
   */
  http.post = function (url, data, headers) {
    var h = Object.assign({ 'Content-Type': 'application/json' }, headers || {})
    return http(url, { method: 'POST', headers: h, body: JSON.stringify(data) }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + r.statusText)
      return r.json()
    })
  }

  // ─── Send Message to Agent ──────────────────────────────────────────────────

  /**
   * Send a message to the Agent that owns this app.
   * The message appears in the Agent's conversation as if sent by the current user,
   * prefixed with the app name for context.
   *
   * @param {string} text — message content (max 2000 chars)
   * @param {object} [options]
   * @param {boolean} [options.silent] — if true, don't show a toast confirmation (default: false)
   * @returns {Promise<boolean>} — true if the message was sent successfully
   */
  function sendMessage(text, options) {
    var id = String(++_dialogCounter)
    var opts = options || {}
    try {
      parent.postMessage({
        source: 'hivekeep-sdk',
        type: 'send-message',
        callbackId: id,
        text: String(text).slice(0, 2000),
        silent: !!opts.silent,
      }, '*')
    } catch (e) {
      return Promise.resolve(false)
    }
    return new Promise(function (resolve) {
      _pendingDialogs[id] = { resolve: resolve }
    })
  }

  // ─── Resize ─────────────────────────────────────────────────────────────

  /**
   * Request the parent panel to resize.
   * @param {number} [width] — desired width in pixels (side panel mode only)
   * @param {number} [height] — desired height in pixels (ignored in full-page mode)
   */
  function resize(width, height) {
    try {
      parent.postMessage({
        source: 'hivekeep-sdk',
        type: 'resize',
        width: width != null ? Number(width) : undefined,
        height: height != null ? Number(height) : undefined,
      }, '*')
    } catch (e) {
      console.warn('[Hivekeep SDK] resize failed:', e)
    }
  }

  // ─── Notification ──────────────────────────────────────────────────────

  /**
   * Request a browser notification via the parent window (which has Notification permission).
   * @param {string} title — notification title
   * @param {string} [body] — notification body text
   * @returns {Promise<boolean>} — true if the notification was shown
   */
  function notification(title, body) {
    var id = String(++_dialogCounter)
    try {
      parent.postMessage({
        source: 'hivekeep-sdk',
        type: 'notification',
        callbackId: id,
        title: String(title).slice(0, 200),
        body: body ? String(body).slice(0, 500) : undefined,
      }, '*')
    } catch (e) {
      return Promise.resolve(false)
    }
    return new Promise(function (resolve) {
      _pendingDialogs[id] = { resolve: resolve }
    })
  }

  // ─── Download ─────────────────────────────────────────────────────────────

  /**
   * Trigger a file download from within a mini-app.
   * Content can be a string (text), an object (auto-serialized to JSON), or a Blob/ArrayBuffer.
   * The parent window handles the actual download to bypass iframe sandbox restrictions.
   * @param {string} filename — download filename (e.g. 'report.csv')
   * @param {string|object|Blob|ArrayBuffer} content — file content
   * @param {string} [mimeType] — MIME type (auto-detected if omitted)
   * @returns {Promise<boolean>} — true if the download was initiated
   */
  function download(filename, content, mimeType) {
    if (!filename || content == null) return Promise.reject(new Error('filename and content are required'))
    var id = String(++_dialogCounter)
    var data, mime

    if (typeof content === 'string') {
      mime = mimeType || 'text/plain'
      data = btoa(unescape(encodeURIComponent(content)))
    } else if (content && typeof content === 'object' && !(content instanceof Blob) && !(content instanceof ArrayBuffer)) {
      // Plain object → JSON
      mime = mimeType || 'application/json'
      data = btoa(unescape(encodeURIComponent(JSON.stringify(content, null, 2))))
    } else if (content instanceof Blob) {
      // Blob → read as base64
      mime = mimeType || content.type || 'application/octet-stream'
      return new Promise(function (resolve) {
        var reader = new FileReader()
        reader.onload = function () {
          var b64 = reader.result.split(',')[1] || ''
          try {
            parent.postMessage({
              source: 'hivekeep-sdk', type: 'download', callbackId: id,
              filename: String(filename).slice(0, 200), data: b64, mimeType: mime,
            }, '*')
          } catch (e) { resolve(false); return }
          _pendingDialogs[id] = { resolve: resolve }
        }
        reader.onerror = function () { resolve(false) }
        reader.readAsDataURL(content)
      })
    } else if (content instanceof ArrayBuffer) {
      mime = mimeType || 'application/octet-stream'
      var bytes = new Uint8Array(content)
      var binary = ''
      for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
      data = btoa(binary)
    } else {
      return Promise.reject(new Error('Unsupported content type'))
    }

    try {
      parent.postMessage({
        source: 'hivekeep-sdk', type: 'download', callbackId: id,
        filename: String(filename).slice(0, 200), data: data, mimeType: mime,
      }, '*')
    } catch (e) {
      return Promise.resolve(false)
    }
    return new Promise(function (resolve) {
      _pendingDialogs[id] = { resolve: resolve }
    })
  }

  // ─── Keyboard Shortcuts ──────────────────────────────────────────────────

  var _shortcuts = {}

  function shortcut(key, callback) {
    // key: e.g. 'ctrl+k', 'meta+shift+p', 'escape'
    var normalized = key.toLowerCase().split('+').sort().join('+')
    if (typeof callback === 'function') {
      _shortcuts[normalized] = callback
      return function unregister() { delete _shortcuts[normalized] }
    } else if (callback === null || callback === undefined) {
      delete _shortcuts[normalized]
    }
  }

  document.addEventListener('keydown', function (e) {
    var parts = []
    if (e.ctrlKey) parts.push('ctrl')
    if (e.metaKey) parts.push('meta')
    if (e.altKey) parts.push('alt')
    if (e.shiftKey) parts.push('shift')
    var k = e.key.toLowerCase()
    if (!['control', 'meta', 'alt', 'shift'].includes(k)) parts.push(k)
    var combo = parts.sort().join('+')
    var handler = _shortcuts[combo]
    if (handler) {
      e.preventDefault()
      e.stopPropagation()
      handler(e)
    }
  })

  // ─── Apps (sibling mini-apps) ──────────────────────────────────────────

  var apps = {
    /**
     * List all mini-apps from the same Agent.
     * @returns {Promise<Array<{id: string, name: string, slug: string, description: string, icon: string, version: number}>>}
     */
    list: function () {
      if (!_appMeta || !_kinInfo || !_kinInfo.id) return Promise.reject(new Error('App not ready — call Hivekeep.ready() first'))
      return fetch('/api/mini-apps?agentId=' + encodeURIComponent(_kinInfo.id))
        .then(function (r) {
          if (!r.ok) return r.json().then(function (d) { throw new Error(d.error?.message || 'Failed to list apps') })
          return r.json()
        })
        .then(function (d) {
          return (d.apps || []).map(function (a) {
            return { id: a.id, name: a.name, slug: a.slug, description: a.description, icon: a.icon, version: a.version }
          })
        })
    },

    /**
     * Get details of a specific mini-app by ID.
     * @param {string} appId
     * @returns {Promise<object>}
     */
    get: function (appId) {
      return fetch('/api/mini-apps/' + encodeURIComponent(appId))
        .then(function (r) {
          if (!r.ok) return r.json().then(function (d) { throw new Error(d.error?.message || 'App not found') })
          return r.json()
        })
        .then(function (d) { return d.app })
    },
  }

  // ─── Memory ──────────────────────────────────────────────────────────────

  var memory = {
    /**
     * Search the Agent's memories using semantic + full-text hybrid search.
     * @param {string} query — search query
     * @param {number} [limit=20] — max results (1-50)
     * @returns {Promise<Array<{id: string, content: string, category: string, subject: string|null, score: number, updatedAt: string}>>}
     */
    search: function (query, limit) {
      if (!_appMeta || !_appMeta.id) return Promise.reject(new Error('App not ready — call Hivekeep.ready() first'))
      if (!query || typeof query !== 'string') return Promise.reject(new Error('query (string) is required'))
      var n = Math.min(Math.max(1, limit || 20), 50)
      return fetch('/api/mini-apps/' + encodeURIComponent(_appMeta.id) + '/memories/search?q=' + encodeURIComponent(query) + '&limit=' + n)
        .then(function (r) {
          if (!r.ok) return r.json().then(function (d) { throw new Error(d.error?.message || 'Memory search failed') })
          return r.json()
        })
        .then(function (d) { return d.memories || [] })
    },

    /**
     * Store a new memory for the Agent.
     * @param {string} content — memory text (max 2000 chars)
     * @param {{category?: 'fact'|'preference'|'decision'|'knowledge', subject?: string}} [options]
     * @returns {Promise<{id: string, content: string, category: string, subject: string|null, createdAt: string}>}
     */
    store: function (content, options) {
      if (!_appMeta || !_appMeta.id) return Promise.reject(new Error('App not ready — call Hivekeep.ready() first'))
      if (!content || typeof content !== 'string') return Promise.reject(new Error('content (string) is required'))
      var body = { content: content }
      if (options && options.category) body.category = options.category
      if (options && options.subject) body.subject = options.subject
      return fetch('/api/mini-apps/' + encodeURIComponent(_appMeta.id) + '/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(function (r) {
          if (!r.ok) return r.json().then(function (d) { throw new Error(d.error?.message || 'Memory store failed') })
          return r.json()
        })
        .then(function (d) { return d.memory })
    },
  }

  // ─── Conversation ────────────────────────────────────────────────────────

  var conversation = {
    /**
     * Get recent conversation messages for the parent Agent.
     * @param {number} [limit=20] — number of messages to fetch (max 100)
     * @returns {Promise<Array<{id: string, role: string, content: string, createdAt: string, sourceType: string}>>}
     */
    history: function (limit) {
      if (!_appMeta || !_kinInfo || !_kinInfo.id) return Promise.reject(new Error('App not ready — call Hivekeep.ready() first'))
      var n = Math.min(Math.max(1, limit || 20), 100)
      return fetch('/api/agents/' + encodeURIComponent(_kinInfo.id) + '/messages?limit=' + n)
        .then(function (r) {
          if (!r.ok) return r.json().then(function (d) { throw new Error(d.error?.message || 'Failed to fetch history') })
          return r.json()
        })
        .then(function (d) {
          return (d.messages || []).map(function (m) {
            return {
              id: m.id,
              role: m.messageType || m.role,
              content: m.content,
              createdAt: m.createdAt,
              sourceType: m.sourceType,
            }
          })
        })
    },

    /**
     * Send a message to the Agent's conversation.
     * Uses postMessage to the parent (which handles rate limiting and prefixing).
     * @param {string} text — message content (max 2000 chars)
     * @param {object} [options]
     * @param {boolean} [options.silent] — if true, don't show a toast confirmation
     * @returns {Promise<boolean>} — true if sent successfully
     */
    send: function (text, options) {
      return sendMessage(text, options)
    },
  }

  // ─── Share (inter-app data) ──────────────────────────────────────────────

  /**
   * Share data with another mini-app by slug. Data is stored in the sender's storage
   * under a special key and the target app is opened.
   * The target app can read shared data via Hivekeep.on('shared-data', callback).
   * @param {string} targetSlug — slug of the target mini-app
   * @param {any} data — JSON-serializable data to share
   */
  function share(targetSlug, data) {
    if (!_appMeta || !_appMeta.id) return Promise.reject(new Error('App not ready — call Hivekeep.ready() first'))
    try {
      parent.postMessage({
        source: 'hivekeep-sdk',
        type: 'share',
        targetSlug: String(targetSlug),
        shareData: {
          from: _appMeta.slug || _appMeta.id,
          fromName: _appMeta.name || _appMeta.slug || _appMeta.id,
          data: data,
          ts: Date.now(),
        },
      }, '*')
      return Promise.resolve(true)
    } catch (e) {
      return Promise.reject(e)
    }
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  window.Hivekeep = {
    get theme() { return getTheme() },
    get app() { return _appMeta },
    get agent() { return _kinInfo },
    get user() { return _userInfo },
    get isFullPage() { return _isFullPage },
    get locale() { return _locale },
    on: on,
    emit: emit,
    toast: toast,
    navigate: navigate,
    ready: ready,
    fullpage: fullpage,
    storage: storage,
    api: api,
    confirm: confirm,
    prompt: prompt,
    setTitle: setTitle,
    setBadge: setBadge,
    openApp: openApp,
    clipboard: clipboard,
    events: events,
    http: http,
    sendMessage: sendMessage,
    resize: resize,
    notification: notification,
    shortcut: shortcut,
    apps: apps,
    memory: memory,
    conversation: conversation,
    share: share,
    download: download,
    version: '1.17.0',
  }
})()
