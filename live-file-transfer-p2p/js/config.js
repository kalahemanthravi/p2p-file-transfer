/* ═══════════════════════════════════════════════════════════
   FridayTransfer — Configuration & Utilities
   ═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  window.FT = window.FT || {};

  // ─── Supabase Credentials (hardcoded — safe, these are public anon keys) ───
  FT.SUPABASE_URL = 'https://bstklnsxyvckulpcikpq.supabase.co';
  FT.SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJzdGtsbnN4eXZja3VscGNpa3BxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE3MjcyOTMsImV4cCI6MjA4NzMwMzI5M30.d9wUTZS_rppH6-znfDBOQmv67xuFNPNNO1y2jn-Kr70';

  // ─── Constants ───
  FT.CHUNK_SIZE = 256 * 1024; // 256 KB per chunk (bigger = faster, less overhead)
  FT.MAX_BUFFER = 4 * 1024 * 1024; // 4 MB buffer threshold for flow control
  FT.ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
  ];
  FT.HEARTBEAT_INTERVAL = 15000;
  FT.PEER_TIMEOUT = 60000;

  // ─── Utility Functions ───
  FT.Utils = {
    generateId(length = 8) {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let result = '';
      const arr = new Uint8Array(length);
      crypto.getRandomValues(arr);
      for (let i = 0; i < length; i++) {
        result += chars[arr[i] % chars.length];
      }
      return result;
    },

    generatePeerId() {
      return 'peer-' + this.generateId(12);
    },

    formatRoomCode(code) {
      if (code.length === 8) return code.slice(0, 4) + '-' + code.slice(4);
      return code;
    },

    parseRoomCode(input) {
      return input.replace(/[\s\-]/g, '').toUpperCase().slice(0, 8);
    },

    formatSize(bytes) {
      if (bytes === 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.floor(Math.log(bytes) / Math.log(1024));
      return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
    },

    formatSpeed(bytesPerSec) {
      if (bytesPerSec === 0) return '0 B/s';
      return this.formatSize(bytesPerSec) + '/s';
    },

    formatTime(seconds) {
      if (!isFinite(seconds) || seconds < 0) return '--:--';
      if (seconds < 60) return Math.ceil(seconds) + 's';
      if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + Math.floor(seconds % 60) + 's';
      return Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'm';
    },

    getFileIcon(type, name) {
      if (!type) type = '';
      const ext = (name || '').split('.').pop().toLowerCase();
      if (type.startsWith('image/')) return { emoji: '🖼️', cls: 'image' };
      if (type.startsWith('video/')) return { emoji: '🎬', cls: 'video' };
      if (type.startsWith('audio/')) return { emoji: '🎵', cls: 'audio' };
      if (type.includes('pdf') || type.includes('document') || type.includes('word'))
        return { emoji: '📄', cls: 'doc' };
      if (type.includes('zip') || type.includes('rar') || type.includes('tar') || type.includes('7z') ||
        ['zip', 'rar', 'tar', 'gz', '7z', 'bz2'].includes(ext))
        return { emoji: '📦', cls: 'archive' };
      if (['js', 'ts', 'py', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'html', 'css', 'json', 'xml', 'yml', 'yaml', 'md', 'sh', 'bat'].includes(ext))
        return { emoji: '💻', cls: 'code' };
      return { emoji: '📎', cls: 'generic' };
    },

    debounce(fn, delay) {
      let timer;
      return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
      };
    },

    sleep(ms) {
      return new Promise(r => setTimeout(r, ms));
    }
  };

  // ─── Simple Event Emitter ───
  FT.EventEmitter = class {
    constructor() { this._listeners = {}; }
    on(event, fn) {
      (this._listeners[event] = this._listeners[event] || []).push(fn);
      return this;
    }
    off(event, fn) {
      if (!this._listeners[event]) return;
      this._listeners[event] = this._listeners[event].filter(f => f !== fn);
      return this;
    }
    emit(event, ...args) {
      (this._listeners[event] || []).forEach(fn => {
        try { fn(...args); } catch (e) { console.error('Event handler error:', e); }
      });
    }
    once(event, fn) {
      const wrapper = (...args) => { this.off(event, wrapper); fn(...args); };
      return this.on(event, wrapper);
    }
  };

})();
